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
use crate::keys::{base_key, sanitize_filename, sanitize_folder, variant_base, variant_suffixes};
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

/// Best-effort batch delete, chunked to DeleteObjects' 1000-key limit.
async fn s3_delete_keys_quiet(ctx: &S3Ctx, keys: &[String]) {
    for chunk in keys.chunks(1000) {
        let _ = s3_delete_many(ctx, chunk).await;
    }
}

/// Every bucket key the catalog currently references under the two folder
/// names a rename touches: each row's object plus all the variant keys it may
/// own. Rename sweeps consult this at delete time because a concurrent import
/// or move can claim a key mid-rename (the target folder has no catalog rows
/// until commit, so nothing stops it): deleting such a key would destroy the
/// only copy behind a live row — real loss, not an orphan.
fn keys_referenced_under(
    conn: &rusqlite::Connection,
    folders: [&str; 2],
) -> Result<HashSet<String>> {
    let mut stmt =
        conn.prepare("SELECT s3_key FROM photos WHERE folder = ?1 OR folder = ?2")?;
    let keys = stmt.query_map(rusqlite::params![folders[0], folders[1]], |row| {
        row.get::<_, String>(0)
    })?;
    let mut referenced = HashSet::new();
    for key in keys {
        let key = key?;
        let base = base_key(&key).to_string();
        for suffix in variant_suffixes() {
            referenced.insert(format!("{base}{suffix}"));
        }
        referenced.insert(key);
    }
    Ok(referenced)
}

/// Best-effort sweep of a rename's leftover objects, skipping any key the
/// catalog references by now (see keys_referenced_under). If the referenced-
/// keys query itself fails, skip the whole sweep: orphaned objects are
/// recoverable, a deleted original isn't.
async fn sweep_rename_leftovers(
    app: &AppHandle,
    ctx: &S3Ctx,
    folders: [&str; 2],
    candidates: Vec<String>,
) {
    let referenced = {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        match keys_referenced_under(&conn, folders) {
            Ok(referenced) => referenced,
            Err(_) => return,
        }
    };
    let keys: Vec<String> = candidates
        .into_iter()
        .filter(|key| !referenced.contains(key))
        .collect();
    s3_delete_keys_quiet(ctx, &keys).await;
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
    // objects before the DB unique constraint had a chance to complain. The
    // check is by variant stem, not exact name: "photo.png", "photo.jpg" and
    // legacy "photo_original.jpg" all own the same derivative objects.
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        let occupant = db::variant_stem_occupant(&conn, &new_folder, &new_filename)?;
        if occupant.is_some_and(|other| other != id) {
            return Err(Error::msg(
                "A photo with a conflicting name already exists in the target folder",
            ));
        }
    }

    let old_base = variant_base(&photo.s3_key).to_string();
    let new_base = variant_base(&new_s3_key).to_string();

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

/// Guard a folder rename's names: refuses renaming inbox (imports default
/// into it, so it would immediately reappear), sanitizes the target, and
/// returns None when the rename is a no-op.
fn validate_folder_rename(old: &str, new: &str) -> Result<Option<String>> {
    if old == "inbox" {
        return Err(Error::msg("The inbox folder can't be renamed"));
    }
    let new = sanitize_folder(new).ok_or_else(|| Error::msg("Invalid folder name"))?;
    if new == old {
        return Ok(None);
    }
    Ok(Some(new))
}

/// The photos a folder rename would move, or why it can't proceed. Runs
/// against the catalog only, so the S3 work starts from a validated plan.
fn plan_folder_rename(
    conn: &rusqlite::Connection,
    old: &str,
    new: &str,
) -> Result<Vec<Photo>> {
    let occupied: i64 = conn.query_row(
        "SELECT COUNT(*) FROM photos WHERE folder = ?1",
        rusqlite::params![new],
        |row| row.get(0),
    )?;
    if occupied > 0 {
        return Err(Error::msg("A folder with that name already exists"));
    }
    // An in-flight import owns its old-prefix keys (its objects may not exist
    // yet, and its pipeline keeps writing to them), so renaming around it can
    // only end badly. The UI disables Rename during uploads; this backs it up.
    let importing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM photos
         WHERE folder = ?1 AND processing_status IN ('pending', 'processing')",
        rusqlite::params![old],
        |row| row.get(0),
    )?;
    if importing > 0 {
        return Err(Error::msg(
            "Photos are still importing into this folder — wait for them to finish",
        ));
    }
    let mut stmt =
        conn.prepare(&format!("SELECT {PHOTO_COLUMNS} FROM photos WHERE folder = ?1"))?;
    let photos = stmt
        .query_map(rusqlite::params![old], db::photo_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if photos.is_empty() {
        return Err(Error::msg("Folder not found"));
    }
    Ok(photos)
}

/// Flip the snapshot's rows to the new folder in a single transaction,
/// re-checking the collision guard first (an import may have raced the copy
/// phase). Scoped to the snapshot — not `WHERE folder = old` — so a row only
/// flips if its objects were actually copied: each UPDATE also requires the
/// photo's s3_key to be unchanged, which skips photos moved, renamed, or
/// deleted mid-copy, and photos added to the folder mid-rename simply stay
/// behind under the old name. Either the whole batch commits or none of it.
fn commit_folder_rename(
    conn: &mut rusqlite::Connection,
    new: &str,
    snapshot: &[Photo],
) -> Result<usize> {
    let tx = conn.transaction()?;
    let occupied: i64 = tx.query_row(
        "SELECT COUNT(*) FROM photos WHERE folder = ?1",
        rusqlite::params![new],
        |row| row.get(0),
    )?;
    if occupied > 0 {
        return Err(Error::msg("A folder with that name already exists"));
    }
    let now = db::now();
    let mut moved = 0;
    for photo in snapshot {
        moved += tx.execute(
            "UPDATE photos SET folder = ?1, s3_key = ?1 || '/' || filename, updated_at = ?2
             WHERE id = ?3 AND s3_key = ?4",
            rusqlite::params![new, now, photo.id, photo.s3_key],
        )?;
    }
    tx.commit()?;
    Ok(moved)
}

/// Rename a folder by re-keying every photo in it. S3 has no cross-object
/// transaction, so update_photo's copy-first discipline applies, scaled up:
/// copy everything to the new keys (aborting — and sweeping the copies — if
/// any original fails), flip all catalog rows in one SQLite transaction, then
/// best-effort delete the old objects. The catalog is what the UI reads, so
/// the folder never appears half-renamed; the worst a partial failure leaves
/// behind is orphaned bucket objects. Returns the number of photos moved.
pub async fn rename_folder(app: AppHandle, old_name: String, new_name: String) -> Result<usize> {
    let Some(new_name) = validate_folder_rename(&old_name, &new_name)? else {
        return Ok(0); // same name — nothing to do
    };

    let photos = {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        plan_folder_rename(&conn, &old_name, &new_name)?
    };

    let ctx = {
        let state = app.state::<S3State>();
        let guard = state.0.read().await;
        let ctx = guard
            .as_ref()
            .ok_or_else(|| Error::msg("S3 is not configured — open Settings first"))?;
        crate::settings::ensure_catalog_matches_bucket(&app, ctx)?;
        std::sync::Arc::new(ctx.clone())
    };

    // Copy phase, fanned out with bounded concurrency (a folder is up to nine
    // objects per photo). A photo's original failing to copy is fatal; a
    // missing variant isn't (it may still be processing), matching
    // update_photo. Each task reports the (old, new) pairs it actually
    // created, so failure cleanup and the delete phase touch only real
    // objects.
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(16));
    let mut tasks = tokio::task::JoinSet::new();
    for photo in &photos {
        let ctx = ctx.clone();
        let semaphore = semaphore.clone();
        let old_key = photo.s3_key.clone();
        let new_key = format!("{new_name}/{}", photo.filename);
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.expect("semaphore closed");
            s3_copy(&ctx, &old_key, &new_key).await?;
            let old_base = base_key(&old_key).to_string();
            let new_base = base_key(&new_key).to_string();
            let mut pairs = vec![(old_key, new_key)];
            for suffix in variant_suffixes() {
                let from = format!("{old_base}{suffix}");
                let to = format!("{new_base}{suffix}");
                if s3_copy(&ctx, &from, &to).await.is_ok() {
                    pairs.push((from, to));
                }
            }
            Ok::<_, Error>(pairs)
        });
    }

    // Let every task finish even after a failure — aborting mid-copy would
    // lose track of which new keys were created and orphan them.
    let mut copied: Vec<(String, String)> = Vec::new();
    let mut failure: Option<Error> = None;
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok(Ok(pairs)) => copied.extend(pairs),
            Ok(Err(e)) => {
                failure.get_or_insert(e);
            }
            Err(e) => {
                failure.get_or_insert(Error::msg(e.to_string()));
            }
        }
    }

    let folders = [old_name.as_str(), new_name.as_str()];

    if let Some(e) = failure {
        // Leave the old folder fully intact: sweep whatever the successful
        // tasks copied and report the failure.
        let new_keys: Vec<String> = copied.iter().map(|(_, to)| to.clone()).collect();
        sweep_rename_leftovers(&app, &ctx, folders, new_keys).await;
        return Err(e);
    }

    let commit = {
        let db = app.state::<Db>();
        let mut conn = db.0.lock().unwrap();
        commit_folder_rename(&mut conn, &new_name, &photos)
    };
    let moved = match commit {
        Ok(moved) => moved,
        Err(e) => {
            // The collision re-check failing means something raced into the
            // target folder mid-copy — its rows may reference keys we copied,
            // which is exactly what the sweep filter protects.
            let new_keys: Vec<String> = copied.iter().map(|(_, to)| to.clone()).collect();
            sweep_rename_leftovers(&app, &ctx, folders, new_keys).await;
            return Err(e);
        }
    };

    // The catalog now points at the new keys, so old-object deletes are
    // best-effort — a failure here only leaves orphans behind. Still filtered:
    // an import can reserve a just-vacated old name post-commit.
    let old_keys: Vec<String> = copied.iter().map(|(from, _)| from.clone()).collect();
    sweep_rename_leftovers(&app, &ctx, folders, old_keys).await;
    for (from, to) in &copied {
        rename_cached(&app, from, to).await;
    }

    crate::manifest::schedule_upload(&app);
    Ok(moved)
}

/// Delete a photo, its variants, its catalog row (cascading to tags), and
/// any cached files.
pub async fn delete_photo(app: AppHandle, id: String) -> Result<()> {
    let photo = get_photo(&app, &id)?;
    let base = variant_base(&photo.s3_key).to_string();

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
                format!("{}_{resolution}.jpg", variant_base(&photo.s3_key)),
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
/// photo:// protocol). Also used by the refresh backfill to pull originals.
pub(crate) async fn fetch_bytes(app: &AppHandle, key: &str) -> Result<Vec<u8>> {
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
        // A bare `e.to_string()` here reads "streaming error" with no clue
        // which file or why — name the object and keep the cause chain.
        .map_err(|e| {
            Error::msg(format!(
                "download of {key} was interrupted: {}",
                aws_smithy_types::error::display::DisplayErrorContext(&e)
            ))
        })?
        .into_bytes()
        .to_vec();
    drop(guard);

    protocol::cache_put(app, key, &bytes).await;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{
        commit_folder_rename, encode_key, keys_referenced_under, plan_folder_rename,
        validate_folder_rename,
    };
    use crate::db;
    use rusqlite::{params, Connection};

    #[test]
    fn encode_key_matches_encode_uri_component() {
        assert_eq!(encode_key("inbox/photo.jpg"), "inbox/photo.jpg");
        assert_eq!(
            encode_key("my photos/café #1.jpg"),
            "my%20photos/caf%C3%A9%20%231.jpg"
        );
        assert_eq!(encode_key("a(1)!~*'/b_c-d.e"), "a(1)!~*'/b_c-d.e");
    }

    fn insert_photo(conn: &Connection, id: &str, folder: &str, filename: &str) {
        insert_photo_with_status(conn, id, folder, filename, "completed");
    }

    fn insert_photo_with_status(
        conn: &Connection,
        id: &str,
        folder: &str,
        filename: &str,
        status: &str,
    ) {
        conn.execute(
            "INSERT INTO photos (id, filename, s3_key, folder, processing_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, filename, format!("{folder}/{filename}"), folder, status, db::now()],
        )
        .unwrap();
    }

    #[test]
    fn validate_folder_rename_guards_names() {
        // inbox is the import default; renaming it would only see it reappear
        let err = validate_folder_rename("inbox", "archive").unwrap_err();
        assert!(err.to_string().contains("inbox"));

        assert!(validate_folder_rename("trips", "a/b").is_err());
        assert!(validate_folder_rename("trips", "  ").is_err());
        assert!(validate_folder_rename("trips", "..").is_err());

        // Same name (after trimming) is a no-op, not an error
        assert_eq!(validate_folder_rename("trips", " trips ").unwrap(), None);

        assert_eq!(
            validate_folder_rename("trips", " voyages ").unwrap(),
            Some("voyages".to_string())
        );
    }

    #[test]
    fn plan_folder_rename_rejects_missing_source_and_taken_target() {
        let conn = db::open_in_memory();
        insert_photo(&conn, "a", "trips", "a.jpg");
        insert_photo(&conn, "b", "trips", "b.jpg");
        insert_photo(&conn, "c", "beach", "c.jpg");

        let err = plan_folder_rename(&conn, "trips", "beach").unwrap_err();
        assert!(err.to_string().contains("already exists"));

        let err = plan_folder_rename(&conn, "nope", "elsewhere").unwrap_err();
        assert!(err.to_string().contains("not found"));

        let photos = plan_folder_rename(&conn, "trips", "voyages").unwrap();
        assert_eq!(photos.len(), 2);
        assert!(photos.iter().all(|p| p.folder == "trips"));
    }

    #[test]
    fn plan_folder_rename_refuses_folders_with_imports_in_flight() {
        let conn = db::open_in_memory();
        insert_photo(&conn, "a", "trips", "a.jpg");
        insert_photo_with_status(&conn, "b", "trips", "b.jpg", "pending");

        let err = plan_folder_rename(&conn, "trips", "voyages").unwrap_err();
        assert!(err.to_string().contains("still importing"));

        // Once the import settles the rename can proceed; failed imports
        // don't hold the folder hostage
        conn.execute(
            "UPDATE photos SET processing_status = 'failed' WHERE id = 'b'",
            [],
        )
        .unwrap();
        assert!(plan_folder_rename(&conn, "trips", "voyages").is_ok());
    }

    #[test]
    fn keys_referenced_under_shields_raced_rows_and_their_variants() {
        let conn = db::open_in_memory();
        // An import raced into the rename's target folder mid-copy
        insert_photo(&conn, "raced", "voyages", "a.jpg");
        // Unrelated folders don't shield anything
        insert_photo(&conn, "other", "beach", "c.jpg");

        let referenced = keys_referenced_under(&conn, ["trips", "voyages"]).unwrap();

        // The raced photo's object and every variant it may own are shielded,
        // so the rename's sweep of its copied "voyages/a.*" keys skips them
        assert!(referenced.contains("voyages/a.jpg"));
        assert!(referenced.contains("voyages/a_640.webp"));
        assert!(referenced.contains("voyages/a_2880.jpg"));
        assert!(referenced.contains("voyages/a_128.jpg"));

        // Keys nothing references stay sweepable
        assert!(!referenced.contains("voyages/b.jpg"));
        assert!(!referenced.contains("beach/c.jpg"));
    }

    #[test]
    fn commit_folder_rename_flips_folder_and_s3_key_atomically() {
        let mut conn = db::open_in_memory();
        insert_photo(&conn, "a", "trips", "a.jpg");
        insert_photo(&conn, "b", "trips", "b.jpg");

        let snapshot = plan_folder_rename(&conn, "trips", "voyages").unwrap();
        let moved = commit_folder_rename(&mut conn, "voyages", &snapshot).unwrap();
        assert_eq!(moved, 2);

        let keys: Vec<(String, String)> = conn
            .prepare("SELECT folder, s3_key FROM photos ORDER BY filename")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            keys,
            vec![
                ("voyages".into(), "voyages/a.jpg".into()),
                ("voyages".into(), "voyages/b.jpg".into()),
            ]
        );
    }

    #[test]
    fn commit_folder_rename_rechecks_collision_and_rolls_back() {
        let mut conn = db::open_in_memory();
        insert_photo(&conn, "a", "trips", "a.jpg");
        let snapshot = plan_folder_rename(&conn, "trips", "voyages").unwrap();

        // Simulates an import racing into the target between plan and commit
        insert_photo(&conn, "b", "voyages", "b.jpg");

        let err = commit_folder_rename(&mut conn, "voyages", &snapshot).unwrap_err();
        assert!(err.to_string().contains("already exists"));

        // Nothing moved: the source row is untouched
        let folder: String = conn
            .query_row("SELECT folder FROM photos WHERE id = 'a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(folder, "trips");
    }

    #[test]
    fn commit_folder_rename_leaves_photos_added_mid_rename_behind() {
        let mut conn = db::open_in_memory();
        insert_photo(&conn, "a", "trips", "a.jpg");
        let snapshot = plan_folder_rename(&conn, "trips", "voyages").unwrap();

        // Uploaded into the folder during the copy phase — its objects were
        // never copied, so it must not be flipped to keys that don't exist
        insert_photo(&conn, "late", "trips", "late.jpg");

        let moved = commit_folder_rename(&mut conn, "voyages", &snapshot).unwrap();
        assert_eq!(moved, 1);

        let (folder, s3_key): (String, String) = conn
            .query_row(
                "SELECT folder, s3_key FROM photos WHERE id = 'late'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(folder, "trips");
        assert_eq!(s3_key, "trips/late.jpg");
    }

    #[test]
    fn commit_folder_rename_skips_photos_changed_mid_rename() {
        let mut conn = db::open_in_memory();
        insert_photo(&conn, "a", "trips", "a.jpg");
        insert_photo(&conn, "b", "trips", "b.jpg");
        insert_photo(&conn, "c", "trips", "c.jpg");
        let snapshot = plan_folder_rename(&conn, "trips", "voyages").unwrap();

        // During the copy phase: "a" was moved to another folder, "b" was
        // renamed in place, "c" was deleted. Their copied objects no longer
        // match the rows, so none of them may flip.
        conn.execute(
            "UPDATE photos SET folder = 'beach', s3_key = 'beach/a.jpg' WHERE id = 'a'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE photos SET filename = 'b2.jpg', s3_key = 'trips/b2.jpg' WHERE id = 'b'",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM photos WHERE id = 'c'", []).unwrap();

        let moved = commit_folder_rename(&mut conn, "voyages", &snapshot).unwrap();
        assert_eq!(moved, 0);

        let a: String = conn
            .query_row("SELECT folder FROM photos WHERE id = 'a'", [], |r| r.get(0))
            .unwrap();
        let b: String = conn
            .query_row("SELECT s3_key FROM photos WHERE id = 'b'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(a, "beach");
        assert_eq!(b, "trips/b2.jpg");
    }
}
