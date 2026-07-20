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
use crate::error::{friendly_s3_error, Error, Result};
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

    match run_import(app, path, folder, filename, &reporter, cancel).await {
        Ok(Imported::Done(photo)) => {
            reporter.emit(Some(&photo.id), 100, "done", None);
            crate::manifest::schedule_upload(app);
            Some(photo)
        }
        Ok(Imported::Cancelled(cancellation)) => {
            let photo_id = match cancellation {
                // A fresh import owns everything it made — remove it wholesale.
                Cancellation::Fresh { photo_id } => {
                    cleanup_cancelled(app, &photo_id).await;
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

    // Reserve the catalog row, resolving the actual filename/S3 key this import
    // stores under. It never overwrites a completed or in-flight photo — a name
    // collision is suffixed ("photo (2).jpg") — but reuses a `failed` row as a
    // retry. `prior` is that reused row's restorable state (None for a fresh
    // row), which decides how a later cancel unwinds this import. The stored
    // key can differ from `reporter.key` (the original "folder/filename" the
    // frontend tile matches on); everything below uses the resolved key.
    let Reserved { id: photo_id, s3_key, prior } =
        reserve_row(app, folder, filename, mime, file_size).map_err(|e| (None, e))?;
    let s3_key = s3_key.as_str();
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
async fn cleanup_cancelled(app: &AppHandle, photo_id: &str) {
    // Read the key the row was actually stored under (a collision may have
    // suffixed it) so we delete this import's own objects, not the original's.
    let s3_key: Option<String> = {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        conn.query_row(
            "SELECT s3_key FROM photos WHERE id = ?1",
            rusqlite::params![photo_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    };

    let keys: Vec<String> = s3_key.map(|key| deletion_keys(&key)).unwrap_or_default();

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

/// Every object an import may have created for `s3_key`: the original plus
/// all possible variants. Variants hang off `variant_base` (which strips a
/// legacy `_original` stem marker), matching where the pipeline uploads them.
fn deletion_keys(s3_key: &str) -> Vec<String> {
    let base = crate::keys::variant_base(s3_key).to_string();
    let mut keys = vec![s3_key.to_string()];
    keys.extend(crate::keys::variant_suffixes().iter().map(|suffix| format!("{base}{suffix}")));
    keys
}

pub(crate) async fn put_object(
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
    request
        .send()
        .await
        .map_err(|e| Error::msg(format!("upload of {key} failed: {}", friendly_s3_error(&e))))?;
    Ok(())
}

/// The row a reservation resolved to: its id, the (possibly suffixed) S3 key it
/// will actually be stored under (the filename is its tail), and — when a prior
/// `failed` row was reused — the state it held before this import overwrote it.
struct Reserved {
    id: String,
    s3_key: String,
    prior: Option<PriorRow>,
}

/// "photo.jpg" + 2 -> "photo (2).jpg"; "photo" + 2 -> "photo (2)". Mirrors the
/// `stem (n).ext` scheme `export_photos` uses for on-disk duplicates.
fn indexed_filename(filename: &str, n: u32) -> String {
    match filename.rfind('.') {
        // A real extension (dot not first char, at least one char after it).
        Some(i) if i > 0 && i + 1 < filename.len() => {
            format!("{} ({}).{}", &filename[..i], n, &filename[i + 1..])
        }
        _ => format!("{filename} ({n})"),
    }
}

/// Reserve a catalog row for an import without ever clobbering a live or
/// completed photo. Starting from `desired`, walk `name`, `name (1)`,
/// `name (2)`… until a slot is either free (fresh insert) or holds a `failed`
/// row (reuse it — a retry of an import that never finished). Any other status
/// (completed / pending / processing) is a real photo we must not overwrite, so
/// we suffix past it. Returns what was actually reserved.
fn reserve_row(
    app: &AppHandle,
    folder: &str,
    desired: &str,
    mime: Option<&str>,
    file_size: i64,
) -> Result<Reserved> {
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
    reserve_row_conn(&conn, folder, desired, mime, file_size)
}

fn reserve_row_conn(
    conn: &rusqlite::Connection,
    folder: &str,
    desired: &str,
    mime: Option<&str>,
    file_size: i64,
) -> Result<Reserved> {
    // The whole resolve-then-write runs under the caller's single DB lock, so no
    // concurrent import can claim the same name between the lookup and the write.
    let mut n = 1;
    let mut filename = desired.to_string();
    loop {
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT id, processing_status FROM photos WHERE folder = ?1 AND filename = ?2",
                rusqlite::params![folder, &filename],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        let s3_key = format!("{folder}/{filename}");
        match existing {
            // Free slot — insert a brand-new row. A cancel can delete it wholesale.
            None => {
                // The exact name is free, but a different filename can still
                // claim the same variant stem ("photo.png" vs "photo.jpg", or
                // legacy "photo_original.jpg") — its derivatives would be
                // overwritten. Suffix past it like any other occupant.
                if db::variant_stem_occupant(conn, folder, &filename)?.is_some() {
                    filename = indexed_filename(desired, n);
                    n += 1;
                    continue;
                }
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO photos (id, filename, s3_key, folder, mime_type, file_size, processing_status, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7)",
                    rusqlite::params![id, &filename, &s3_key, folder, mime, file_size, db::now()],
                )?;
                return Ok(Reserved { id, s3_key, prior: None });
            }
            // A failed leftover — reuse its row (retry). Capture its prior state
            // so a cancel can put the failed marker back rather than delete it.
            Some((id, status)) if status == "failed" => {
                let prior = conn.query_row(
                    "SELECT processing_status, mime_type, file_size FROM photos WHERE id = ?1",
                    rusqlite::params![&id],
                    |row| {
                        Ok(PriorRow {
                            processing_status: row.get(0)?,
                            mime_type: row.get(1)?,
                            file_size: row.get(2)?,
                        })
                    },
                )?;
                conn.execute(
                    "UPDATE photos SET mime_type = ?1, file_size = ?2, processing_status = 'pending', updated_at = ?3 WHERE id = ?4",
                    rusqlite::params![mime, file_size, db::now(), &id],
                )?;
                return Ok(Reserved { id, s3_key, prior: Some(prior) });
            }
            // A completed or in-flight photo occupies this name — step to the
            // next suffix rather than overwrite it.
            Some(_) => {
                filename = indexed_filename(desired, n);
                n += 1;
            }
        }
    }
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
    fn deletion_keys_cover_where_the_pipeline_actually_uploads() {
        // Legacy-named file: variants are uploaded under the stripped stem,
        // so a cancelled import must delete them there — not under a
        // "photo_original_640.webp" key that never existed.
        let keys = deletion_keys("inbox/photo_original.jpg");
        assert!(keys.contains(&"inbox/photo_original.jpg".to_string()));
        assert!(keys.contains(&"inbox/photo_640.webp".to_string()));
        assert!(!keys.iter().any(|k| k.contains("_original_")));

        let keys = deletion_keys("inbox/photo.jpg");
        assert!(keys.contains(&"inbox/photo.jpg".to_string()));
        assert!(keys.contains(&"inbox/photo_2880.jpg".to_string()));
        // Original + 4 widths × 2 formats.
        assert_eq!(keys.len(), 9);
    }

    #[test]
    fn indexed_filename_matches_the_export_suffix_scheme() {
        assert_eq!(indexed_filename("photo.jpg", 2), "photo (2).jpg");
        assert_eq!(indexed_filename("photo.tar.gz", 1), "photo.tar (1).gz");
        // No extension — suffix the whole name.
        assert_eq!(indexed_filename("photo", 3), "photo (3)");
        // Leading-dot "extension" is a hidden file, not an ext: suffix as a whole.
        assert_eq!(indexed_filename(".hidden", 2), ".hidden (2)");
    }

    fn insert_photo(conn: &rusqlite::Connection, id: &str, filename: &str, status: &str) {
        conn.execute(
            "INSERT INTO photos (id, filename, s3_key, folder, mime_type, file_size, processing_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'inbox', 'image/jpeg', 111, ?4, ?5, ?5)",
            rusqlite::params![id, filename, format!("inbox/{filename}"), status, crate::db::now()],
        )
        .unwrap();
    }

    #[test]
    fn reserve_of_a_new_name_inserts_a_fresh_row() {
        let conn = crate::db::open_in_memory();
        let reserved =
            reserve_row_conn(&conn, "inbox", "new.jpg", Some("image/jpeg"), 10).unwrap();
        assert_eq!(reserved.s3_key, "inbox/new.jpg");
        // A brand-new row means a cancel is safe to delete wholesale.
        assert!(reserved.prior.is_none());
        let status: String = conn
            .query_row("SELECT processing_status FROM photos WHERE id = ?1", [&reserved.id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "pending");
    }

    #[test]
    fn reserve_suffixes_around_a_completed_photo_instead_of_overwriting() {
        let conn = crate::db::open_in_memory();
        insert_photo(&conn, "p1", "a.jpg", "completed");

        // The existing photo is real — importing another "a.jpg" must not touch
        // it. It lands on the next free suffix instead.
        let reserved =
            reserve_row_conn(&conn, "inbox", "a.jpg", Some("image/png"), 222).unwrap();
        assert_eq!(reserved.s3_key, "inbox/a (1).jpg");
        assert_ne!(reserved.id, "p1");
        assert!(reserved.prior.is_none());

        // The original photo is untouched — no data loss.
        let (status, size): (String, i64) = conn
            .query_row(
                "SELECT processing_status, file_size FROM photos WHERE id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "completed");
        assert_eq!(size, 111);
    }

    #[test]
    fn reserve_chains_suffixes_past_every_occupant() {
        let conn = crate::db::open_in_memory();
        insert_photo(&conn, "p1", "a.jpg", "completed");
        insert_photo(&conn, "p2", "a (1).jpg", "completed");
        // A still-processing import also holds a name we must step past.
        insert_photo(&conn, "p3", "a (2).jpg", "processing");

        let reserved = reserve_row_conn(&conn, "inbox", "a.jpg", Some("image/jpeg"), 5).unwrap();
        assert_eq!(reserved.s3_key, "inbox/a (3).jpg");
    }

    #[test]
    fn reserve_suffixes_past_a_variant_stem_collision() {
        let conn = crate::db::open_in_memory();
        // A legacy photo owns the "R0007098" variant stem even though the
        // exact filename "R0007098.jpg" is free.
        insert_photo(&conn, "legacy", "R0007098_original.jpg", "completed");

        let reserved =
            reserve_row_conn(&conn, "inbox", "R0007098.jpg", Some("image/jpeg"), 5).unwrap();
        assert_eq!(reserved.s3_key, "inbox/R0007098 (1).jpg");

        // Same stem via a different extension collides too, and must also
        // step past the row the previous reserve just created.
        let reserved =
            reserve_row_conn(&conn, "inbox", "R0007098.png", Some("image/png"), 5).unwrap();
        assert_eq!(reserved.s3_key, "inbox/R0007098 (2).png");
    }

    #[test]
    fn reserve_reuses_a_failed_row_as_a_retry() {
        let conn = crate::db::open_in_memory();
        insert_photo(&conn, "p1", "a.jpg", "failed");

        // A failed leftover is retried in place rather than duplicated.
        let reserved =
            reserve_row_conn(&conn, "inbox", "a.jpg", Some("image/png"), 222).unwrap();
        assert_eq!(reserved.id, "p1");
        assert_eq!(reserved.s3_key, "inbox/a.jpg");
        let prior = reserved.prior.expect("a reused failed row must report prior state");
        assert_eq!(prior.processing_status, "failed");
        let status: String = conn
            .query_row("SELECT processing_status FROM photos WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "pending");

        // Cancelling the retry restores the failed marker exactly.
        restore_row_conn(&conn, &reserved.id, &prior);
        let status: String = conn
            .query_row("SELECT processing_status FROM photos WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "failed");
    }
}
