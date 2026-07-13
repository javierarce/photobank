//! Import orchestration: for each dropped file — catalog row, EXIF +
//! variants (pipeline), upload original + variants to S3, seed the local
//! photo cache, and stream progress to the frontend as `import://progress`
//! events. Replaces the old presign → browser PUT → confirm → BullMQ flow.

use std::sync::Arc;

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
    /// "starting" | "processing" | "uploading" | "done" | "error"
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

pub async fn import_photos(app: AppHandle, paths: Vec<String>, folder: String) -> Result<Vec<Photo>> {
    let folder = sanitize_folder(&folder).ok_or_else(|| Error::msg("Invalid folder"))?;

    let importable: Vec<String> = paths.into_iter().filter(|p| pipeline::is_importable(p)).collect();
    if importable.is_empty() {
        return Ok(Vec::new());
    }

    let semaphore = Arc::new(Semaphore::new(IMPORT_CONCURRENCY));
    let mut handles = Vec::with_capacity(importable.len());
    for path in importable {
        let app = app.clone();
        let folder = folder.clone();
        let semaphore = semaphore.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let _permit = semaphore.acquire().await.expect("semaphore never closes");
            import_one(&app, &path, &folder).await
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

/// Imports a single file. Failures are reported via events (and the catalog
/// row is marked failed); the returned Option is None in that case so one
/// bad file never aborts the batch.
async fn import_one(app: &AppHandle, path: &str, folder: &str) -> Option<Photo> {
    let filename = sanitize_filename(
        std::path::Path::new(path).file_name().map(|n| n.to_string_lossy()).unwrap_or_default().as_ref(),
    )?;
    let s3_key = format!("{folder}/{filename}");
    let reporter = Reporter {
        app: app.clone(),
        key: s3_key.clone(),
        filename: filename.clone(),
        folder: folder.to_string(),
    };
    reporter.emit(None, 0, "starting", None);

    match run_import(app, path, folder, &filename, &s3_key, &reporter).await {
        Ok(photo) => {
            reporter.emit(Some(&photo.id), 100, "done", None);
            crate::manifest::schedule_upload(app);
            Some(photo)
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
) -> std::result::Result<Photo, ImportError> {
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
    let photo_id = upsert_row(app, folder, filename, s3_key, mime, file_size)
        .map_err(|e| (None, e))?;
    let fail = |e: Error| (Some(photo_id.clone()), e);

    set_status(app, &photo_id, "processing").map_err(fail)?;
    reporter.emit(Some(&photo_id), 10, "processing", None);

    // EXIF + all six variants; CPU-bound, so off the async threads.
    let processed: ProcessedImage = {
        let bytes = bytes.clone();
        let s3_key = s3_key.to_string();
        tauri::async_runtime::spawn_blocking(move || pipeline::process(&bytes, &s3_key))
            .await
            .map_err(|e| fail(Error::msg(e.to_string())))?
            .map_err(fail)?
    };
    reporter.emit(Some(&photo_id), 40, "uploading", None);

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
    load_photo(app, &photo_id).map_err(|e| (Some(photo_id.clone()), e))
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

fn upsert_row(
    app: &AppHandle,
    folder: &str,
    filename: &str,
    s3_key: &str,
    mime: Option<&str>,
    file_size: i64,
) -> Result<String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
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
    Ok(id)
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
