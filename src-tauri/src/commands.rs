use rusqlite::params;
use rusqlite::types::Value;
use tauri::State;
use uuid::Uuid;

use crate::db::{self, Db, FolderCount, Photo, Tag, PHOTO_COLUMNS};
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

/// Escape LIKE wildcards so a query like "100%" matches literally, mirroring
/// the old API's likePattern(). Patterns are used with `ESCAPE '\'`.
fn like_pattern(term: &str) -> String {
    let mut escaped = String::with_capacity(term.len() + 2);
    escaped.push('%');
    for c in term.chars() {
        if c == '\\' || c == '%' || c == '_' {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped.push('%');
    escaped
}

#[tauri::command]
pub fn search_photos(
    db: State<Db>,
    q: Option<String>,
    tag: Option<String>,
    camera: Option<String>,
) -> Result<Vec<Photo>> {
    let q = q.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let tag = tag.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let camera = camera.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    if q.is_none() && tag.is_none() && camera.is_none() {
        return Ok(Vec::new());
    }

    const TAGGED_BY: &str = "SELECT photo_id FROM photo_tags \
        INNER JOIN tags ON tags.id = photo_tags.tag_id \
        WHERE tags.name LIKE ? ESCAPE '\\'";

    let mut conditions: Vec<String> = Vec::new();
    let mut params_list: Vec<Value> = Vec::new();

    if let Some(q) = &q {
        let pattern = like_pattern(q);
        conditions.push(format!(
            "(filename LIKE ? ESCAPE '\\' OR folder LIKE ? ESCAPE '\\' \
             OR camera_make LIKE ? ESCAPE '\\' OR camera_model LIKE ? ESCAPE '\\' \
             OR lens LIKE ? ESCAPE '\\' OR id IN ({TAGGED_BY}))",
        ));
        for _ in 0..6 {
            params_list.push(Value::Text(pattern.clone()));
        }
    }

    if let Some(camera) = &camera {
        let pattern = like_pattern(camera);
        conditions.push(
            "(camera_make LIKE ? ESCAPE '\\' OR camera_model LIKE ? ESCAPE '\\')".into(),
        );
        params_list.push(Value::Text(pattern.clone()));
        params_list.push(Value::Text(pattern));
    }

    if let Some(tag) = &tag {
        conditions.push(format!("id IN ({TAGGED_BY})"));
        params_list.push(Value::Text(like_pattern(tag)));
    }

    let sql = format!(
        "SELECT {PHOTO_COLUMNS} FROM photos WHERE {} ORDER BY created_at DESC LIMIT 200",
        conditions.join(" AND ")
    );

    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(&sql)?;
    let photos = stmt
        .query_map(rusqlite::params_from_iter(params_list), db::photo_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(photos)
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
pub fn add_photo_tag(db: State<Db>, photo_id: String, name: String) -> Result<Tag> {
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
    Ok(tag)
}

#[tauri::command]
pub fn remove_photo_tag(db: State<Db>, photo_id: String, tag_id: String) -> Result<()> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "DELETE FROM photo_tags WHERE photo_id = ?1 AND tag_id = ?2",
        params![photo_id, tag_id],
    )?;
    Ok(())
}

// The commands below need the S3 client and image pipeline from later phases.
// They exist now so the frontend's api.ts is complete and fails politely.

#[tauri::command]
pub fn update_photo(
    _id: String,
    _folder: Option<String>,
    _filename: Option<String>,
) -> Result<Photo> {
    Err(Error::msg("Moving and renaming arrives in a later phase"))
}

#[tauri::command]
pub fn delete_photo(_id: String) -> Result<()> {
    Err(Error::msg("Deleting arrives in a later phase"))
}

#[tauri::command]
pub fn import_photos(_paths: Vec<String>, _folder: String) -> Result<Vec<Photo>> {
    Err(Error::msg("Importing arrives in a later phase"))
}

#[tauri::command]
pub fn export_photos(_photo_ids: Vec<String>, _resolution: String) -> Result<Option<String>> {
    Err(Error::msg("Exporting arrives in a later phase"))
}

#[cfg(test)]
mod tests {
    use super::like_pattern;

    #[test]
    fn like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("100%"), "%100\\%%");
        assert_eq!(like_pattern("a_b"), "%a\\_b%");
        assert_eq!(like_pattern("back\\slash"), "%back\\\\slash%");
        assert_eq!(like_pattern("plain"), "%plain%");
    }
}
