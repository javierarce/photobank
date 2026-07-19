//! Backfill for photos the app never processed locally — originals synced
//! into the bucket by another tool, or cataloged by the listing fallback of
//! "Rebuild from bucket". Their catalog rows have no EXIF/dimensions, and
//! they may or may not have `_640`/`_1280`/`_2880` variants (the old web
//! pipeline's output survives a bucket-to-bucket copy; a bare `aws s3 cp` of
//! originals does not). A refresh downloads each original and refills the
//! row's metadata; when the 640px variant is missing it also regenerates and
//! uploads the full variant set. Existing variants are left untouched.
//!
//! "Never processed locally" is detected as `width IS NULL` on a completed
//! row — the pipeline always records dimensions, so a completed row without
//! them can only come from a listing rebuild or a foreign manifest.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;

use crate::db::{self, Db};
use crate::error::{Error, Result};
use crate::exif::ExifMeta;
use crate::pipeline;
use crate::protocol;
use crate::settings::S3State;

/// Same ceiling as imports — refreshes download originals, so two in flight
/// keeps the pipe busy without saturating the connection.
const REFRESH_CONCURRENCY: usize = 2;

pub const PROGRESS_EVENT: &str = "refresh://progress";

/// At most one refresh runs at a time; `cancel` asks the running one to stop
/// at the next photo boundary.
#[derive(Default)]
pub struct RefreshState {
    running: AtomicBool,
    cancel: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshProgress {
    pub total: usize,
    pub done: usize,
    pub failed: usize,
    /// "running" | "done" | "cancelled"
    pub status: &'static str,
    pub photo_id: Option<String>,
    pub filename: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshReport {
    pub total: usize,
    pub refreshed: usize,
    pub failed: usize,
    pub cancelled: bool,
}

struct Target {
    id: String,
    s3_key: String,
    filename: String,
}

fn targets(conn: &Connection) -> Result<Vec<Target>> {
    let mut stmt = conn.prepare(
        "SELECT id, s3_key, filename FROM photos
         WHERE processing_status = 'completed' AND width IS NULL
         ORDER BY created_at",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Target {
                id: row.get(0)?,
                s3_key: row.get(1)?,
                filename: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// How many photos a refresh would touch right now.
#[tauri::command]
pub fn refresh_pending_count(db: tauri::State<Db>) -> Result<usize> {
    let conn = db.0.lock().unwrap();
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM photos WHERE processing_status = 'completed' AND width IS NULL",
        [],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

/// Ask the running refresh (if any) to stop after the photos currently in
/// flight finish. Already-refreshed photos keep their new variants/metadata.
#[tauri::command]
pub fn cancel_refresh(state: tauri::State<RefreshState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub async fn refresh_library(app: AppHandle) -> Result<RefreshReport> {
    run(&app).await
}

/// Kick off a refresh in the background if anything needs one — used after a
/// rebuild so a bucket full of foreign originals repairs itself without a
/// second manual step. Quiet when a refresh is already running.
pub fn spawn_if_needed(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match run(&app).await {
            Ok(_) => {}
            Err(err) => eprintln!("[refresh] background refresh failed: {err}"),
        }
    });
}

/// Clears the running flag on every exit path, including errors.
struct RunGuard(AppHandle);

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.0.state::<RefreshState>().running.store(false, Ordering::SeqCst);
    }
}

async fn run(app: &AppHandle) -> Result<RefreshReport> {
    {
        let state = app.state::<RefreshState>();
        if state.running.swap(true, Ordering::SeqCst) {
            return Err(Error::msg("A refresh is already running"));
        }
        state.cancel.store(false, Ordering::Relaxed);
    }
    let _guard = RunGuard(app.clone());

    // Refuse to write into a bucket the catalog wasn't built from, and fail
    // fast when S3 isn't configured at all.
    {
        let state = app.state::<S3State>();
        let s3 = state.0.read().await;
        let ctx = s3
            .as_ref()
            .ok_or_else(|| Error::msg("S3 is not configured — open Settings first"))?;
        crate::settings::ensure_catalog_matches_bucket(app, ctx)?;
    }

    let list = {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        targets(&conn)?
    };
    let total = list.len();
    if total == 0 {
        return Ok(RefreshReport { total: 0, refreshed: 0, failed: 0, cancelled: false });
    }

    // (done, failed), updated and emitted under one lock so progress events
    // leave in counter order — the frontend relies on done+failed to detect a
    // run's first event, and two concurrent tasks would otherwise race
    // between incrementing and emitting.
    let counters = Arc::new(std::sync::Mutex::new((0usize, 0usize)));
    let semaphore = Arc::new(Semaphore::new(REFRESH_CONCURRENCY));
    let mut handles = Vec::with_capacity(total);

    for target in list {
        let app = app.clone();
        let counters = counters.clone();
        let semaphore = semaphore.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let _permit = semaphore.acquire().await.expect("semaphore never closes");
            // Cancelled while queued — skip without counting as done/failed.
            if app.state::<RefreshState>().cancel.load(Ordering::Relaxed) {
                return;
            }

            let error = refresh_one(&app, &target).await.err();
            if let Some(err) = &error {
                eprintln!("[refresh] {} failed: {err}", target.s3_key);
            }
            {
                let mut counts = counters.lock().unwrap();
                match &error {
                    None => counts.0 += 1,
                    Some(_) => counts.1 += 1,
                }
                let _ = app.emit(
                    PROGRESS_EVENT,
                    RefreshProgress {
                        total,
                        done: counts.0,
                        failed: counts.1,
                        status: "running",
                        photo_id: Some(target.id.clone()),
                        filename: Some(target.filename.clone()),
                        error: error.map(|e| e.to_string()),
                    },
                );
            }
        }));
    }

    for handle in handles {
        let _ = handle.await;
    }

    let (refreshed, failed) = *counters.lock().unwrap();
    let cancelled = app.state::<RefreshState>().cancel.load(Ordering::Relaxed);
    let _ = app.emit(
        PROGRESS_EVENT,
        RefreshProgress {
            total,
            done: refreshed,
            failed,
            status: if cancelled { "cancelled" } else { "done" },
            photo_id: None,
            filename: None,
            error: None,
        },
    );

    // The catalog now carries real metadata — persist it so the next rebuild
    // takes the manifest fast path instead of another listing + refresh.
    if refreshed > 0 {
        crate::manifest::schedule_upload(app);
    }

    Ok(RefreshReport { total, refreshed, failed, cancelled })
}

/// Refresh one photo. Always refills metadata from the original; regenerates
/// and uploads variants only when the 640px one is missing from the bucket
/// (originals copied in without their derivatives).
async fn refresh_one(app: &AppHandle, target: &Target) -> Result<()> {
    let bytes = crate::photos::fetch_bytes(app, &target.s3_key).await?;
    let file_size = bytes.len() as i64;

    if variants_exist(app, &target.s3_key).await {
        // Metadata only — EXIF plus a header-level dimension read, no
        // decode/resize/upload.
        let (width, height, exif) =
            tauri::async_runtime::spawn_blocking(move || read_meta(&bytes))
                .await
                .map_err(|e| Error::msg(e.to_string()))??;
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        return store_refreshed(
            &conn,
            &target.id,
            width,
            height,
            &exif,
            pipeline::mime_for_extension(&target.filename),
            file_size,
        );
    }

    let processed = {
        let s3_key = target.s3_key.clone();
        tauri::async_runtime::spawn_blocking(move || pipeline::process(&bytes, &s3_key))
            .await
            .map_err(|e| Error::msg(e.to_string()))??
    };

    {
        let state = app.state::<S3State>();
        let guard = state.0.read().await;
        let ctx = guard
            .as_ref()
            .ok_or_else(|| Error::msg("S3 is not configured — open Settings first"))?;
        for variant in &processed.variants {
            crate::import::put_object(
                ctx,
                &variant.key,
                variant.bytes.clone(),
                variant.content_type,
                true,
            )
            .await?;
        }
    }

    for variant in &processed.variants {
        protocol::cache_put(app, &variant.key, &variant.bytes).await;
    }

    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
    store_refreshed(
        &conn,
        &target.id,
        processed.width,
        processed.height,
        &processed.exif,
        pipeline::mime_for_extension(&target.filename),
        file_size,
    )
}

/// Does the photo already have its grid variant in the bucket? Checked via
/// the 640px webp — the one every view needs; if it's there the rest of the
/// set is assumed complete (both the old web pipeline and this app write all
/// widths together). Any HEAD failure counts as missing, which errs toward
/// regenerating.
async fn variants_exist(app: &AppHandle, s3_key: &str) -> bool {
    let key = crate::keys::variant_key(s3_key, 640, crate::keys::VariantFormat::Webp);
    let state = app.state::<S3State>();
    let guard = state.0.read().await;
    let Some(ctx) = guard.as_ref() else {
        return false;
    };
    ctx.client
        .head_object()
        .bucket(&ctx.bucket)
        .key(key)
        .send()
        .await
        .is_ok()
}

/// Display dimensions (EXIF orientation applied) + EXIF, without a full
/// pixel decode.
fn read_meta(bytes: &[u8]) -> Result<(u32, u32, ExifMeta)> {
    let meta = crate::exif::parse(bytes);
    let (mut width, mut height) = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| Error::msg(format!("could not read image: {e}")))?
        .into_dimensions()
        .map_err(|e| Error::msg(format!("could not read image dimensions: {e}")))?;
    // Orientations 5–8 rotate by 90°, swapping the displayed axes.
    if (5..=8).contains(&meta.orientation) {
        std::mem::swap(&mut width, &mut height);
    }
    Ok((width, height, meta))
}

/// Write the regenerated metadata back. `mime_type`/`file_size` only fill
/// gaps — a row that already knows them (e.g. from a manifest) keeps its
/// values.
fn store_refreshed(
    conn: &Connection,
    photo_id: &str,
    width: u32,
    height: u32,
    exif: &ExifMeta,
    mime: Option<&str>,
    file_size: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE photos SET
           width = ?1, height = ?2,
           camera_make = ?3, camera_model = ?4, lens = ?5, focal_length = ?6,
           aperture = ?7, shutter_speed = ?8, iso = ?9, taken_at = ?10,
           gps_latitude = ?11, gps_longitude = ?12,
           mime_type = COALESCE(mime_type, ?13),
           file_size = COALESCE(file_size, ?14),
           updated_at = ?15
         WHERE id = ?16",
        rusqlite::params![
            width,
            height,
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
            mime,
            file_size,
            db::now(),
            photo_id,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_photo(conn: &Connection, id: &str, filename: &str, status: &str, width: Option<i64>) {
        conn.execute(
            "INSERT INTO photos (id, filename, s3_key, folder, width, height, processing_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'inbox', ?4, ?4, ?5, ?6, ?6)",
            rusqlite::params![id, filename, format!("inbox/{filename}"), width, status, db::now()],
        )
        .unwrap();
    }

    #[test]
    fn targets_are_completed_rows_without_dimensions() {
        let conn = db::open_in_memory();
        // Listing-rebuilt row: completed, no dimensions — needs a refresh.
        insert_photo(&conn, "foreign", "a.jpg", "completed", None);
        // Locally imported row: pipeline recorded dimensions — leave alone.
        insert_photo(&conn, "local", "b.jpg", "completed", Some(640));
        // Unfinished/failed imports are the importer's problem, not ours.
        insert_photo(&conn, "stuck", "c.jpg", "failed", None);

        let list = targets(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "foreign");
        assert_eq!(list[0].s3_key, "inbox/a.jpg");
    }

    #[test]
    fn store_refreshed_fills_metadata_and_keeps_status() {
        let conn = db::open_in_memory();
        insert_photo(&conn, "p1", "a.jpg", "completed", None);

        let exif = ExifMeta {
            camera_make: Some("Fuji".into()),
            iso: Some(400),
            ..Default::default()
        };
        store_refreshed(&conn, "p1", 1600, 900, &exif, Some("image/jpeg"), 12345).unwrap();

        let (width, make, iso, mime, size, status): (i64, String, i64, String, i64, String) = conn
            .query_row(
                "SELECT width, camera_make, iso, mime_type, file_size, processing_status
                 FROM photos WHERE id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();
        assert_eq!(width, 1600);
        assert_eq!(make, "Fuji");
        assert_eq!(iso, 400);
        assert_eq!(mime, "image/jpeg");
        assert_eq!(size, 12345);
        assert_eq!(status, "completed");
    }

    #[test]
    fn read_meta_reads_dimensions_without_a_full_decode() {
        let img = image::RgbImage::from_fn(120, 80, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 0])
        });
        let mut out = Vec::new();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
        img.write_with_encoder(encoder).unwrap();

        let (width, height, meta) = read_meta(&out).unwrap();
        assert_eq!((width, height), (120, 80));
        assert_eq!(meta.orientation, 1);
    }

    #[test]
    fn store_refreshed_never_overwrites_known_mime_or_size() {
        let conn = db::open_in_memory();
        conn.execute(
            "INSERT INTO photos (id, filename, s3_key, folder, mime_type, file_size, processing_status, created_at, updated_at)
             VALUES ('p1', 'a.png', 'inbox/a.png', 'inbox', 'image/png', 999, 'completed', ?1, ?1)",
            rusqlite::params![db::now()],
        )
        .unwrap();

        store_refreshed(&conn, "p1", 100, 50, &ExifMeta::default(), Some("image/jpeg"), 12345)
            .unwrap();

        let (mime, size): (String, i64) = conn
            .query_row("SELECT mime_type, file_size FROM photos WHERE id = 'p1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        // The manifest knew these — the refresh only fills gaps.
        assert_eq!(mime, "image/png");
        assert_eq!(size, 999);
    }
}
