//! Photo mutations that touch both S3 and the catalog: move/rename, delete,
//! and export. Ports the behavior of the old /api/photos/[id] and
//! /api/download routes, including their ordering guarantees.

use std::collections::HashSet;
use std::path::PathBuf;

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::db::{self, Db, Photo, PHOTO_COLUMNS};
use crate::error::{Error, Result};
use crate::keys::{base_key, sanitize_filename, sanitize_folder, variant_suffixes};
use crate::protocol;
use crate::settings::{S3Ctx, S3State};

/// encodeURIComponent's unreserved set, applied per path segment — matches
/// encodeKey in src/lib/keys.ts, which S3 CopySource requires.
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

fn encode_key(key: &str) -> String {
    key.split('/')
        .map(|segment| utf8_percent_encode(segment, COMPONENT).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn get_photo(app: &AppHandle, id: &str) -> Result<Photo> {
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
    conn.query_row(
        &format!("SELECT {PHOTO_COLUMNS} FROM photos WHERE id = ?1"),
        rusqlite::params![id],
        db::photo_from_row,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Error::msg("Not found"),
        other => Error::from(other),
    })
}

async fn s3_copy(ctx: &S3Ctx, from: &str, to: &str) -> Result<()> {
    ctx.client
        .copy_object()
        .bucket(&ctx.bucket)
        .copy_source(format!("{}/{}", ctx.bucket, encode_key(from)))
        .key(to)
        .send()
        .await
        .map_err(|e| {
            Error::msg(format!(
                "copy of {from} failed: {}",
                aws_smithy_types::error::display::DisplayErrorContext(&e)
            ))
        })?;
    Ok(())
}

async fn s3_delete_quiet(ctx: &S3Ctx, key: &str) {
    let _ = ctx
        .client
        .delete_object()
        .bucket(&ctx.bucket)
        .key(key)
        .send()
        .await;
}

/// Batch-delete objects from the bucket, reporting failure. S3 treats deleting
/// a missing key as success, so absent variants (a photo may not have every
/// derivative) don't error — only a genuine failure such as a network drop or
/// missing permission surfaces, which lets the caller keep the photo instead
/// of orphaning its bucket objects. Note DeleteObjects can fail per key: on a
/// partial failure some objects may already be gone, so we return Err (the
/// photo is kept) but a subset of its variants can be left deleted.
async fn s3_delete_many(ctx: &S3Ctx, keys: &[String]) -> Result<()> {
    use aws_sdk_s3::types::{Delete, ObjectIdentifier};

    let objects = keys
        .iter()
        .map(|key| {
            ObjectIdentifier::builder()
                .key(key)
                .build()
                .map_err(|e| Error::msg(e.to_string()))
        })
        .collect::<Result<Vec<_>>>()?;

    let delete = Delete::builder()
        .set_objects(Some(objects))
        .quiet(true)
        .build()
        .map_err(|e| Error::msg(e.to_string()))?;

    let output = ctx
        .client
        .delete_objects()
        .bucket(&ctx.bucket)
        .delete(delete)
        .send()
        .await
        .map_err(|e| {
            Error::msg(format!(
                "delete failed: {}",
                aws_smithy_types::error::display::DisplayErrorContext(&e)
            ))
        })?;

    let errors = output.errors();
    if !errors.is_empty() {
        let detail = errors
            .iter()
            .map(|e| {
                format!(
                    "{}: {}",
                    e.key().unwrap_or("?"),
                    e.message().unwrap_or("unknown error")
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        return Err(Error::msg(format!("could not delete from bucket: {detail}")));
    }
    Ok(())
}

/// Move and/or rename. Order matters and mirrors the old PATCH route:
/// copy original → copy variants (remembering which existed) → repoint the
/// DB → delete old objects. A failure partway never loses the photo.
pub async fn update_photo(
    app: AppHandle,
    id: String,
    folder: Option<String>,
    filename: Option<String>,
) -> Result<Photo> {
    let folder = match folder {
        Some(f) => Some(sanitize_folder(&f).ok_or_else(|| Error::msg("Invalid folder"))?),
        None => None,
    };
    let filename = match filename {
        Some(f) => Some(sanitize_filename(&f).ok_or_else(|| Error::msg("Invalid filename"))?),
        None => None,
    };

    let photo = get_photo(&app, &id)?;
    let new_folder = folder.unwrap_or_else(|| photo.folder.clone());
    let new_filename = filename.unwrap_or_else(|| photo.filename.clone());
    let new_s3_key = format!("{new_folder}/{new_filename}");

    if new_s3_key == photo.s3_key {
        return Ok(photo);
    }

    // Refuse to move onto another photo — the copy would overwrite its S3
    // objects before the DB unique constraint had a chance to complain.
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        let occupant: Option<String> = conn
            .query_row(
                "SELECT id FROM photos WHERE folder = ?1 AND filename = ?2",
                rusqlite::params![new_folder, new_filename],
                |row| row.get(0),
            )
            .ok();
        if occupant.is_some_and(|other| other != id) {
            return Err(Error::msg(
                "A photo with that name already exists in the target folder",
            ));
        }
    }

    let old_base = base_key(&photo.s3_key).to_string();
    let new_base = base_key(&new_s3_key).to_string();

    let state = app.state::<S3State>();
    let guard = state.0.read().await;
    let ctx = guard
        .as_ref()
        .ok_or_else(|| Error::msg("S3 is not configured — open Settings first"))?;
    crate::settings::ensure_catalog_matches_bucket(&app, ctx)?;

    // Copy original; if this fails nothing has been touched yet
    s3_copy(ctx, &photo.s3_key, &new_s3_key).await?;

    // Copy variants, remembering which ones made it (a variant may not
    // exist yet if the photo is still processing)
    let mut copied_suffixes = Vec::new();
    for suffix in variant_suffixes() {
        if s3_copy(ctx, &format!("{old_base}{suffix}"), &format!("{new_base}{suffix}"))
            .await
            .is_ok()
        {
            copied_suffixes.push(suffix);
        }
    }

    // Point the DB at the new location before deleting anything, so a
    // failure here leaves the photo intact at its old key
    let updated = {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        conn.query_row(
            &format!(
                "UPDATE photos SET folder = ?1, filename = ?2, s3_key = ?3, updated_at = ?4
                 WHERE id = ?5 RETURNING {PHOTO_COLUMNS}"
            ),
            rusqlite::params![new_folder, new_filename, new_s3_key, db::now(), id],
            db::photo_from_row,
        )?
    };

    // Delete the old original and only the variants we actually copied
    s3_delete_quiet(ctx, &photo.s3_key).await;
    for suffix in &copied_suffixes {
        s3_delete_quiet(ctx, &format!("{old_base}{suffix}")).await;
    }
    drop(guard);

    // Keep the local cache warm: rename cached files to their new keys
    rename_cached(&app, &photo.s3_key, &new_s3_key).await;
    for suffix in &copied_suffixes {
        rename_cached(&app, &format!("{old_base}{suffix}"), &format!("{new_base}{suffix}")).await;
    }

    crate::manifest::schedule_upload(&app);
    Ok(updated)
}

/// Delete a photo, its variants, its catalog row (cascading to tags), and
/// any cached files.
pub async fn delete_photo(app: AppHandle, id: String) -> Result<()> {
    let photo = get_photo(&app, &id)?;
    let base = base_key(&photo.s3_key).to_string();

    let mut keys = vec![photo.s3_key.clone()];
    keys.extend(variant_suffixes().iter().map(|suffix| format!("{base}{suffix}")));

    // Delete from the bucket first. If this genuinely fails, bail before
    // touching the catalog so the photo stays intact and the UI can restore
    // its thumbnail. (A partial DeleteObjects failure can still leave a subset
    // of variants deleted while the row is kept — see s3_delete_many.)
    {
        let state = app.state::<S3State>();
        let guard = state.0.read().await;
        let ctx = guard
            .as_ref()
            .ok_or_else(|| Error::msg("S3 is not configured — open Settings first"))?;
        crate::settings::ensure_catalog_matches_bucket(&app, ctx)?;
        s3_delete_many(ctx, &keys).await?;
    }

    {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        conn.execute("DELETE FROM photos WHERE id = ?1", rusqlite::params![id])?;
    }

    for key in &keys {
        let _ = tokio::fs::remove_file(protocol::cache_path(&app, key)).await;
    }

    crate::manifest::schedule_upload(&app);
    Ok(())
}

async fn rename_cached(app: &AppHandle, from: &str, to: &str) {
    let from = protocol::cache_path(app, from);
    let to = protocol::cache_path(app, to);
    if let Some(parent) = to.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let _ = tokio::fs::rename(from, to).await;
}

/// Export the chosen variant of each photo to disk. One photo → save-file
/// dialog; several → folder picker, with duplicate names suffixed "(n)"
/// like the old zip download. Returns the written path, or None if the
/// user cancelled the dialog.
pub async fn export_photos(
    app: AppHandle,
    photo_ids: Vec<String>,
    resolution: String,
) -> Result<Option<String>> {
    if photo_ids.is_empty() {
        return Err(Error::msg("No photos selected"));
    }
    if !matches!(resolution.as_str(), "640" | "1280" | "2880" | "original") {
        return Err(Error::msg("Invalid resolution"));
    }

    let photos: Vec<Photo> = {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        let placeholders = photo_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT {PHOTO_COLUMNS} FROM photos WHERE id IN ({placeholders})"
        ))?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(photo_ids.iter()),
                db::photo_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    if photos.is_empty() {
        return Err(Error::msg("No photos found"));
    }

    let source_key = |photo: &Photo| -> (String, String) {
        if resolution == "original" {
            let ext = photo
                .filename
                .rsplit('.')
                .next()
                .filter(|e| *e != photo.filename)
                .unwrap_or("jpg")
                .to_string();
            (photo.s3_key.clone(), ext)
        } else {
            (
                format!("{}_{resolution}.jpg", base_key(&photo.s3_key)),
                "jpg".to_string(),
            )
        }
    };

    if photos.len() == 1 {
        let photo = &photos[0];
        let (key, ext) = source_key(photo);
        let stem = base_key(&photo.filename).to_string();
        let app_for_dialog = app.clone();
        let default_name = format!("{stem}.{ext}");
        let picked = tauri::async_runtime::spawn_blocking(move || {
            app_for_dialog
                .dialog()
                .file()
                .set_file_name(&default_name)
                .blocking_save_file()
        })
        .await
        .map_err(|e| Error::msg(e.to_string()))?;
        let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
            return Ok(None);
        };
        let bytes = fetch_bytes(&app, &key).await?;
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|e| Error::msg(format!("could not write {}: {e}", path.display())))?;
        return Ok(Some(path.display().to_string()));
    }

    let app_for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))?;
    let Some(dir) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };

    // Avoid duplicate file names when photos in different folders share one
    let mut used: HashSet<String> = HashSet::new();
    let mut written = 0usize;
    for photo in &photos {
        let (key, ext) = source_key(photo);
        let stem = base_key(&photo.filename).to_string();
        let mut name = format!("{stem}.{ext}");
        let mut n = 1;
        while used.contains(&name) {
            name = format!("{stem} ({n}).{ext}");
            n += 1;
        }

        // Skip missing objects, like the old zip endpoint did
        let Ok(bytes) = fetch_bytes(&app, &key).await else {
            continue;
        };
        let target: PathBuf = dir.join(&name);
        tokio::fs::write(&target, bytes)
            .await
            .map_err(|e| Error::msg(format!("could not write {}: {e}", target.display())))?;
        used.insert(name);
        written += 1;
    }

    if written == 0 {
        return Err(Error::msg("None of the selected photos could be exported"));
    }
    Ok(Some(dir.display().to_string()))
}

/// Cache-first object read, warming the cache on a miss (same policy as the
/// photo:// protocol).
async fn fetch_bytes(app: &AppHandle, key: &str) -> Result<Vec<u8>> {
    let cache_path = protocol::cache_path(app, key);
    if let Ok(bytes) = tokio::fs::read(&cache_path).await {
        return Ok(bytes);
    }

    let state = app.state::<S3State>();
    let guard = state.0.read().await;
    let ctx = guard
        .as_ref()
        .ok_or_else(|| Error::msg("S3 is not configured — open Settings first"))?;
    let object = ctx
        .client
        .get_object()
        .bucket(&ctx.bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| Error::msg(format!("download of {key} failed: {e}")))?;
    let bytes = object
        .body
        .collect()
        .await
        .map_err(|e| Error::msg(e.to_string()))?
        .into_bytes()
        .to_vec();
    drop(guard);

    protocol::cache_put(app, key, &bytes).await;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::encode_key;

    #[test]
    fn encode_key_matches_encode_uri_component() {
        assert_eq!(encode_key("inbox/photo.jpg"), "inbox/photo.jpg");
        assert_eq!(
            encode_key("my photos/café #1.jpg"),
            "my%20photos/caf%C3%A9%20%231.jpg"
        );
        assert_eq!(encode_key("a(1)!~*'/b_c-d.e"), "a(1)!~*'/b_c-d.e");
    }
}
