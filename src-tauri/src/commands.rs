use std::collections::HashMap;

use rusqlite::params;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension};
use tauri::State;
use uuid::Uuid;

use crate::db::{
    self, Collection, CollectionCount, Db, FolderCount, FolderFacets, Photo, SearchFacets, Tag,
    TagCount, PHOTO_COLUMNS,
};
use crate::error::{Error, Result};

#[tauri::command]
pub fn list_folders(db: State<Db>) -> Result<Vec<FolderCount>> {
    let conn = db.0.lock().unwrap();
    folder_counts(&conn)
}

/// Every folder with its photo count, cover and recency. The rows come back in
/// name order; the home page re-sorts them client-side (see lib/folder-sort.ts),
/// so `last_added_at` — when the folder's newest photo entered the catalog —
/// travels with each row for the "Recently updated" order.
fn folder_counts(conn: &Connection) -> Result<Vec<FolderCount>> {
    let mut stmt = conn.prepare(
        "SELECT folder, COUNT(*), MAX(created_at) FROM photos GROUP BY folder ORDER BY folder",
    )?;
    let mut folders = stmt
        .query_map([], |row| {
            Ok(FolderCount {
                folder: row.get(0)?,
                count: row.get(1)?,
                cover_key: None,
                cover_version: None,
                last_added_at: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for folder in &mut folders {
        if let Some((key, version)) = folder_cover(conn, &folder.folder)? {
            folder.cover_key = Some(key);
            folder.cover_version = Some(version);
        }
    }
    Ok(folders)
}

/// The (key, version) of the photo representing `folder` on the home page.
/// The user's pick wins as long as it still holds — a cover that was moved
/// out of the folder, or hasn't finished importing, falls through.
///
/// The automatic fallback is the folder's newest photo THAT HAS VARIANTS, so
/// merely opening the home page can never pull a full original down to fill a
/// tile: a folder whose photos are still awaiting a refresh (originals synced
/// in from elsewhere) shows the placeholder until those thumbnails exist. An
/// explicit pick is honoured either way — that one the user asked for.
fn folder_cover(conn: &Connection, folder: &str) -> Result<Option<(String, String)>> {
    let chosen = conn
        .query_row(
            "SELECT p.s3_key, p.updated_at FROM folder_covers c
             JOIN photos p ON p.id = c.photo_id
             WHERE c.folder = ?1 AND p.folder = ?1 AND p.processing_status = 'completed'",
            params![folder],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if chosen.is_some() {
        return Ok(chosen);
    }
    Ok(conn
        .query_row(
            "SELECT s3_key, updated_at FROM photos
             WHERE folder = ?1 AND processing_status = 'completed' AND variants_ok = 1
             ORDER BY created_at DESC
             LIMIT 1",
            params![folder],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

/// The photo id the user picked as `folder`'s cover, or None when they never
/// picked one (or the pick no longer holds — see [`folder_cover`]). Drives the
/// lightbox's set/remove toggle.
fn chosen_cover_id(conn: &Connection, folder: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT c.photo_id FROM folder_covers c
             JOIN photos p ON p.id = c.photo_id
             WHERE c.folder = ?1 AND p.folder = ?1",
            params![folder],
            |row| row.get(0),
        )
        .optional()?)
}

/// Pick `photo_id` as the thumbnail `folder` shows on the home page.
fn set_cover(conn: &Connection, folder: &str, photo_id: &str) -> Result<()> {
    let belongs: i64 = conn.query_row(
        "SELECT COUNT(*) FROM photos WHERE id = ?1 AND folder = ?2",
        params![photo_id, folder],
        |row| row.get(0),
    )?;
    if belongs == 0 {
        return Err(Error::msg("That photo is not in this folder"));
    }
    conn.execute(
        "INSERT INTO folder_covers (folder, photo_id, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (folder) DO UPDATE
            SET photo_id = excluded.photo_id, updated_at = excluded.updated_at",
        params![folder, photo_id, db::now()],
    )?;
    Ok(())
}

#[tauri::command]
pub fn get_folder_cover(db: State<Db>, folder: String) -> Result<Option<String>> {
    let conn = db.0.lock().unwrap();
    chosen_cover_id(&conn, &folder)
}

/// Set the folder's cover photo. Rejects a photo from another folder, so the
/// pick can't outlive a move it never saw.
#[tauri::command]
pub fn set_folder_cover(
    app: tauri::AppHandle,
    db: State<Db>,
    folder: String,
    photo_id: String,
) -> Result<()> {
    {
        let conn = db.0.lock().unwrap();
        set_cover(&conn, &folder, &photo_id)?;
    }
    crate::manifest::schedule_upload(&app);
    Ok(())
}

/// Drop the folder's cover pick; it falls back to its newest photo.
#[tauri::command]
pub fn clear_folder_cover(app: tauri::AppHandle, db: State<Db>, folder: String) -> Result<()> {
    {
        let conn = db.0.lock().unwrap();
        conn.execute("DELETE FROM folder_covers WHERE folder = ?1", params![folder])?;
    }
    crate::manifest::schedule_upload(&app);
    Ok(())
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

/// Build just the WHERE body (no SELECT, no ORDER BY, no LIMIT) plus its bind
/// parameters, or None when there is nothing to filter on. `q` is the
/// Ankitron-style query string; `tag` and `camera` are the legacy structured
/// params, honored as extra AND filters. `folder`, when set, scopes the whole
/// search to one folder (the in-folder search field) — a query with only a
/// `folder` scope still matches nothing, so scoping never turns an empty query
/// into a full-folder listing.
fn build_conditions(
    q: Option<&str>,
    tag: Option<&str>,
    camera: Option<&str>,
    folder: Option<&str>,
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

    // No actual predicate means nothing to search — a bare folder scope must not
    // list the whole folder, so bail before adding it.
    if clauses.is_empty() {
        return None;
    }

    if let Some(folder) = folder.map(str::trim).filter(|s| !s.is_empty()) {
        clauses.push(Clause {
            sql: "folder = ?".to_string(),
            params: vec![Value::Text(folder.to_string())],
            negated: false,
        });
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

    Some((conditions.join(" AND "), params_list))
}

/// The results-page query: full rows, newest first, capped — this backs a
/// scrollable list of results, where showing the newest 200 is a reasonable
/// bound. Use [`build_id_query`] for filtering an already-loaded set, where a
/// cap would silently subtract matches.
fn build_query(
    q: Option<&str>,
    tag: Option<&str>,
    camera: Option<&str>,
    folder: Option<&str>,
) -> Option<(String, Vec<Value>)> {
    let (where_sql, params) = build_conditions(q, tag, camera, folder)?;
    let sql = format!(
        "SELECT {PHOTO_COLUMNS} FROM photos WHERE {where_sql} \
         ORDER BY created_at DESC LIMIT 200"
    );
    Some((sql, params))
}

/// The in-folder filter query: matching ids only, UNCAPPED. The caller already
/// holds every row in the folder and uses these ids to hide the non-matching
/// tiles, so a `LIMIT` here would silently hide photos that do match (and would
/// narrow "Select all" and the bulk actions built on it). Ids are all the caller
/// needs, so this also avoids shipping full rows over IPC per keystroke.
fn build_id_query(q: &str, folder: &str) -> Option<(String, Vec<Value>)> {
    let (where_sql, params) = build_conditions(Some(q), None, None, Some(folder))?;
    Some((format!("SELECT id FROM photos WHERE {where_sql}"), params))
}

#[tauri::command]
pub fn search_photos(
    db: State<Db>,
    q: Option<String>,
    tag: Option<String>,
    camera: Option<String>,
    folder: Option<String>,
) -> Result<Vec<Photo>> {
    let Some((sql, params_list)) = build_query(
        q.as_deref(),
        tag.as_deref(),
        camera.as_deref(),
        folder.as_deref(),
    ) else {
        return Ok(Vec::new());
    };

    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(&sql)?;
    let photos = stmt
        .query_map(rusqlite::params_from_iter(params_list), db::photo_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(photos)
}

/// Ids of the photos in `folder` matching `q` — the in-folder search field's
/// filter. Uncapped and ids-only; see [`build_id_query`].
#[tauri::command]
pub fn search_photo_ids(db: State<Db>, q: String, folder: String) -> Result<Vec<String>> {
    let Some((sql, params_list)) = build_id_query(&q, &folder) else {
        return Ok(Vec::new());
    };

    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(&sql)?;
    let ids = stmt
        .query_map(rusqlite::params_from_iter(params_list), |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
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

/// Distinct, non-empty values of a metadata column within one folder. The
/// column name is hardcoded (never user-supplied), so interpolating it is safe;
/// the folder is bound.
fn distinct_column_in_folder(
    conn: &rusqlite::Connection,
    column: &str,
    folder: &str,
) -> rusqlite::Result<Vec<String>> {
    let sql = format!(
        "SELECT DISTINCT {column} FROM photos \
         WHERE folder = ?1 AND {column} IS NOT NULL AND {column} != '' \
         ORDER BY {column} COLLATE NOCASE"
    );
    let mut stmt = conn.prepare(&sql)?;
    let values = stmt
        .query_map(params![folder], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(values)
}

/// Distinct tag names carried by the photos in one folder.
fn folder_tags(conn: &rusqlite::Connection, folder: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT tags.name FROM tags \
         INNER JOIN photo_tags ON photo_tags.tag_id = tags.id \
         INNER JOIN photos ON photos.id = photo_tags.photo_id \
         WHERE photos.folder = ?1 ORDER BY tags.name COLLATE NOCASE",
    )?;
    let names = stmt
        .query_map(params![folder], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}

fn folder_facets(conn: &rusqlite::Connection, folder: &str) -> rusqlite::Result<FolderFacets> {
    Ok(FolderFacets {
        tags: folder_tags(conn, folder)?,
        makes: distinct_column_in_folder(conn, "camera_make", folder)?,
        models: distinct_column_in_folder(conn, "camera_model", folder)?,
        lenses: distinct_column_in_folder(conn, "lens", folder)?,
    })
}

#[tauri::command]
pub fn list_folder_facets(db: State<Db>, folder: String) -> Result<FolderFacets> {
    let conn = db.0.lock().unwrap();
    Ok(folder_facets(&conn, &folder)?)
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

// --- Bulk (multi-photo) tagging ---------------------------------------------
//
// The Ankitron-style bulk tag editor works on many photos at once: it needs
// each selected photo's current tags to build the "X of N" usage checklist,
// then applies a mix of add/remove operations across the whole selection.

/// The current tags of each of `photo_ids`, keyed by photo id. Photos with no
/// tags are still present with an empty list, so the caller can rely on every
/// requested id being a key.
fn tags_for_photos(
    conn: &Connection,
    photo_ids: &[String],
) -> rusqlite::Result<HashMap<String, Vec<Tag>>> {
    let mut stmt = conn.prepare(
        "SELECT tags.id, tags.name FROM photo_tags \
         INNER JOIN tags ON tags.id = photo_tags.tag_id \
         WHERE photo_tags.photo_id = ?1 ORDER BY tags.name",
    )?;
    let mut map = HashMap::with_capacity(photo_ids.len());
    for id in photo_ids {
        let tags = stmt
            .query_map(params![id], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        map.insert(id.clone(), tags);
    }
    Ok(map)
}

/// Add each named tag (creating it if new) to every listed photo. Blank names
/// are skipped; an INSERT OR IGNORE makes re-tagging a photo that already has
/// the tag a no-op, so callers don't need to pre-filter.
fn add_tags(conn: &Connection, photo_ids: &[String], names: &[String]) -> rusqlite::Result<()> {
    for name in names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?1, ?2, ?3)",
            params![Uuid::new_v4().to_string(), name, db::now()],
        )?;
        let tag_id: String =
            conn.query_row("SELECT id FROM tags WHERE name = ?1", params![name], |row| {
                row.get(0)
            })?;
        for photo_id in photo_ids {
            conn.execute(
                "INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?1, ?2)",
                params![photo_id, tag_id],
            )?;
        }
    }
    Ok(())
}

/// Strip each named tag from every listed photo. A name that isn't a known tag,
/// or a photo that doesn't carry it, is silently skipped. The tag row itself is
/// left in place even if it ends up on no photos (matching single-photo remove).
fn remove_tags(conn: &Connection, photo_ids: &[String], names: &[String]) -> rusqlite::Result<()> {
    for name in names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let tag_id: Option<String> = conn
            .query_row("SELECT id FROM tags WHERE name = ?1", params![name], |row| {
                row.get(0)
            })
            .optional()?;
        let Some(tag_id) = tag_id else { continue };
        for photo_id in photo_ids {
            conn.execute(
                "DELETE FROM photo_tags WHERE photo_id = ?1 AND tag_id = ?2",
                params![photo_id, tag_id],
            )?;
        }
    }
    Ok(())
}

/// The tags currently on each of the given photos — the source for the bulk
/// editor's usage checklist. Keyed by photo id.
#[tauri::command]
pub fn get_tags_for_photos(
    db: State<Db>,
    photo_ids: Vec<String>,
) -> Result<HashMap<String, Vec<Tag>>> {
    let conn = db.0.lock().unwrap();
    Ok(tags_for_photos(&conn, &photo_ids)?)
}

/// Add every named tag to every listed photo in one shot (creating tags as
/// needed). No-op when either list is empty.
#[tauri::command]
pub fn add_tags_to_photos(
    app: tauri::AppHandle,
    db: State<Db>,
    photo_ids: Vec<String>,
    names: Vec<String>,
) -> Result<()> {
    if photo_ids.is_empty() || names.is_empty() {
        return Ok(());
    }
    {
        let conn = db.0.lock().unwrap();
        add_tags(&conn, &photo_ids, &names)?;
    }
    crate::manifest::schedule_upload(&app);
    Ok(())
}

/// Remove every named tag from every listed photo in one shot. No-op when
/// either list is empty.
#[tauri::command]
pub fn remove_tags_from_photos(
    app: tauri::AppHandle,
    db: State<Db>,
    photo_ids: Vec<String>,
    names: Vec<String>,
) -> Result<()> {
    if photo_ids.is_empty() || names.is_empty() {
        return Ok(());
    }
    {
        let conn = db.0.lock().unwrap();
        remove_tags(&conn, &photo_ids, &names)?;
    }
    crate::manifest::schedule_upload(&app);
    Ok(())
}

// --- Tag management (the Tags page) -----------------------------------------

/// Every tag with a count of the photos that carry it, name-sorted. Tags with
/// no photos are included (count 0), so a tag left empty by an edit still shows.
fn tag_counts(conn: &Connection) -> rusqlite::Result<Vec<TagCount>> {
    let mut stmt = conn.prepare(
        "SELECT tags.id, tags.name, COUNT(photo_tags.photo_id) \
         FROM tags LEFT JOIN photo_tags ON photo_tags.tag_id = tags.id \
         GROUP BY tags.id, tags.name ORDER BY tags.name",
    )?;
    let counts = stmt
        .query_map([], |row| {
            Ok(TagCount {
                id: row.get(0)?,
                name: row.get(1)?,
                count: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(counts)
}

/// Rename a tag. If another tag already has the target name, the two are merged:
/// this tag's photo links move onto that one (deduped) and this tag row is
/// deleted, so names stay unique. Returns the surviving tag.
fn rename_tag_inner(conn: &Connection, id: &str, name: &str) -> rusqlite::Result<Tag> {
    let existing: Option<String> = conn
        .query_row("SELECT id FROM tags WHERE name = ?1", params![name], |row| {
            row.get(0)
        })
        .optional()?;
    match existing {
        // A different tag owns the name: merge this one into it.
        Some(target) if target != id => {
            conn.execute(
                "INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) \
                 SELECT photo_id, ?1 FROM photo_tags WHERE tag_id = ?2",
                params![target, id],
            )?;
            conn.execute("DELETE FROM tags WHERE id = ?1", params![id])?;
            conn.query_row(
                "SELECT id, name FROM tags WHERE id = ?1",
                params![target],
                |row| {
                    Ok(Tag {
                        id: row.get(0)?,
                        name: row.get(1)?,
                    })
                },
            )
        }
        // Name is free (or already this tag's): a plain rename.
        _ => {
            conn.execute(
                "UPDATE tags SET name = ?1 WHERE id = ?2",
                params![name, id],
            )?;
            conn.query_row("SELECT id, name FROM tags WHERE id = ?1", params![id], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                })
            })
        }
    }
}

/// Every tag with its photo count — the source for the Tags page.
#[tauri::command]
pub fn list_tag_counts(db: State<Db>) -> Result<Vec<TagCount>> {
    let conn = db.0.lock().unwrap();
    Ok(tag_counts(&conn)?)
}

/// Rename a tag, merging into an existing tag of the same name if there is one.
/// Resolves with the surviving tag.
#[tauri::command]
pub fn rename_tag(
    app: tauri::AppHandle,
    db: State<Db>,
    id: String,
    name: String,
) -> Result<Tag> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(Error::msg("name is required"));
    }
    let tag = {
        let conn = db.0.lock().unwrap();
        rename_tag_inner(&conn, &id, &name).map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Error::msg("Tag not found"),
            other => Error::from(other),
        })?
    };
    crate::manifest::schedule_upload(&app);
    Ok(tag)
}

/// Delete a tag everywhere. Its photo links cascade away; the photos stay.
#[tauri::command]
pub fn delete_tag(app: tauri::AppHandle, db: State<Db>, id: String) -> Result<()> {
    {
        let conn = db.0.lock().unwrap();
        conn.execute("DELETE FROM tags WHERE id = ?1", params![id])?;
    }
    crate::manifest::schedule_upload(&app);
    Ok(())
}

// --- Collections ------------------------------------------------------------
//
// A collection is a title over some of a folder's photos. It owns no objects
// in the bucket — the photos keep their keys and their folder — so every
// operation here is catalog-only, and dissolving a collection is lossless.
// Membership is exclusive (see the `collection_photos` primary key), which is
// what lets a collection hold its photos out of the folder's own grid.

/// The stored form of a collection title: trimmed, with internal whitespace
/// runs folded, so "Day  one " and "Day one" can't sit side by side looking
/// identical. Rejects a title that's empty once trimmed.
fn normalize_title(title: &str) -> Result<String> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err(Error::msg("A collection needs a title"));
    }
    Ok(title)
}

/// The photo ids in one collection, newest first (matching `list_photos`).
/// Photos are matched against the collection's own folder, so a membership
/// that outlived a move — a rebuild can restore one, having taken the photo's
/// folder from the bucket and the collection's from the manifest — doesn't
/// show a foreign photo inside the collection.
fn collection_photo_ids(conn: &Connection, collection_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT photos.id FROM collection_photos
         INNER JOIN photos ON photos.id = collection_photos.photo_id
         INNER JOIN collections ON collections.id = collection_photos.collection_id
         WHERE collection_photos.collection_id = ?1 AND photos.folder = collections.folder
         ORDER BY photos.created_at DESC",
    )?;
    let ids = stmt
        .query_map(params![collection_id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

fn get_collection(conn: &Connection, id: &str) -> Result<Collection> {
    let mut collection = conn
        .query_row(
            "SELECT id, folder, title, created_at, updated_at FROM collections WHERE id = ?1",
            params![id],
            |row| {
                Ok(Collection {
                    id: row.get(0)?,
                    folder: row.get(1)?,
                    title: row.get(2)?,
                    photo_ids: Vec::new(),
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| Error::msg("That collection no longer exists"))?;
    collection.photo_ids = collection_photo_ids(conn, id)?;
    Ok(collection)
}

/// Every collection in a folder, newest first — the order the grid lays the
/// cards out in, so one you just made is where you left it.
fn collections_in_folder(conn: &Connection, folder: &str) -> Result<Vec<Collection>> {
    let mut stmt = conn.prepare(
        "SELECT id, folder, title, created_at, updated_at FROM collections
         WHERE folder = ?1 ORDER BY created_at DESC, id",
    )?;
    let mut collections = stmt
        .query_map(params![folder], |row| {
            Ok(Collection {
                id: row.get(0)?,
                folder: row.get(1)?,
                title: row.get(2)?,
                photo_ids: Vec::new(),
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for collection in &mut collections {
        collection.photo_ids = collection_photo_ids(conn, &collection.id)?;
    }
    Ok(collections)
}

/// Refuse photos that aren't in `folder`. A collection groups a folder's own
/// photos, so a stale selection (the photo was moved in another window) must
/// not smuggle a foreign photo into the collection.
fn ensure_photos_in_folder(conn: &Connection, folder: &str, photo_ids: &[String]) -> Result<()> {
    for id in photo_ids {
        let owner: Option<String> = conn
            .query_row("SELECT folder FROM photos WHERE id = ?1", params![id], |row| {
                row.get(0)
            })
            .optional()?;
        match owner {
            Some(owner) if owner == folder => {}
            Some(_) => {
                return Err(Error::msg(
                    "Some of those photos are no longer in this folder",
                ))
            }
            None => return Err(Error::msg("Some of those photos no longer exist")),
        }
    }
    Ok(())
}

/// Put `photo_ids` in the collection, taking them out of whatever collection
/// they were in — membership is exclusive, so the upsert is the whole move.
fn assign_photos(conn: &Connection, collection_id: &str, photo_ids: &[String]) -> Result<()> {
    for photo_id in photo_ids {
        conn.execute(
            "INSERT INTO collection_photos (photo_id, collection_id) VALUES (?1, ?2)
             ON CONFLICT (photo_id) DO UPDATE SET collection_id = excluded.collection_id",
            params![photo_id, collection_id],
        )?;
    }
    conn.execute(
        "UPDATE collections SET updated_at = ?1 WHERE id = ?2",
        params![db::now(), collection_id],
    )?;
    Ok(())
}

/// Every collection in the catalog with its photo count, title order first —
/// the command palette's rows. Membership counts only photos still in the
/// collection's folder, matching `collection_photo_ids`, so a count never
/// promises photos the collection wouldn't show.
///
/// Only collections in folders that still hold photos. Folders exist as the
/// distinct `folder` values on photos (see `folder_counts`), and nothing
/// deletes a collection when the last photo leaves its folder — so emptying a
/// folder strands its collections on a name no longer anywhere in the app.
/// Listing those would put permanent ghosts in the palette leading to a page
/// with no way back. A collection with no photos of its own still lists, as
/// long as its folder is alive: that one you can still fill.
fn all_collection_counts(conn: &Connection) -> Result<Vec<CollectionCount>> {
    let mut stmt = conn.prepare(
        "SELECT collections.id, collections.folder, collections.title, COUNT(photos.id)
         FROM collections
         LEFT JOIN collection_photos
           ON collection_photos.collection_id = collections.id
         LEFT JOIN photos
           ON photos.id = collection_photos.photo_id
          AND photos.folder = collections.folder
         WHERE EXISTS (SELECT 1 FROM photos WHERE photos.folder = collections.folder)
         GROUP BY collections.id
         ORDER BY collections.title COLLATE NOCASE, collections.folder",
    )?;
    let collections = stmt
        .query_map([], |row| {
            Ok(CollectionCount {
                id: row.get(0)?,
                folder: row.get(1)?,
                title: row.get(2)?,
                count: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(collections)
}

/// A folder's collections with their photos — the grid's cards.
#[tauri::command]
pub fn list_collections(db: State<Db>, folder: String) -> Result<Vec<Collection>> {
    let conn = db.0.lock().unwrap();
    collections_in_folder(&conn, &folder)
}

/// Every collection, whatever folder it's in — what the command palette
/// searches.
#[tauri::command]
pub fn list_all_collections(db: State<Db>) -> Result<Vec<CollectionCount>> {
    let conn = db.0.lock().unwrap();
    all_collection_counts(&conn)
}

/// Create a collection in `folder` holding `photo_ids` (which may be empty).
/// Rejects a title already used in the folder rather than merging into it —
/// silently pouring a selection into a same-named collection made elsewhere
/// is the kind of thing you only notice much later.
#[tauri::command]
pub fn create_collection(
    app: tauri::AppHandle,
    db: State<Db>,
    folder: String,
    title: String,
    photo_ids: Vec<String>,
) -> Result<Collection> {
    let title = normalize_title(&title)?;
    let collection = {
        let mut conn = db.0.lock().unwrap();
        let tx = conn.transaction()?;
        ensure_photos_in_folder(&tx, &folder, &photo_ids)?;
        let taken: i64 = tx.query_row(
            "SELECT COUNT(*) FROM collections WHERE folder = ?1 AND title = ?2 COLLATE NOCASE",
            params![folder, title],
            |row| row.get(0),
        )?;
        if taken > 0 {
            return Err(Error::msg(format!(
                "This folder already has a collection called \u{201c}{title}\u{201d}"
            )));
        }
        let id = Uuid::new_v4().to_string();
        let now = db::now();
        tx.execute(
            "INSERT INTO collections (id, folder, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, folder, title, now],
        )?;
        assign_photos(&tx, &id, &photo_ids)?;
        let collection = get_collection(&tx, &id)?;
        tx.commit()?;
        collection
    };
    crate::manifest::schedule_upload(&app);
    Ok(collection)
}

/// Retitle a collection. Its photos are untouched.
#[tauri::command]
pub fn rename_collection(
    app: tauri::AppHandle,
    db: State<Db>,
    id: String,
    title: String,
) -> Result<Collection> {
    let title = normalize_title(&title)?;
    let collection = {
        let conn = db.0.lock().unwrap();
        let current = get_collection(&conn, &id)?;
        if current.title != title {
            let taken: i64 = conn.query_row(
                "SELECT COUNT(*) FROM collections
                 WHERE folder = ?1 AND title = ?2 COLLATE NOCASE AND id != ?3",
                params![current.folder, title, id],
                |row| row.get(0),
            )?;
            if taken > 0 {
                return Err(Error::msg(format!(
                    "This folder already has a collection called \u{201c}{title}\u{201d}"
                )));
            }
            conn.execute(
                "UPDATE collections SET title = ?1, updated_at = ?2 WHERE id = ?3",
                params![title, db::now(), id],
            )?;
        }
        get_collection(&conn, &id)?
    };
    crate::manifest::schedule_upload(&app);
    Ok(collection)
}

/// Dissolve a collection: the title goes, the photos stay in the folder as
/// ungrouped. Nothing in the bucket moves, so this is always undoable by hand.
#[tauri::command]
pub fn delete_collection(app: tauri::AppHandle, db: State<Db>, id: String) -> Result<()> {
    {
        let conn = db.0.lock().unwrap();
        conn.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
    }
    crate::manifest::schedule_upload(&app);
    Ok(())
}

/// Move photos into an existing collection, out of any they were in.
#[tauri::command]
pub fn add_photos_to_collection(
    app: tauri::AppHandle,
    db: State<Db>,
    collection_id: String,
    photo_ids: Vec<String>,
) -> Result<Collection> {
    let collection = {
        let mut conn = db.0.lock().unwrap();
        let tx = conn.transaction()?;
        let collection = get_collection(&tx, &collection_id)?;
        ensure_photos_in_folder(&tx, &collection.folder, &photo_ids)?;
        assign_photos(&tx, &collection_id, &photo_ids)?;
        let updated = get_collection(&tx, &collection_id)?;
        tx.commit()?;
        updated
    };
    crate::manifest::schedule_upload(&app);
    Ok(collection)
}

/// Take photos out of whatever collection they're in; they stay in the folder.
/// Photos that weren't in one are silently skipped.
#[tauri::command]
pub fn remove_photos_from_collections(
    app: tauri::AppHandle,
    db: State<Db>,
    photo_ids: Vec<String>,
) -> Result<()> {
    if photo_ids.is_empty() {
        return Ok(());
    }
    {
        let conn = db.0.lock().unwrap();
        for photo_id in &photo_ids {
            unfile_photo(&conn, photo_id)?;
        }
    }
    crate::manifest::schedule_upload(&app);
    Ok(())
}

/// Take one photo out of its collection, touching that collection's
/// `updated_at` on the way — losing a photo changes a collection just as
/// gaining one does (see `assign_photos`), and the column travels to the
/// manifest. A photo that wasn't in one is a no-op.
fn unfile_photo(conn: &Connection, photo_id: &str) -> Result<()> {
    let former: Option<String> = conn
        .query_row(
            "SELECT collection_id FROM collection_photos WHERE photo_id = ?1",
            params![photo_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(former) = former else { return Ok(()) };
    conn.execute(
        "DELETE FROM collection_photos WHERE photo_id = ?1",
        params![photo_id],
    )?;
    conn.execute(
        "UPDATE collections SET updated_at = ?1 WHERE id = ?2",
        params![db::now(), former],
    )?;
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

/// Replace one photo's bytes with a new file, in place: same key, same id,
/// same tags. Resolves with the updated catalog row.
#[tauri::command]
pub async fn replace_photo(app: tauri::AppHandle, id: String, path: String) -> Result<Photo> {
    crate::import::replace_photo(app, id, path).await
}

/// Overwrite the photos already holding these files' names in `folder`.
/// Progress arrives via `import://progress` like an import does.
#[tauri::command]
pub async fn replace_photos(
    app: tauri::AppHandle,
    paths: Vec<String>,
    folder: String,
) -> Result<Vec<Photo>> {
    crate::import::replace_photos(app, paths, folder).await
}

/// Which of `filenames` an import into `folder` would have to suffix, so a
/// drop can offer Replace / Keep both / Skip instead of silently renaming.
#[tauri::command]
pub fn check_import_collisions(
    db: State<Db>,
    folder: String,
    filenames: Vec<String>,
) -> Result<Vec<String>> {
    let conn = db.0.lock().unwrap();
    crate::import::colliding_filenames(&conn, &folder, &filenames)
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

/// The dock badge for an import at `percent`, or `None` when nothing is
/// running. Clamped: a rounding slip past 100 would read as nonsense on an
/// icon the user can only glance at.
fn badge_label(percent: Option<u32>) -> Option<String> {
    percent.map(|p| format!("{}%", p.min(100)))
}

/// Mirror the overall import progress onto the app icon, so a long drop can be
/// watched while Photobank is in the background. `None` clears the badge.
/// Badge labels are macOS-only in Tauri, so this is a no-op elsewhere.
#[tauri::command]
pub fn set_upload_badge(app: tauri::AppHandle, percent: Option<u32>) -> Result<()> {
    let label = badge_label(percent);
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        // No window yet (or already gone) means nothing to badge.
        if let Some(window) = app.get_webview_window("main") {
            window
                .set_badge_label(label)
                .map_err(|e| Error::msg(e.to_string()))?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, label);
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

#[tauri::command]
pub async fn copy_photo_to_clipboard(app: tauri::AppHandle, photo_id: String) -> Result<()> {
    crate::photos::copy_photo_to_clipboard(app, photo_id).await
}

#[cfg(test)]
mod tests {
    use super::{
        add_tags, all_collection_counts, assign_photos, badge_label, build_query, chosen_cover_id,
        collections_in_folder,
        ensure_photos_in_folder, folder_counts, folder_cover, get_collection, like_pattern,
        unfile_photo,
        normalize_title, remove_tags, rename_tag_inner, set_cover, split_terms, tag_counts,
        tags_for_photos,
    };
    use crate::db::{self, now, open_in_memory, PHOTO_COLUMNS};
    use rusqlite::{params, Connection};

    #[test]
    fn like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("100%"), "%100\\%%");
        assert_eq!(like_pattern("a_b"), "%a\\_b%");
        assert_eq!(like_pattern("back\\slash"), "%back\\\\slash%");
        assert_eq!(like_pattern("plain"), "%plain%");
    }

    #[test]
    fn the_dock_badge_reads_as_a_percentage() {
        assert_eq!(badge_label(Some(0)).as_deref(), Some("0%"));
        assert_eq!(badge_label(Some(47)).as_deref(), Some("47%"));
        // A rounding slip past 100 would read as nonsense on the icon.
        assert_eq!(badge_label(Some(140)).as_deref(), Some("100%"));
        // Nothing importing means no badge at all.
        assert_eq!(badge_label(None), None);
    }

    // --- Type-based search (build_query / facets) ---

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
        search_scoped(conn, q, None)
    }

    /// Like [`search`], but optionally restricted to a single folder — mirrors
    /// the in-folder search field passing its folder as a scope.
    fn search_scoped(conn: &Connection, q: &str, folder: Option<&str>) -> Vec<String> {
        let Some((sql, bind)) = build_query(Some(q), None, None, folder) else {
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
        assert!(build_query(Some("   "), None, None, None).is_none());
        assert!(build_query(None, None, None, None).is_none());
        // A folder scope alone is not a predicate — it must not list the folder.
        assert!(build_query(None, None, None, Some("trips")).is_none());
    }

    #[test]
    fn folder_scope_restricts_the_query_to_one_folder() {
        let conn = fixture();
        // Unscoped, "beach" matches photo 1 in "trips".
        assert_eq!(search(&conn, "beach"), vec!["1"]);
        // Scoped to a different folder, the same query matches nothing.
        assert!(search_scoped(&conn, "beach", Some("inbox")).is_empty());
        // Scoped to its own folder, it still matches.
        assert_eq!(search_scoped(&conn, "beach", Some("trips")), vec!["1"]);
        // A broad term that would span folders is confined to the scope.
        assert_eq!(search_scoped(&conn, "jpg", Some("trips")), vec!["1", "2"]);
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
    fn folder_filter_query_is_uncapped_and_scoped() {
        use super::build_id_query;
        let conn = open_in_memory();
        // 250 matching photos in "big" — more than the results-page LIMIT 200 —
        // plus one in another folder that must not leak in.
        for i in 0..250 {
            insert(&conn, &format!("b{i}"), &format!("shot{i}.jpg"), "big", None, None, None, None, None, None);
        }
        insert(&conn, "other", "shot999.jpg", "elsewhere", None, None, None, None, None, None);

        let (sql, bind) = build_id_query("shot", "big").unwrap();
        // The filter must never truncate: a cap would silently hide matching
        // photos from a grid that already shows every row in the folder.
        assert!(!sql.to_uppercase().contains("LIMIT"));
        let mut stmt = conn.prepare(&sql).unwrap();
        let ids = stmt
            .query_map(rusqlite::params_from_iter(bind), |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap();
        assert_eq!(ids.len(), 250);
        assert!(!ids.iter().any(|id| id == "other"));

        // The capped results-page query truncates the same match set.
        let (capped_sql, capped_bind) = build_query(Some("shot"), None, None, Some("big")).unwrap();
        let mut stmt = conn.prepare(&capped_sql).unwrap();
        let capped = stmt
            .query_map(rusqlite::params_from_iter(capped_bind), |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap();
        assert_eq!(capped.len(), 200);
    }

    #[test]
    fn folder_filter_query_matches_nothing_for_an_empty_query() {
        use super::build_id_query;
        // An empty query is not "everything in the folder" — the caller shows
        // the unfiltered grid instead.
        assert!(build_id_query("   ", "big").is_none());
    }

    #[test]
    fn folder_facets_are_scoped_to_the_folder() {
        use super::folder_facets;
        let conn = fixture();

        // "trips" holds the Fuji + Canon photos and their tags.
        let trips = folder_facets(&conn, "trips").unwrap();
        assert_eq!(trips.tags, vec!["night", "sunset"]);
        assert_eq!(trips.makes, vec!["Canon", "FUJIFILM"]);
        assert_eq!(trips.models, vec!["EOS R5", "X100V"]);
        assert_eq!(trips.lenses, vec!["23mm", "50mm"]);

        // "inbox" has only the metadata-less, untagged photo — every pool empty.
        let inbox = folder_facets(&conn, "inbox").unwrap();
        assert!(inbox.tags.is_empty());
        assert!(inbox.makes.is_empty());
        assert!(inbox.models.is_empty());
        assert!(inbox.lenses.is_empty());
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

    // --- Bulk tagging + tag management (Ankitron tag system) ---

    fn insert_photo(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO photos (id, filename, s3_key, folder, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'inbox', ?4, ?4)",
            params![id, format!("{id}.jpg"), format!("inbox/{id}.jpg"), db::now()],
        )
        .unwrap();
    }

    fn tag_names(conn: &Connection, photo_id: &str) -> Vec<String> {
        tags_for_photos(conn, &[photo_id.to_string()])
            .unwrap()
            .remove(photo_id)
            .unwrap()
            .into_iter()
            .map(|t| t.name)
            .collect()
    }

    #[test]
    fn add_tags_creates_tags_and_applies_to_every_photo() {
        let conn = open_in_memory();
        insert_photo(&conn, "p1");
        insert_photo(&conn, "p2");

        add_tags(
            &conn,
            &["p1".into(), "p2".into()],
            &["sunset".into(), "beach".into()],
        )
        .unwrap();

        assert_eq!(tag_names(&conn, "p1"), vec!["beach", "sunset"]);
        assert_eq!(tag_names(&conn, "p2"), vec!["beach", "sunset"]);
        // The tag is created once and shared, not duplicated per photo.
        let tag_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tag_count, 2);
    }

    #[test]
    fn add_tags_is_idempotent_and_skips_blank_names() {
        let conn = open_in_memory();
        insert_photo(&conn, "p1");

        add_tags(&conn, &["p1".into()], &["sunset".into()]).unwrap();
        // Re-adding the same tag, plus a blank name, changes nothing.
        add_tags(&conn, &["p1".into()], &["sunset".into(), "  ".into()]).unwrap();

        assert_eq!(tag_names(&conn, "p1"), vec!["sunset"]);
        let links: i64 = conn
            .query_row("SELECT COUNT(*) FROM photo_tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(links, 1);
    }

    #[test]
    fn remove_tags_strips_only_the_named_tags_from_the_listed_photos() {
        let conn = open_in_memory();
        insert_photo(&conn, "p1");
        insert_photo(&conn, "p2");
        add_tags(
            &conn,
            &["p1".into(), "p2".into()],
            &["sunset".into(), "beach".into()],
        )
        .unwrap();

        // Remove "sunset" from p1 only; p2 and the "beach" tag stay put.
        remove_tags(&conn, &["p1".into()], &["sunset".into()]).unwrap();

        assert_eq!(tag_names(&conn, "p1"), vec!["beach"]);
        assert_eq!(tag_names(&conn, "p2"), vec!["beach", "sunset"]);
    }

    #[test]
    fn remove_tags_ignores_unknown_names() {
        let conn = open_in_memory();
        insert_photo(&conn, "p1");
        add_tags(&conn, &["p1".into()], &["sunset".into()]).unwrap();

        // "nope" was never a tag; removing it is a no-op, not an error.
        remove_tags(&conn, &["p1".into()], &["nope".into()]).unwrap();

        assert_eq!(tag_names(&conn, "p1"), vec!["sunset"]);
    }

    #[test]
    fn tags_for_photos_includes_untagged_photos_as_empty() {
        let conn = open_in_memory();
        insert_photo(&conn, "p1");
        insert_photo(&conn, "p2");
        add_tags(&conn, &["p1".into()], &["sunset".into()]).unwrap();

        let map = tags_for_photos(&conn, &["p1".into(), "p2".into()]).unwrap();
        assert_eq!(map.get("p1").unwrap().len(), 1);
        assert!(map.get("p2").unwrap().is_empty());
    }

    fn tag_id(conn: &Connection, name: &str) -> String {
        conn.query_row("SELECT id FROM tags WHERE name = ?1", params![name], |r| {
            r.get(0)
        })
        .unwrap()
    }

    #[test]
    fn tag_counts_reports_photo_counts_including_empty_tags() {
        let conn = open_in_memory();
        insert_photo(&conn, "p1");
        insert_photo(&conn, "p2");
        add_tags(&conn, &["p1".into(), "p2".into()], &["beach".into()]).unwrap();
        add_tags(&conn, &["p1".into()], &["sunset".into()]).unwrap();
        // Strip sunset back off so its tag row survives with no photos.
        remove_tags(&conn, &["p1".into()], &["sunset".into()]).unwrap();

        let counts = tag_counts(&conn).unwrap();
        // Name-sorted: beach (2), sunset (0).
        assert_eq!(counts.len(), 2);
        assert_eq!(counts[0].name, "beach");
        assert_eq!(counts[0].count, 2);
        assert_eq!(counts[1].name, "sunset");
        assert_eq!(counts[1].count, 0);
    }

    #[test]
    fn rename_tag_changes_the_name_in_place() {
        let conn = open_in_memory();
        insert_photo(&conn, "p1");
        add_tags(&conn, &["p1".into()], &["beech".into()]).unwrap();
        let id = tag_id(&conn, "beech");

        let tag = rename_tag_inner(&conn, &id, "beach").unwrap();
        assert_eq!(tag.id, id);
        assert_eq!(tag.name, "beach");
        assert_eq!(tag_names(&conn, "p1"), vec!["beach"]);
    }

    #[test]
    fn renaming_onto_an_existing_tag_merges_them() {
        let conn = open_in_memory();
        insert_photo(&conn, "p1");
        insert_photo(&conn, "p2");
        // p1 has both tags; p2 has only "shore".
        add_tags(&conn, &["p1".into()], &["beach".into(), "shore".into()]).unwrap();
        add_tags(&conn, &["p2".into()], &["shore".into()]).unwrap();
        let shore = tag_id(&conn, "shore");
        let beach = tag_id(&conn, "beach");

        // Rename "shore" -> "beach": the two collapse into one tag.
        let survivor = rename_tag_inner(&conn, &shore, "beach").unwrap();
        assert_eq!(survivor.id, beach, "the existing tag survives the merge");

        // "shore" is gone; p1 keeps a single "beach" link (deduped); p2 now
        // carries "beach".
        let tags: i64 = conn
            .query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tags, 1);
        assert_eq!(tag_names(&conn, "p1"), vec!["beach"]);
        assert_eq!(tag_names(&conn, "p2"), vec!["beach"]);
    }

    #[test]
    fn deleting_a_tag_unlinks_it_from_photos() {
        let conn = open_in_memory();
        insert_photo(&conn, "p1");
        add_tags(&conn, &["p1".into()], &["beach".into(), "sunset".into()]).unwrap();
        let beach = tag_id(&conn, "beach");

        conn.execute("DELETE FROM tags WHERE id = ?1", params![beach])
            .unwrap();

        // The photo remains, minus the deleted tag; the link cascaded away.
        assert_eq!(tag_names(&conn, "p1"), vec!["sunset"]);
        let links: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM photo_tags WHERE tag_id = ?1",
                params![beach],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(links, 0);
    }

    // --- Folder covers ---

    /// A displayable photo of `folder`, pinned to an explicit created_at so
    /// the default-cover ordering is deterministic.
    fn insert_cover_candidate(
        conn: &Connection,
        id: &str,
        folder: &str,
        created_at: &str,
        variants_ok: bool,
    ) {
        conn.execute(
            "INSERT INTO photos
             (id, filename, s3_key, folder, processing_status, variants_ok, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'completed', ?5, ?6, ?6)",
            params![
                id,
                format!("{id}.jpg"),
                format!("{folder}/{id}.jpg"),
                folder,
                variants_ok,
                created_at,
            ],
        )
        .unwrap();
    }

    #[test]
    fn the_folder_listing_carries_each_folder_s_newest_photo_time() {
        let conn = open_in_memory();
        insert_cover_candidate(&conn, "a", "trips", "2026-01-01T00:00:00Z", true);
        insert_cover_candidate(&conn, "b", "trips", "2026-03-01T00:00:00Z", true);
        insert_cover_candidate(&conn, "c", "berlin", "2026-02-01T00:00:00Z", true);

        let folders = folder_counts(&conn).unwrap();
        // Name order out of SQL; the home page re-sorts from there.
        let names: Vec<_> = folders.iter().map(|f| f.folder.as_str()).collect();
        assert_eq!(names, ["berlin", "trips"]);

        let trips = &folders[1];
        assert_eq!(trips.count, 2);
        // The newest photo's created_at, not the oldest and not the cover's.
        assert_eq!(trips.last_added_at.as_deref(), Some("2026-03-01T00:00:00Z"));
        assert_eq!(trips.cover_key.as_deref(), Some("trips/b.jpg"));
        assert_eq!(
            folders[0].last_added_at.as_deref(),
            Some("2026-02-01T00:00:00Z")
        );
    }

    #[test]
    fn folder_cover_falls_back_to_the_newest_photo_with_thumbnails() {
        let conn = open_in_memory();
        insert_cover_candidate(&conn, "old", "trips", "2026-01-01T00:00:00Z", true);
        insert_cover_candidate(&conn, "new", "trips", "2026-03-01T00:00:00Z", true);
        // Newest of all, but its variants are missing — showing it would mean
        // pulling the original down to fill a folder tile.
        insert_cover_candidate(&conn, "raw", "trips", "2026-04-01T00:00:00Z", false);
        // Still importing: nothing to show yet.
        insert(&conn, "pending", "p.jpg", "trips", None, None, None, None, None, None);

        let (key, _) = folder_cover(&conn, "trips").unwrap().unwrap();
        assert_eq!(key, "trips/new.jpg");

        // A folder with nothing displayable has no cover at all.
        assert!(folder_cover(&conn, "empty").unwrap().is_none());
    }

    #[test]
    fn a_folder_awaiting_its_thumbnails_shows_no_automatic_cover() {
        let conn = open_in_memory();
        // Originals synced into the bucket from elsewhere: the refresh hasn't
        // built their variants yet. The home page shows the placeholder rather
        // than downloading a full original per card.
        insert_cover_candidate(&conn, "a", "trips", "2026-01-01T00:00:00Z", false);
        insert_cover_candidate(&conn, "b", "trips", "2026-02-01T00:00:00Z", false);

        assert!(folder_cover(&conn, "trips").unwrap().is_none());

        // An explicit pick is the user's call, so it shows regardless — the
        // thumbnail falls back to the original for that one photo.
        set_cover(&conn, "trips", "a").unwrap();
        assert_eq!(folder_cover(&conn, "trips").unwrap().unwrap().0, "trips/a.jpg");
    }

    #[test]
    fn a_chosen_cover_wins_over_the_newest_photo() {
        let conn = open_in_memory();
        insert_cover_candidate(&conn, "old", "trips", "2026-01-01T00:00:00Z", true);
        insert_cover_candidate(&conn, "new", "trips", "2026-03-01T00:00:00Z", true);

        set_cover(&conn, "trips", "old").unwrap();

        let (key, version) = folder_cover(&conn, "trips").unwrap().unwrap();
        assert_eq!(key, "trips/old.jpg");
        assert_eq!(version, "2026-01-01T00:00:00Z");
        assert_eq!(chosen_cover_id(&conn, "trips").unwrap(), Some("old".into()));

        // Picking again replaces the previous choice rather than erroring.
        set_cover(&conn, "trips", "new").unwrap();
        assert_eq!(chosen_cover_id(&conn, "trips").unwrap(), Some("new".into()));
        assert_eq!(folder_cover(&conn, "trips").unwrap().unwrap().0, "trips/new.jpg");
    }

    #[test]
    fn a_cover_photo_that_leaves_the_folder_stops_counting() {
        let conn = open_in_memory();
        insert_cover_candidate(&conn, "old", "trips", "2026-01-01T00:00:00Z", true);
        insert_cover_candidate(&conn, "new", "trips", "2026-03-01T00:00:00Z", true);
        set_cover(&conn, "trips", "old").unwrap();

        conn.execute(
            "UPDATE photos SET folder = 'beach', s3_key = 'beach/old.jpg' WHERE id = 'old'",
            [],
        )
        .unwrap();

        // Both the card and the lightbox toggle fall back to "no pick".
        assert_eq!(folder_cover(&conn, "trips").unwrap().unwrap().0, "trips/new.jpg");
        assert_eq!(chosen_cover_id(&conn, "trips").unwrap(), None);
        // And it doesn't leak into the folder it landed in.
        assert_eq!(chosen_cover_id(&conn, "beach").unwrap(), None);
    }

    #[test]
    fn a_photo_from_another_folder_cannot_be_a_cover() {
        let conn = open_in_memory();
        insert_cover_candidate(&conn, "a", "trips", "2026-01-01T00:00:00Z", true);
        insert_cover_candidate(&conn, "b", "beach", "2026-01-01T00:00:00Z", true);

        let err = set_cover(&conn, "trips", "b").unwrap_err();
        assert!(err.to_string().contains("not in this folder"), "{err}");
        assert!(set_cover(&conn, "trips", "nope").is_err());
        assert_eq!(chosen_cover_id(&conn, "trips").unwrap(), None);
    }

    // --- Collections ---

    /// A collection row, created at an explicit time so card order (newest
    /// first) is deterministic rather than depending on clock resolution.
    fn insert_collection(conn: &Connection, id: &str, folder: &str, title: &str, created_at: &str) {
        conn.execute(
            "INSERT INTO collections (id, folder, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, folder, title, created_at],
        )
        .unwrap();
    }

    #[test]
    fn collection_titles_are_trimmed_and_whitespace_folded() {
        assert_eq!(normalize_title("  Day one  ").unwrap(), "Day one");
        assert_eq!(normalize_title("Day\t one").unwrap(), "Day one");
        // A title of nothing but spaces is no title at all.
        assert!(normalize_title("   ").is_err());
        assert!(normalize_title("").is_err());
    }

    #[test]
    fn a_folder_lists_its_collections_newest_first_with_their_photos() {
        let conn = open_in_memory();
        insert_cover_candidate(&conn, "a", "trips", "2026-01-01T00:00:00Z", true);
        insert_cover_candidate(&conn, "b", "trips", "2026-02-01T00:00:00Z", true);
        insert_cover_candidate(&conn, "c", "beach", "2026-01-01T00:00:00Z", true);
        insert_collection(&conn, "old", "trips", "Day one", "2026-01-01T00:00:00Z");
        insert_collection(&conn, "new", "trips", "Day two", "2026-02-01T00:00:00Z");
        insert_collection(&conn, "other", "beach", "Swims", "2026-01-01T00:00:00Z");
        assign_photos(&conn, "old", &["a".into(), "b".into()]).unwrap();

        let collections = collections_in_folder(&conn, "trips").unwrap();
        let titles: Vec<_> = collections.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, vec!["Day two", "Day one"]);
        // Newest photo first, like the folder listing itself.
        assert_eq!(collections[1].photo_ids, vec!["b", "a"]);
        // An empty collection still lists — its card is how you get at it.
        assert!(collections[0].photo_ids.is_empty());
        // Another folder's collection stays out of it.
        assert_eq!(collections_in_folder(&conn, "beach").unwrap().len(), 1);
    }

    #[test]
    fn every_collection_lists_by_title_with_a_live_photo_count() {
        let conn = open_in_memory();
        insert_cover_candidate(&conn, "a", "trips", "2026-01-01T00:00:00Z", true);
        insert_cover_candidate(&conn, "b", "trips", "2026-02-01T00:00:00Z", true);
        insert_cover_candidate(&conn, "c", "beach", "2026-01-01T00:00:00Z", true);
        insert_collection(&conn, "c1", "trips", "Day one", "2026-01-01T00:00:00Z");
        insert_collection(&conn, "c2", "beach", "Swims", "2026-02-01T00:00:00Z");
        insert_collection(&conn, "c3", "trips", "Empty", "2026-03-01T00:00:00Z");
        assign_photos(&conn, "c1", &["a".into(), "b".into()]).unwrap();
        assign_photos(&conn, "c2", &["c".into()]).unwrap();

        let all = all_collection_counts(&conn).unwrap();
        let rows: Vec<_> = all
            .iter()
            .map(|c| (c.title.as_str(), c.folder.as_str(), c.count))
            .collect();
        // Every folder's collections together, in title order, empties included.
        assert_eq!(
            rows,
            vec![
                ("Day one", "trips", 2),
                ("Empty", "trips", 0),
                ("Swims", "beach", 1),
            ]
        );

        // A membership that outlived a move doesn't inflate the count, just as
        // it doesn't show up inside the collection.
        conn.execute(
            "UPDATE photos SET folder = 'beach', s3_key = 'beach/b.jpg' WHERE id = 'b'",
            [],
        )
        .unwrap();
        let all = all_collection_counts(&conn).unwrap();
        assert_eq!(all[0].count, 1);
    }

    #[test]
    fn a_collection_whose_folder_emptied_out_is_not_listed() {
        let conn = open_in_memory();
        insert_cover_candidate(&conn, "a", "trips", "2026-01-01T00:00:00Z", true);
        insert_collection(&conn, "c1", "trips", "Day one", "2026-01-01T00:00:00Z");
        assign_photos(&conn, "c1", &["a".into()]).unwrap();

        // Emptying the folder — moving its last photo out, deleting it — leaves
        // the collection behind pointing at a folder that no longer exists (no
        // photos, so `folder_counts` doesn't list it either).
        conn.execute("DELETE FROM photos WHERE id = 'a'", []).unwrap();

        assert!(all_collection_counts(&conn).unwrap().is_empty());
        // The folder listing agrees the folder is gone.
        assert!(folder_counts(&conn).unwrap().is_empty());
    }

    #[test]
    fn adding_a_photo_to_a_collection_takes_it_out_of_its_old_one() {
        let conn = open_in_memory();
        insert_cover_candidate(&conn, "a", "trips", "2026-01-01T00:00:00Z", true);
        insert_collection(&conn, "c1", "trips", "Day one", "2026-01-01T00:00:00Z");
        insert_collection(&conn, "c2", "trips", "Day two", "2026-02-01T00:00:00Z");

        assign_photos(&conn, "c1", &["a".into()]).unwrap();
        assign_photos(&conn, "c2", &["a".into()]).unwrap();

        assert!(get_collection(&conn, "c1").unwrap().photo_ids.is_empty());
        assert_eq!(get_collection(&conn, "c2").unwrap().photo_ids, vec!["a"]);
    }

    #[test]
    fn a_membership_that_outlived_a_move_is_not_listed_in_the_collection() {
        let conn = open_in_memory();
        insert_cover_candidate(&conn, "a", "trips", "2026-01-01T00:00:00Z", true);
        insert_collection(&conn, "c1", "trips", "Day one", "2026-01-01T00:00:00Z");
        assign_photos(&conn, "c1", &["a".into()]).unwrap();

        // A rebuild can restore a membership whose photo the bucket says is
        // somewhere else; the collection must not show it.
        conn.execute(
            "UPDATE photos SET folder = 'beach', s3_key = 'beach/a.jpg' WHERE id = 'a'",
            [],
        )
        .unwrap();

        assert!(get_collection(&conn, "c1").unwrap().photo_ids.is_empty());
    }

    #[test]
    fn only_the_folders_own_photos_can_join_a_collection() {
        let conn = open_in_memory();
        insert_cover_candidate(&conn, "a", "trips", "2026-01-01T00:00:00Z", true);
        insert_cover_candidate(&conn, "b", "beach", "2026-01-01T00:00:00Z", true);

        ensure_photos_in_folder(&conn, "trips", &["a".into()]).unwrap();
        let err = ensure_photos_in_folder(&conn, "trips", &["a".into(), "b".into()]).unwrap_err();
        assert!(err.to_string().contains("no longer in this folder"), "{err}");
        let gone = ensure_photos_in_folder(&conn, "trips", &["nope".into()]).unwrap_err();
        assert!(gone.to_string().contains("no longer exist"), "{gone}");
    }

    #[test]
    fn unfiling_a_photo_touches_the_collection_that_lost_it() {
        let conn = open_in_memory();
        insert_cover_candidate(&conn, "a", "trips", "2026-01-01T00:00:00Z", true);
        insert_collection(&conn, "c1", "trips", "Day one", "2026-01-01T00:00:00Z");
        assign_photos(&conn, "c1", &["a".into()]).unwrap();

        // Pin updated_at back to a known value: assign_photos has just moved it.
        conn.execute(
            "UPDATE collections SET updated_at = '2026-01-01T00:00:00Z' WHERE id = 'c1'",
            [],
        )
        .unwrap();

        unfile_photo(&conn, "a").unwrap();

        let touched: String = conn
            .query_row("SELECT updated_at FROM collections WHERE id = 'c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        // Losing a photo changes a collection just as gaining one does, and
        // the column ships to the manifest.
        assert_ne!(touched, "2026-01-01T00:00:00Z");
        assert!(get_collection(&conn, "c1").unwrap().photo_ids.is_empty());

        // A photo that was never filed leaves every collection alone.
        insert_cover_candidate(&conn, "b", "trips", "2026-01-01T00:00:00Z", true);
        unfile_photo(&conn, "b").unwrap();
        let after: String = conn
            .query_row("SELECT updated_at FROM collections WHERE id = 'c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(after, touched);
    }

    #[test]
    fn a_missing_collection_is_a_friendly_error() {
        let conn = open_in_memory();
        let err = get_collection(&conn, "nope").unwrap_err();
        assert!(err.to_string().contains("no longer exists"), "{err}");
    }
}
