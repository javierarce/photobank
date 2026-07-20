use rusqlite::params;
use rusqlite::types::Value;
use tauri::State;
use uuid::Uuid;

use crate::db::{self, Db, FolderCount, Photo, SearchFacets, Tag, PHOTO_COLUMNS};
use crate::error::{Error, Result};

#[tauri::command]
pub fn list_folders(db: State<Db>) -> Result<Vec<FolderCount>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT folder, COUNT(*) FROM photos GROUP BY folder ORDER BY folder",
    )?;
    let folders = stmt
        .query_map([], |row| {
            Ok(FolderCount {
                folder: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(folders)
}

#[tauri::command]
pub fn list_photos(db: State<Db>, folder: String) -> Result<Vec<Photo>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(&format!(
        "SELECT {PHOTO_COLUMNS} FROM photos WHERE folder = ?1 ORDER BY created_at DESC",
    ))?;
    let photos = stmt
        .query_map(params![folder], db::photo_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(photos)
}

/// Escape the LIKE metacharacters in `term` so they match literally under
/// `ESCAPE '\'`, without adding surrounding wildcards.
fn like_escape(term: &str) -> String {
    let mut escaped = String::with_capacity(term.len());
    for c in term.chars() {
        if c == '\\' || c == '%' || c == '_' {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

/// A `%term%` substring pattern with the term's wildcards escaped, so a query
/// like "100%" matches literally. Patterns are used with `ESCAPE '\'`.
fn like_pattern(term: &str) -> String {
    format!("%{}%", like_escape(term))
}

/// A subquery selecting the ids of photos carrying a tag whose name matches a
/// single bound `?` pattern (used with `ESCAPE '\'`).
const TAGGED_BY: &str = "SELECT photo_id FROM photo_tags \
    INNER JOIN tags ON tags.id = photo_tags.tag_id \
    WHERE tags.name LIKE ? ESCAPE '\\'";

/// Appended to a date prefix to form an inclusive upper bound: every real
/// ISO-8601 timestamp beginning with `prefix` sorts before `prefix + SENTINEL`
/// (its next characters are ASCII), while the following period sorts after it.
/// `\u{FFFF}` is higher than any byte an ISO timestamp can contain.
const DATE_SENTINEL: char = '\u{FFFF}';

/// One WHERE fragment plus its bind parameters. `sql` is the *positive*
/// predicate: a photo with the relevant column NULL never satisfies it (SQL
/// three-valued logic), so an un-loaded photo isn't a false match. `negated`
/// flips it to `id NOT IN (SELECT ... WHERE sql)`, which keeps exactly the
/// photos the positive predicate didn't select — including NULL-metadata ones.
struct Clause {
    sql: String,
    params: Vec<Value>,
    negated: bool,
}

/// Split a raw query into terms, honoring double quotes so a quoted phrase — or
/// a quoted qualifier value like `tag:"my tag"` — stays a single term. Quotes
/// are stripped; the whitespace they protect is preserved.
fn split_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut started = false;
    for c in query.chars() {
        if c == '"' {
            in_quote = !in_quote;
            started = true;
        } else if c.is_whitespace() && !in_quote {
            if started {
                terms.push(std::mem::take(&mut cur));
                started = false;
            }
        } else {
            cur.push(c);
            started = true;
        }
    }
    if started {
        terms.push(cur);
    }
    terms
}

/// Comparison operators a numeric/date value can carry as a prefix.
#[derive(Clone, Copy)]
enum Cmp {
    Eq,
    Gt,
    Gte,
    Lt,
    Lte,
}

/// Peel a leading comparison operator off a value, defaulting to equality.
fn split_op(value: &str) -> (Cmp, &str) {
    if let Some(rest) = value.strip_prefix(">=") {
        (Cmp::Gte, rest)
    } else if let Some(rest) = value.strip_prefix("<=") {
        (Cmp::Lte, rest)
    } else if let Some(rest) = value.strip_prefix('>') {
        (Cmp::Gt, rest)
    } else if let Some(rest) = value.strip_prefix('<') {
        (Cmp::Lt, rest)
    } else {
        (Cmp::Eq, value)
    }
}

fn like_clause(column: &str, value: &str) -> Clause {
    Clause {
        sql: format!("{column} LIKE ? ESCAPE '\\'"),
        params: vec![Value::Text(like_pattern(value))],
        negated: false,
    }
}

fn camera_clause(value: &str) -> Clause {
    let pat = like_pattern(value);
    Clause {
        sql: "(camera_make LIKE ? ESCAPE '\\' OR camera_model LIKE ? ESCAPE '\\')".into(),
        params: vec![Value::Text(pat.clone()), Value::Text(pat)],
        negated: false,
    }
}

fn tag_clause(value: &str) -> Clause {
    if value.eq_ignore_ascii_case("none") {
        return Clause {
            sql: "id NOT IN (SELECT photo_id FROM photo_tags)".into(),
            params: Vec::new(),
            negated: false,
        };
    }
    Clause {
        sql: format!("id IN ({TAGGED_BY})"),
        params: vec![Value::Text(like_pattern(value))],
        negated: false,
    }
}

/// The legacy broad match: a bare word (or an unrecognized qualifier) hits any
/// of filename, folder, camera make/model, lens, or a tag name.
fn free_text_clause(value: &str) -> Clause {
    let pat = like_pattern(value);
    Clause {
        sql: format!(
            "(filename LIKE ? ESCAPE '\\' OR folder LIKE ? ESCAPE '\\' \
              OR camera_make LIKE ? ESCAPE '\\' OR camera_model LIKE ? ESCAPE '\\' \
              OR lens LIKE ? ESCAPE '\\' OR id IN ({TAGGED_BY}))"
        ),
        params: vec![Value::Text(pat); 6],
        negated: false,
    }
}

/// ISO is a real integer column, so it supports exact match, comparison
/// operators (`iso:>=800`), and ranges (`iso:100-400` or `iso:100..400`).
/// Returns None when the value isn't numeric, so the caller falls back to a
/// free-text match on the whole term.
fn iso_clause(value: &str) -> Option<Clause> {
    let col = "iso";
    let range = value.split_once("..").or_else(|| {
        // "100-400": a dash separating two bare integers.
        value.split_once('-').filter(|(a, b)| {
            !a.is_empty()
                && a.bytes().all(|b| b.is_ascii_digit())
                && !b.is_empty()
                && b.bytes().all(|b| b.is_ascii_digit())
        })
    });
    if let Some((lo, hi)) = range {
        let lo: i64 = lo.trim().parse().ok()?;
        let hi: i64 = hi.trim().parse().ok()?;
        return Some(Clause {
            sql: format!("{col} BETWEEN ? AND ?"),
            params: vec![Value::Integer(lo), Value::Integer(hi)],
            negated: false,
        });
    }
    let (op, rest) = split_op(value);
    let n: i64 = rest.trim().parse().ok()?;
    let cmp = match op {
        Cmp::Eq => "=",
        Cmp::Gt => ">",
        Cmp::Gte => ">=",
        Cmp::Lt => "<",
        Cmp::Lte => "<=",
    };
    Some(Clause {
        sql: format!("{col} {cmp} ?"),
        params: vec![Value::Integer(n)],
        negated: false,
    })
}

/// A date prefix is digits and dashes starting with a digit (`2024`,
/// `2024-06`, `2024-06-15`). Anything else is rejected so the term falls back
/// to a free-text match.
fn valid_date_prefix(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() || !s.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    if !s.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return None;
    }
    Some(s.to_string())
}

/// `taken_at` is an ISO-8601 string, so date filtering is lexicographic on a
/// prefix. Bare `date:2024` matches the whole year; operators and `A..B`
/// ranges bound the period inclusively via [`DATE_SENTINEL`].
fn date_clause(value: &str) -> Option<Clause> {
    let col = "taken_at";
    if let Some((lo, hi)) = value.split_once("..") {
        let lo = valid_date_prefix(lo)?;
        let hi = valid_date_prefix(hi)?;
        return Some(Clause {
            sql: format!("({col} >= ? AND {col} <= ?)"),
            params: vec![
                Value::Text(lo),
                Value::Text(format!("{hi}{DATE_SENTINEL}")),
            ],
            negated: false,
        });
    }
    let (op, rest) = split_op(value);
    let prefix = valid_date_prefix(rest)?;
    let clause = match op {
        Cmp::Eq => Clause {
            sql: format!("{col} LIKE ? ESCAPE '\\'"),
            params: vec![Value::Text(format!("{}%", like_escape(&prefix)))],
            negated: false,
        },
        Cmp::Gte => Clause {
            sql: format!("{col} >= ?"),
            params: vec![Value::Text(prefix)],
            negated: false,
        },
        Cmp::Gt => Clause {
            sql: format!("{col} > ?"),
            params: vec![Value::Text(format!("{prefix}{DATE_SENTINEL}"))],
            negated: false,
        },
        Cmp::Lte => Clause {
            sql: format!("{col} <= ?"),
            params: vec![Value::Text(format!("{prefix}{DATE_SENTINEL}"))],
            negated: false,
        },
        Cmp::Lt => Clause {
            sql: format!("{col} < ?"),
            params: vec![Value::Text(prefix)],
            negated: false,
        },
    };
    Some(clause)
}

/// Build the clause for a recognized `field:value` qualifier, or None if the
/// field is unknown or the value doesn't parse for that field.
fn typed_clause(field: &str, value: &str) -> Option<Clause> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    match field {
        "tag" => Some(tag_clause(value)),
        "folder" => Some(like_clause("folder", value)),
        "filename" | "name" => Some(like_clause("filename", value)),
        "make" => Some(like_clause("camera_make", value)),
        "model" => Some(like_clause("camera_model", value)),
        "lens" => Some(like_clause("lens", value)),
        "camera" => Some(camera_clause(value)),
        "f" | "aperture" => Some(like_clause("aperture", value)),
        "shutter" | "speed" => Some(like_clause("shutter_speed", value)),
        "focal" => Some(like_clause("focal_length", value)),
        "iso" => iso_clause(value),
        "date" | "year" => date_clause(value),
        _ => None,
    }
}

/// Parse one term into a clause. A leading `-` negates it; a recognized
/// `field:value` becomes a typed filter; everything else is a free-text match.
fn parse_term(term: &str) -> Option<Clause> {
    let (negated, body) = match term.strip_prefix('-') {
        Some(rest) if !rest.is_empty() => (true, rest),
        _ => (false, term),
    };
    if body.is_empty() {
        return None;
    }
    if let Some((field, value)) = body.split_once(':') {
        if let Some(clause) = typed_clause(&field.to_ascii_lowercase(), value) {
            return Some(Clause { negated, ..clause });
        }
    }
    Some(Clause {
        negated,
        ..free_text_clause(body)
    })
}

/// Turn the search inputs into a full SELECT plus its bind parameters, or None
/// when nothing to filter on. `q` is the Ankitron-style query string; `tag` and
/// `camera` are the legacy structured params, honored as extra AND filters.
fn build_query(
    q: Option<&str>,
    tag: Option<&str>,
    camera: Option<&str>,
) -> Option<(String, Vec<Value>)> {
    let mut clauses: Vec<Clause> = Vec::new();

    if let Some(q) = q {
        for term in split_terms(q) {
            if let Some(clause) = parse_term(&term) {
                clauses.push(clause);
            }
        }
    }
    if let Some(tag) = tag.map(str::trim).filter(|s| !s.is_empty()) {
        clauses.push(tag_clause(tag));
    }
    if let Some(camera) = camera.map(str::trim).filter(|s| !s.is_empty()) {
        clauses.push(camera_clause(camera));
    }

    if clauses.is_empty() {
        return None;
    }

    let mut conditions: Vec<String> = Vec::new();
    let mut params_list: Vec<Value> = Vec::new();
    for clause in clauses {
        conditions.push(if clause.negated {
            // Keep every photo the positive predicate didn't select — so a
            // negated metadata filter (e.g. `-camera:fuji`) also keeps photos
            // whose metadata is NULL, which a bare `NOT (...)` would drop.
            format!("id NOT IN (SELECT id FROM photos WHERE {})", clause.sql)
        } else {
            clause.sql
        });
        params_list.extend(clause.params);
    }

    let sql = format!(
        "SELECT {PHOTO_COLUMNS} FROM photos WHERE {} ORDER BY created_at DESC LIMIT 200",
        conditions.join(" AND ")
    );
    Some((sql, params_list))
}

#[tauri::command]
pub fn search_photos(
    db: State<Db>,
    q: Option<String>,
    tag: Option<String>,
    camera: Option<String>,
) -> Result<Vec<Photo>> {
    let Some((sql, params_list)) =
        build_query(q.as_deref(), tag.as_deref(), camera.as_deref())
    else {
        return Ok(Vec::new());
    };

    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(&sql)?;
    let photos = stmt
        .query_map(rusqlite::params_from_iter(params_list), db::photo_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(photos)
}

/// Gather the distinct, non-empty values of a hardcoded metadata column. The
/// column name is never user-supplied, so interpolating it is safe.
fn distinct_column(conn: &rusqlite::Connection, column: &str) -> rusqlite::Result<Vec<String>> {
    let sql = format!(
        "SELECT DISTINCT {column} FROM photos \
         WHERE {column} IS NOT NULL AND {column} != '' ORDER BY {column} COLLATE NOCASE"
    );
    let mut stmt = conn.prepare(&sql)?;
    let values = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(values)
}

fn search_facets(conn: &rusqlite::Connection) -> rusqlite::Result<SearchFacets> {
    Ok(SearchFacets {
        makes: distinct_column(conn, "camera_make")?,
        models: distinct_column(conn, "camera_model")?,
        lenses: distinct_column(conn, "lens")?,
    })
}

#[tauri::command]
pub fn list_search_facets(db: State<Db>) -> Result<SearchFacets> {
    let conn = db.0.lock().unwrap();
    Ok(search_facets(&conn)?)
}

#[tauri::command]
pub fn list_tags(db: State<Db>) -> Result<Vec<Tag>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id, name FROM tags ORDER BY name")?;
    let tags = stmt
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(tags)
}

#[tauri::command]
pub fn get_photo_tags(db: State<Db>, photo_id: String) -> Result<Vec<Tag>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT tags.id, tags.name FROM photo_tags \
         INNER JOIN tags ON tags.id = photo_tags.tag_id \
         WHERE photo_tags.photo_id = ?1 ORDER BY tags.name",
    )?;
    let tags = stmt
        .query_map(params![photo_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(tags)
}

/// Add a tag to a photo, creating the tag if it doesn't exist (mirrors the
/// old upsertTag + onConflictDoNothing pair).
#[tauri::command]
pub fn add_photo_tag(
    app: tauri::AppHandle,
    db: State<Db>,
    photo_id: String,
    name: String,
) -> Result<Tag> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(Error::msg("name is required"));
    }

    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?1, ?2, ?3)",
        params![Uuid::new_v4().to_string(), name, db::now()],
    )?;
    let tag = conn.query_row(
        "SELECT id, name FROM tags WHERE name = ?1",
        params![name],
        |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        },
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?1, ?2)",
        params![photo_id, tag.id],
    )?;
    drop(conn);
    crate::manifest::schedule_upload(&app);
    Ok(tag)
}

#[tauri::command]
pub fn remove_photo_tag(
    app: tauri::AppHandle,
    db: State<Db>,
    photo_id: String,
    tag_id: String,
) -> Result<()> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "DELETE FROM photo_tags WHERE photo_id = ?1 AND tag_id = ?2",
        params![photo_id, tag_id],
    )?;
    drop(conn);
    crate::manifest::schedule_upload(&app);
    Ok(())
}

#[tauri::command]
pub async fn update_photo(
    app: tauri::AppHandle,
    id: String,
    folder: Option<String>,
    filename: Option<String>,
) -> Result<Photo> {
    crate::photos::update_photo(app, id, folder, filename).await
}

/// Rename a folder, re-keying every photo in it. Resolves with the number of
/// photos moved.
#[tauri::command]
pub async fn rename_folder(
    app: tauri::AppHandle,
    old_name: String,
    new_name: String,
) -> Result<usize> {
    crate::photos::rename_folder(app, old_name, new_name).await
}

#[tauri::command]
pub async fn delete_photo(app: tauri::AppHandle, id: String) -> Result<()> {
    crate::photos::delete_photo(app, id).await
}

#[tauri::command]
pub async fn import_photos(
    app: tauri::AppHandle,
    paths: Vec<String>,
    folder: String,
) -> Result<Vec<Photo>> {
    crate::import::import_photos(app, paths, folder).await
}

/// Signal an in-flight or queued import to cancel, keyed by its
/// "folder/filename" key. A plain no-op if no matching import is currently
/// registered (e.g. it already finished, or the cancel raced ahead of it).
#[tauri::command]
pub fn cancel_import(
    registry: State<crate::import::CancelRegistry>,
    key: String,
) -> Result<()> {
    registry.cancel(&key);
    Ok(())
}

#[tauri::command]
pub async fn export_photos(
    app: tauri::AppHandle,
    photo_ids: Vec<String>,
    resolution: String,
) -> Result<Option<String>> {
    crate::photos::export_photos(app, photo_ids, resolution).await
}

#[cfg(test)]
mod tests {
    use super::{build_query, like_pattern, split_terms};
    use crate::db::{open_in_memory, now, PHOTO_COLUMNS};
    use rusqlite::{params, Connection};

    #[test]
    fn like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("100%"), "%100\\%%");
        assert_eq!(like_pattern("a_b"), "%a\\_b%");
        assert_eq!(like_pattern("back\\slash"), "%back\\\\slash%");
        assert_eq!(like_pattern("plain"), "%plain%");
    }

    #[test]
    fn split_terms_honors_quotes_and_negation() {
        assert_eq!(split_terms("a b"), vec!["a", "b"]);
        assert_eq!(split_terms(r#"tag:"my tag" -foo"#), vec!["tag:my tag", "-foo"]);
        assert_eq!(split_terms("   spaced   out  "), vec!["spaced", "out"]);
        assert!(split_terms("   ").is_empty());
    }

    /// Insert a photo, letting each caller pin only the columns it cares about.
    #[allow(clippy::too_many_arguments)]
    fn insert(
        conn: &Connection,
        id: &str,
        filename: &str,
        folder: &str,
        make: Option<&str>,
        model: Option<&str>,
        lens: Option<&str>,
        aperture: Option<&str>,
        iso: Option<i64>,
        taken_at: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO photos
             (id, filename, s3_key, folder, camera_make, camera_model, lens, aperture, iso, taken_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
            params![
                id,
                filename,
                format!("{folder}/{filename}"),
                folder,
                make,
                model,
                lens,
                aperture,
                iso,
                taken_at,
                now(),
            ],
        )
        .unwrap();
    }

    fn tag(conn: &Connection, photo_id: &str, name: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?1, ?2, ?3)",
            params![format!("tag-{name}"), name, now()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO photo_tags (photo_id, tag_id) VALUES (?1, ?2)",
            params![photo_id, format!("tag-{name}")],
        )
        .unwrap();
    }

    /// Run the built query and return the matching ids, sorted so assertions
    /// don't depend on the (tie-broken) result order.
    fn search(conn: &Connection, q: &str) -> Vec<String> {
        let Some((sql, bind)) = build_query(Some(q), None, None) else {
            return Vec::new();
        };
        // Guard against columns drifting out of sync with photo_from_row.
        assert!(sql.contains(PHOTO_COLUMNS));
        let mut stmt = conn.prepare(&sql).unwrap();
        let mut ids = stmt
            .query_map(rusqlite::params_from_iter(bind), |row| {
                row.get::<_, String>(0)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        ids.sort();
        ids
    }

    fn fixture() -> Connection {
        let conn = open_in_memory();
        // 1: Fuji, ISO 400, f/2.8, June 2024
        insert(&conn, "1", "beach.jpg", "trips", Some("FUJIFILM"), Some("X100V"), Some("23mm"), Some("f/2.8"), Some(400), Some("2024-06-15T10:00:00Z"));
        // 2: Canon, ISO 1600, f/1.8, Jan 2023
        insert(&conn, "2", "night.jpg", "trips", Some("Canon"), Some("EOS R5"), Some("50mm"), Some("f/1.8"), Some(1600), Some("2023-01-20T22:00:00Z"));
        // 3: no EXIF at all (metadata not loaded), in "inbox"
        insert(&conn, "3", "mystery.png", "inbox", None, None, None, None, None, None);
        tag(&conn, "1", "sunset");
        tag(&conn, "2", "night");
        conn
    }

    #[test]
    fn empty_query_matches_nothing() {
        assert!(build_query(Some("   "), None, None).is_none());
        assert!(build_query(None, None, None).is_none());
    }

    #[test]
    fn free_text_matches_name_folder_camera_and_tags() {
        let conn = fixture();
        assert_eq!(search(&conn, "beach"), vec!["1"]); // filename
        assert_eq!(search(&conn, "inbox"), vec!["3"]); // folder
        assert_eq!(search(&conn, "canon"), vec!["2"]); // camera make
        assert_eq!(search(&conn, "sunset"), vec!["1"]); // tag name
    }

    #[test]
    fn camera_make_and_model_qualifiers() {
        let conn = fixture();
        assert_eq!(search(&conn, "camera:fuji"), vec!["1"]);
        assert_eq!(search(&conn, "model:r5"), vec!["2"]);
        assert_eq!(search(&conn, "make:canon"), vec!["2"]);
        assert_eq!(search(&conn, "lens:50mm"), vec!["2"]);
    }

    #[test]
    fn iso_exact_operators_and_ranges() {
        let conn = fixture();
        assert_eq!(search(&conn, "iso:400"), vec!["1"]);
        assert_eq!(search(&conn, "iso:>=800"), vec!["2"]);
        assert_eq!(search(&conn, "iso:<1000"), vec!["1"]);
        assert_eq!(search(&conn, "iso:400-1600"), vec!["1", "2"]);
        assert_eq!(search(&conn, "iso:400..1600"), vec!["1", "2"]);
        // Non-numeric ISO falls back to free text and matches nothing here.
        assert!(search(&conn, "iso:high").is_empty());
    }

    #[test]
    fn aperture_and_shutter_match_display_strings() {
        let conn = fixture();
        assert_eq!(search(&conn, "f:1.8"), vec!["2"]);
        assert_eq!(search(&conn, "aperture:2.8"), vec!["1"]);
    }

    #[test]
    fn date_prefix_operators_and_ranges() {
        let conn = fixture();
        assert_eq!(search(&conn, "date:2024"), vec!["1"]);
        assert_eq!(search(&conn, "date:2024-06"), vec!["1"]);
        assert_eq!(search(&conn, "year:2023"), vec!["2"]);
        assert_eq!(search(&conn, "date:>=2024"), vec!["1"]);
        assert_eq!(search(&conn, "date:<2024"), vec!["2"]);
        assert_eq!(search(&conn, "date:2023..2024"), vec!["1", "2"]);
    }

    #[test]
    fn tag_qualifier_and_tag_none() {
        let conn = fixture();
        assert_eq!(search(&conn, "tag:sunset"), vec!["1"]);
        // Photo 3 carries no tags.
        assert_eq!(search(&conn, "tag:none"), vec!["3"]);
    }

    #[test]
    fn negation_excludes_matches_but_keeps_unknown_metadata() {
        let conn = fixture();
        // Not Fuji: the Canon and the metadata-less photo both qualify.
        assert_eq!(search(&conn, "-camera:fuji"), vec!["2", "3"]);
        // Not ISO 400: the null-ISO photo is kept, only photo 1 drops out.
        assert_eq!(search(&conn, "-iso:400"), vec!["2", "3"]);
        assert_eq!(search(&conn, "-tag:sunset"), vec!["2", "3"]);
    }

    #[test]
    fn multiple_terms_are_anded() {
        let conn = fixture();
        assert_eq!(search(&conn, "folder:trips iso:>=800"), vec!["2"]);
        assert!(search(&conn, "camera:fuji iso:1600").is_empty());
    }

    #[test]
    fn search_facets_lists_distinct_nonempty_values() {
        use super::search_facets;
        let conn = open_in_memory();
        insert(&conn, "1", "a.jpg", "f", Some("FUJIFILM"), Some("X100V"), Some("23mm"), None, None, None);
        insert(&conn, "2", "b.jpg", "f", Some("Canon"), Some("EOS R5"), Some("50mm"), None, None, None);
        // Duplicate make + a photo with no camera metadata at all.
        insert(&conn, "3", "c.jpg", "f", Some("FUJIFILM"), Some("X-T5"), None, None, None, None);
        insert(&conn, "4", "d.jpg", "f", None, None, None, None, None, None);

        let facets = search_facets(&conn).unwrap();
        assert_eq!(facets.makes, vec!["Canon", "FUJIFILM"]);
        assert_eq!(facets.models, vec!["EOS R5", "X-T5", "X100V"]);
        assert_eq!(facets.lenses, vec!["23mm", "50mm"]);
    }

    #[test]
    fn quoted_values_and_unknown_qualifiers() {
        let conn = open_in_memory();
        insert(&conn, "a", "a.jpg", "my trips", Some("Leica M"), None, None, None, None, None);
        assert_eq!(search(&conn, r#"folder:"my trips""#), vec!["a"]);
        assert_eq!(search(&conn, r#"make:"leica m""#), vec!["a"]);
        // Unknown qualifier degrades to a free-text match on the whole term.
        assert!(search(&conn, "bogus:xyz").is_empty());
    }
}
