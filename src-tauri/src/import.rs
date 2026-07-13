//! Import orchestration: for each dropped file — catalog row, EXIF +
//! variants (pipeline), upload original + variants to S3, seed the local
//! photo cache, and stream progress to the frontend as `import://progress`
//! events. Replaces the old presign → browser PUT → confirm → BullMQ flow.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::OptionalExtension;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;

use crate::db::{self, Db, Photo, PHOTO_COLUMNS};
use crate::error::{Error, Result};
use crate::keys::{sanitize_filename, sanitize_folder};
use crate::pipeline::{self, ProcessedImage};
use crate::settings::S3State;
use crate::protocol;

/// Matches the old BullMQ worker's concurrency.
const IMPORT_CONCURRENCY: usize = 2;

pub const PROGRESS_EVENT: &str = "import://progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    /// Stable client key for matching upload tiles: "folder/filename".
    pub key: String,
    pub photo_id: Option<String>,
    pub filename: String,
    pub folder: String,
    /// 0–100.
    pub progress: u8,
    /// "starting" | "processing" | "uploading" | "done" | "error" | "cancelled"
    pub status: &'static str,
    pub error: Option<String>,
}

struct Reporter {
    app: AppHandle,
    key: String,
    filename: String,
    folder: String,
}

impl Reporter {
    fn emit(&self, photo_id: Option<&str>, progress: u8, status: &'static str, error: Option<String>) {
        let _ = self.app.emit(
            PROGRESS_EVENT,
            ImportProgress {
                key: self.key.clone(),
                photo_id: photo_id.map(str::to_string),
                filename: self.filename.clone(),
                folder: self.folder.clone(),
                progress,
                status,
                error,
            },
        );
    }
}

/// A registered import's cancel flag, tagged with the id of the import that
/// owns it so a finishing task never clears a newer re-import's entry.
struct CancelSlot {
    id: u64,
    flag: Arc<AtomicBool>,
}

/// Per-import cancellation flags, keyed by the stable "folder/filename" key the
/// frontend tiles and progress events use. Each running import registers a fresh
/// flag and removes it (via `CancelGuard`) when it finishes. `cancel` only sets
/// an already-registered flag — it never leaves one behind, so a cancel that
/// arrives after an import has finished can't silently kill a later import of
/// the same file.
#[derive(Default)]
pub struct CancelRegistry {
    slots: Mutex<HashMap<String, CancelSlot>>,
    next_id: AtomicU64,
}

impl CancelRegistry {
    /// Register a fresh cancel flag for `key`, replacing any prior entry, and
    /// return the owning id (for deregistration) and the flag.
    fn register(&self, key: &str) -> (u64, Arc<AtomicBool>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let flag = Arc::new(AtomicBool::new(false));
        self.slots
            .lock()
            .unwrap()
            .insert(key.to_string(), CancelSlot { id, flag: flag.clone() });
        (id, flag)
    }

    /// Signal cancellation for the import currently registered under `key`.
    /// A no-op if none is registered, so no armed flag is ever left dangling.
    pub fn cancel(&self, key: &str) {
        if let Some(slot) = self.slots.lock().unwrap().get(key) {
            slot.flag.store(true, Ordering::Relaxed);
        }
    }

    /// Remove `key`'s entry, but only if it still belongs to import `id` — a
    /// re-import may have already replaced it with its own flag.
    fn deregister(&self, key: &str, id: u64) {
        let mut slots = self.slots.lock().unwrap();
        if slots.get(key).is_some_and(|slot| slot.id == id) {
            slots.remove(key);
        }
    }
}

/// Drops an import's registry entry on every exit path (done, error, cancel),
/// but only its own — so the map never grows or holds a stale flag, and a
/// finishing import never clears a newer re-import's flag.
struct CancelGuard {
    app: AppHandle,
    key: String,
    id: u64,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.app.state::<CancelRegistry>().deregister(&self.key, self.id);
    }
}

pub async fn import_photos(app: AppHandle, paths: Vec<String>, folder: String) -> Result<Vec<Photo>> {
    let folder = sanitize_folder(&folder).ok_or_else(|| Error::msg("Invalid folder"))?;

    let importable: Vec<String> = paths.into_iter().filter(|p| pipeline::is_importable(p)).collect();
    if importable.is_empty() {
        return Ok(Vec::new());
    }

    let registry = app.state::<CancelRegistry>();
    let semaphore = Arc::new(Semaphore::new(IMPORT_CONCURRENCY));
    let mut handles = Vec::with_capacity(importable.len());
    for path in importable {
        // Derive the key up front and register the cancel flag before spawning,
        // so an item still queued on the semaphore can already be cancelled.
        let Some(filename) = sanitize_filename(
            std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy()).unwrap_or_default().as_ref(),
        ) else {
            continue;
        };
        let s3_key = format!("{folder}/{filename}");
        let (id, cancel) = registry.register(&s3_key);

        let app = app.clone();
        let folder = folder.clone();
        let semaphore = semaphore.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let _guard = CancelGuard { app: app.clone(), key: s3_key.clone(), id };
            let _permit = semaphore.acquire().await.expect("semaphore never closes");
            import_one(&app, &path, &folder, &filename, &s3_key, &cancel).await
        }));
    }

    let mut imported = Vec::new();
    for handle in handles {
        if let Ok(Some(photo)) = handle.await.map_err(|e| Error::msg(e.to_string())) {
            imported.push(photo);
        }
    }
    Ok(imported)
}

/// The catalog state a re-import overwrites, captured before the upsert so a
/// cancel can put the pre-existing photo back exactly as it was.
#[derive(Clone)]
struct PriorRow {
    processing_status: String,
    mime_type: Option<String>,
    file_size: i64,
}

/// The successful/cancelled outcomes of `run_import`; failures come back as the
/// `Err` arm so the `?` operator still handles them.
enum Imported {
    Done(Photo),
    Cancelled(Cancellation),
}

/// How a cancelled import must be undone. A fresh import created its row and
/// objects, so they're removed wholesale; a re-import reused an existing photo's
/// row, so that row is restored and its objects are left untouched — cancelling
/// a re-import must never destroy the photo that was already there.
enum Cancellation {
    Fresh { photo_id: String },
    Existing { photo_id: String, prior: PriorRow },
}

/// Imports a single file. Failures are reported via events (and the catalog
/// row is marked failed); a cancellation cleans up any partial work. The
/// returned Option is None for both so one bad or cancelled file never aborts
/// the batch.
async fn import_one(
    app: &AppHandle,
    path: &str,
    folder: &str,
    filename: &str,
    s3_key: &str,
    cancel: &AtomicBool,
) -> Option<Photo> {
    let reporter = Reporter {
        app: app.clone(),
        key: s3_key.to_string(),
        filename: filename.to_string(),
        folder: folder.to_string(),
    };

    // Cancelled while queued on the semaphore — no row or object exists yet.
    if cancel.load(Ordering::Relaxed) {
        reporter.emit(None, 100, "cancelled", None);
        return None;
    }

    reporter.emit(None, 0, "starting", None);

    match run_import(app, path, folder, filename, s3_key, &reporter, cancel).await {
        Ok(Imported::Done(photo)) => {
            reporter.emit(Some(&photo.id), 100, "done", None);
            crate::manifest::schedule_upload(app);
            Some(photo)
        }
        Ok(Imported::Cancelled(cancellation)) => {
            let photo_id = match cancellation {
                // A fresh import owns everything it made — remove it wholesale.
                Cancellation::Fresh { photo_id } => {
                    cleanup_cancelled(app, &photo_id, s3_key).await;
                    photo_id
                }
                // A re-import reused an existing photo's row — restore it and
                // leave its objects alone so the original photo survives.
                Cancellation::Existing { photo_id, prior } => {
                    restore_existing(app, &photo_id, &prior);
                    crate::manifest::schedule_upload(app);
                    photo_id
                }
            };
            reporter.emit(Some(&photo_id), 100, "cancelled", None);
            None
        }
        Err((photo_id, err)) => {
            if let Some(id) = &photo_id {
                mark_failed(app, id);
            }
            reporter.emit(photo_id.as_deref(), 100, "error", Some(err.to_string()));
            None
        }
    }
}

type ImportError = (Option<String>, Error);

async fn run_import(
    app: &AppHandle,
    path: &str,
    folder: &str,
    filename: &str,
    s3_key: &str,
    reporter: &Reporter,
    cancel: &AtomicBool,
) -> std::result::Result<Imported, ImportError> {
    // Refuse to touch a bucket the catalog wasn't built from, before this
    // import creates any catalog rows (an empty catalog binds here).
    {
        let state = app.state::<S3State>();
        let guard = state.0.read().await;
        let ctx = guard
            .as_ref()
            .ok_or_else(|| (None, Error::msg("S3 is not configured — open Settings first")))?;
        crate::settings::ensure_catalog_matches_bucket(app, ctx).map_err(|e| (None, e))?;
    }

    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| (None, Error::msg(format!("could not read {path}: {e}"))))?;
    let mime = pipeline::mime_for_extension(filename);
    let file_size = bytes.len() as i64;

    // Upsert the catalog row first (mirrors the old /api/upload behavior on
    // folder+filename conflicts) so a re-import of the same name replaces.
    // `prior` is the pre-existing row's restorable state (None for a brand-new
    // row), which decides how a later cancel unwinds this import.
    let (photo_id, prior) = upsert_row(app, folder, filename, s3_key, mime, file_size)
        .map_err(|e| (None, e))?;
    let fail = |e: Error| (Some(photo_id.clone()), e);
    // Built fresh at each checkpoint so a cancel deletes a new photo but only
    // restores an existing one.
    let cancelled = || match &prior {
        None => Imported::Cancelled(Cancellation::Fresh { photo_id: photo_id.clone() }),
        Some(prior) => Imported::Cancelled(Cancellation::Existing {
            photo_id: photo_id.clone(),
            prior: prior.clone(),
        }),
    };

    // Cancelled before we spend CPU on processing.
    if cancel.load(Ordering::Relaxed) {
        return Ok(cancelled());
    }

    set_status(app, &photo_id, "processing").map_err(fail)?;
    reporter.emit(Some(&photo_id), 10, "processing", None);

    // EXIF + all six variants; CPU-bound, so off the async threads. This can't
    // be interrupted mid-run, so we check for cancellation on either side.
    let processed: ProcessedImage = {
        let bytes = bytes.clone();
        let s3_key = s3_key.to_string();
        tauri::async_runtime::spawn_blocking(move || pipeline::process(&bytes, &s3_key))
            .await
            .map_err(|e| fail(Error::msg(e.to_string())))?
            .map_err(fail)?
    };
    reporter.emit(Some(&photo_id), 40, "uploading", None);

    // Cancelled after processing, before anything reaches the bucket. This is
    // the last point a re-import can cancel — past the first PUT its original
    // object is overwritten, so from here on only fresh imports honor cancel.
    if cancel.load(Ordering::Relaxed) {
        return Ok(cancelled());
    }

    // Upload original + variants. Progress: 40 → 96 across 1 + 6 puts.
    {
        let state = app.state::<S3State>();
        let guard = state.0.read().await;
        let ctx = guard
            .as_ref()
            .ok_or_else(|| fail(Error::msg("S3 is not configured — open Settings first")))?;

        put_object(ctx, s3_key, bytes, mime.unwrap_or("application/octet-stream"), false)
            .await
            .map_err(fail)?;
        reporter.emit(Some(&photo_id), 48, "uploading", None);

        for (index, variant) in processed.variants.iter().enumerate() {
            // Only a fresh import can still cancel here: the original object has
            // already been overwritten, so a re-import commits to finishing
            // rather than leave the photo half-replaced. A fresh import's
            // partial objects are cleaned up instead.
            if prior.is_none() && cancel.load(Ordering::Relaxed) {
                return Ok(cancelled());
            }
            put_object(ctx, &variant.key, variant.bytes.clone(), variant.content_type, true)
                .await
                .map_err(fail)?;
            reporter.emit(
                Some(&photo_id),
                48 + (8 * (index as u8 + 1)),
                "uploading",
                None,
            );
        }
    }

    // Seed the local cache so the grid renders instantly without a refetch.
    for variant in &processed.variants {
        protocol::cache_put(app, &variant.key, &variant.bytes).await;
    }

    finalize_row(app, &photo_id, &processed).map_err(fail)?;
    let photo = load_photo(app, &photo_id).map_err(|e| (Some(photo_id.clone()), e))?;
    Ok(Imported::Done(photo))
}

/// Undo a cancelled import: best-effort remove any objects that reached the
/// bucket and any cached files, then drop the catalog row. Stays quiet — a
/// variant may never have been uploaded, and S3 may be unconfigured.
async fn cleanup_cancelled(app: &AppHandle, photo_id: &str, s3_key: &str) {
    let base = crate::keys::base_key(s3_key).to_string();
    let mut keys = vec![s3_key.to_string()];
    keys.extend(crate::keys::variant_suffixes().iter().map(|suffix| format!("{base}{suffix}")));

    {
        let state = app.state::<S3State>();
        let guard = state.0.read().await;
        if let Some(ctx) = guard.as_ref() {
            for key in &keys {
                let _ = ctx.client.delete_object().bucket(&ctx.bucket).key(key).send().await;
            }
        }
    }

    for key in &keys {
        let _ = tokio::fs::remove_file(protocol::cache_path(app, key)).await;
    }

    {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        let _ = conn.execute("DELETE FROM photos WHERE id = ?1", rusqlite::params![photo_id]);
    }

    crate::manifest::schedule_upload(app);
}

async fn put_object(
    ctx: &crate::settings::S3Ctx,
    key: &str,
    bytes: Vec<u8>,
    content_type: &str,
    immutable: bool,
) -> Result<()> {
    let mut request = ctx
        .client
        .put_object()
        .bucket(&ctx.bucket)
        .key(key)
        .content_type(content_type)
        .body(bytes.into());
    if immutable {
        request = request.cache_control("public, max-age=31536000");
    }
    request.send().await.map_err(|e| {
        Error::msg(format!(
            "upload of {key} failed: {}",
            aws_smithy_types::error::display::DisplayErrorContext(&e)
        ))
    })?;
    Ok(())
}

/// Upsert the catalog row, returning its id and — when the row already existed —
/// the restorable state it held before this import overwrote it. That `prior`
/// lets a cancelled re-import put the pre-existing photo back instead of
/// deleting it.
fn upsert_row(
    app: &AppHandle,
    folder: &str,
    filename: &str,
    s3_key: &str,
    mime: Option<&str>,
    file_size: i64,
) -> Result<(String, Option<PriorRow>)> {
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
    upsert_row_conn(&conn, folder, filename, s3_key, mime, file_size)
}

fn upsert_row_conn(
    conn: &rusqlite::Connection,
    folder: &str,
    filename: &str,
    s3_key: &str,
    mime: Option<&str>,
    file_size: i64,
) -> Result<(String, Option<PriorRow>)> {
    // Read the prior row (if any) before the upsert clobbers it.
    let prior = conn
        .query_row(
            "SELECT processing_status, mime_type, file_size FROM photos WHERE folder = ?1 AND filename = ?2",
            rusqlite::params![folder, filename],
            |row| {
                Ok(PriorRow {
                    processing_status: row.get(0)?,
                    mime_type: row.get(1)?,
                    file_size: row.get(2)?,
                })
            },
        )
        .optional()?;
    let id: String = conn.query_row(
        "INSERT INTO photos (id, filename, s3_key, folder, mime_type, file_size, processing_status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7)
         ON CONFLICT (folder, filename) DO UPDATE SET
           mime_type = excluded.mime_type,
           file_size = excluded.file_size,
           processing_status = 'pending',
           updated_at = excluded.updated_at
         RETURNING id",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            filename,
            s3_key,
            folder,
            mime,
            file_size,
            db::now(),
        ],
        |row| row.get(0),
    )?;
    Ok((id, prior))
}

/// Put a re-imported photo's row back the way it was before a cancelled import
/// touched it. Only reached when the cancel landed before the first PUT, so the
/// bucket still holds the original objects — restoring the metadata (and,
/// crucially, the prior processing_status) makes the photo whole again.
fn restore_existing(app: &AppHandle, photo_id: &str, prior: &PriorRow) {
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
    restore_row_conn(&conn, photo_id, prior);
}

fn restore_row_conn(conn: &rusqlite::Connection, photo_id: &str, prior: &PriorRow) {
    let _ = conn.execute(
        "UPDATE photos SET processing_status = ?1, mime_type = ?2, file_size = ?3, updated_at = ?4 WHERE id = ?5",
        rusqlite::params![
            prior.processing_status,
            prior.mime_type,
            prior.file_size,
            db::now(),
            photo_id,
        ],
    );
}

fn set_status(app: &AppHandle, photo_id: &str, status: &str) -> Result<()> {
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
    conn.execute(
        "UPDATE photos SET processing_status = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![status, db::now(), photo_id],
    )?;
    Ok(())
}

fn mark_failed(app: &AppHandle, photo_id: &str) {
    let _ = set_status(app, photo_id, "failed");
}

fn finalize_row(app: &AppHandle, photo_id: &str, processed: &ProcessedImage) -> Result<()> {
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
    let exif = &processed.exif;
    conn.execute(
        "UPDATE photos SET
           width = ?1, height = ?2, processing_status = 'completed',
           camera_make = ?3, camera_model = ?4, lens = ?5, focal_length = ?6,
           aperture = ?7, shutter_speed = ?8, iso = ?9, taken_at = ?10,
           gps_latitude = ?11, gps_longitude = ?12, updated_at = ?13
         WHERE id = ?14",
        rusqlite::params![
            processed.width,
            processed.height,
            exif.camera_make,
            exif.camera_model,
            exif.lens,
            exif.focal_length,
            exif.aperture,
            exif.shutter_speed,
            exif.iso,
            exif.taken_at,
            exif.gps_latitude,
            exif.gps_longitude,
            db::now(),
            photo_id,
        ],
    )?;
    Ok(())
}

fn load_photo(app: &AppHandle, photo_id: &str) -> Result<Photo> {
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
    let photo = conn.query_row(
        &format!("SELECT {PHOTO_COLUMNS} FROM photos WHERE id = ?1"),
        rusqlite::params![photo_id],
        db::photo_from_row,
    )?;
    Ok(photo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_flips_the_registered_flag() {
        let reg = CancelRegistry::default();
        let (_id, flag) = reg.register("inbox/a.jpg");
        assert!(!flag.load(Ordering::Relaxed));
        // Cancelling flips the flag the running task is watching.
        reg.cancel("inbox/a.jpg");
        assert!(flag.load(Ordering::Relaxed));
    }

    #[test]
    fn cancel_without_a_registration_leaves_no_stale_flag() {
        let reg = CancelRegistry::default();
        // A cancel that arrives with nothing registered is a no-op...
        reg.cancel("inbox/a.jpg");
        // ...so the next import of the same file starts uncancelled, rather than
        // being silently discarded by a leftover armed flag.
        let (_id, flag) = reg.register("inbox/a.jpg");
        assert!(!flag.load(Ordering::Relaxed));
    }

    #[test]
    fn deregister_only_removes_its_own_generation() {
        let reg = CancelRegistry::default();
        let (id_a, _flag_a) = reg.register("inbox/a.jpg");
        // A re-import replaces the entry with its own fresh flag.
        let (_id_b, flag_b) = reg.register("inbox/a.jpg");
        // The first import finishing must not clear the re-import's flag.
        reg.deregister("inbox/a.jpg", id_a);
        reg.cancel("inbox/a.jpg");
        assert!(flag_b.load(Ordering::Relaxed));
    }

    #[test]
    fn deregister_clears_the_current_entry() {
        let reg = CancelRegistry::default();
        let (id, _flag) = reg.register("inbox/a.jpg");
        reg.deregister("inbox/a.jpg", id);
        // Nothing is registered now, so a late cancel can't arm a stale flag.
        reg.cancel("inbox/a.jpg");
        let (_id2, flag2) = reg.register("inbox/a.jpg");
        assert!(!flag2.load(Ordering::Relaxed));
    }

    #[test]
    fn upsert_of_a_new_name_reports_no_prior_state() {
        let conn = crate::db::open_in_memory();
        let (_id, prior) =
            upsert_row_conn(&conn, "inbox", "new.jpg", "inbox/new.jpg", Some("image/jpeg"), 10)
                .unwrap();
        // A brand-new row means a cancel is safe to delete wholesale.
        assert!(prior.is_none());
    }

    #[test]
    fn re_importing_captures_prior_state_so_a_cancel_can_restore_it() {
        let conn = crate::db::open_in_memory();
        conn.execute(
            "INSERT INTO photos (id, filename, s3_key, folder, mime_type, file_size, processing_status, created_at, updated_at)
             VALUES ('p1', 'a.jpg', 'inbox/a.jpg', 'inbox', 'image/jpeg', 111, 'completed', ?1, ?1)",
            rusqlite::params![crate::db::now()],
        )
        .unwrap();

        // Re-importing the same folder/filename reuses the row and reports the
        // state it held before, while flipping it to 'pending' with new metadata.
        let (id, prior) =
            upsert_row_conn(&conn, "inbox", "a.jpg", "inbox/a.jpg", Some("image/png"), 222).unwrap();
        assert_eq!(id, "p1");
        let prior = prior.expect("an existing row must report prior state");
        assert_eq!(prior.processing_status, "completed");
        assert_eq!(prior.file_size, 111);
        assert_eq!(prior.mime_type.as_deref(), Some("image/jpeg"));
        let mid: String = conn
            .query_row("SELECT processing_status FROM photos WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mid, "pending");

        // Cancelling restores the pre-existing photo exactly — no data loss.
        restore_row_conn(&conn, &id, &prior);
        let (status, mime, size): (String, Option<String>, i64) = conn
            .query_row(
                "SELECT processing_status, mime_type, file_size FROM photos WHERE id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "completed");
        assert_eq!(mime.as_deref(), Some("image/jpeg"));
        assert_eq!(size, 111);
    }
}
