//! Variant repair for photos whose derivative set is missing from the bucket
//! (`variants_ok = 0`) — originals synced in by another tool, or rows from a
//! catalog/manifest that predates the flag. A refresh HEADs each photo's
//! 640px variant (cheap) and only for the ones actually missing it downloads
//! the original, regenerates the full variant set, and uploads it.
//!
//! EXIF and dimensions are deliberately NOT backfilled in bulk — with a large
//! bucket that would mean downloading every original. They are filled on
//! demand per photo by `load_photo_metadata` (the lightbox's "Load info"
//! button), or as a free side effect when a variant set is regenerated.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;

use crate::db::{self, Db, PHOTO_COLUMNS};
use crate::error::{Error, Result};
use crate::exif::ExifMeta;
use crate::pipeline;
use crate::protocol;
use crate::settings::S3State;

/// Variant-existence checks use HEAD requests; a wider lane keeps a large
/// pending set moving.
const CHECK_CONCURRENCY: usize = 8;
/// Same ceiling as imports — regenerations download originals, so two in
/// flight keeps the pipe busy without saturating the connection.
const REFRESH_CONCURRENCY: usize = 2;

pub const PROGRESS_EVENT: &str = "refresh://progress";

/// At most one refresh runs at a time; `cancel` asks the running one to stop
/// at the next photo boundary.
#[derive(Default)]
pub struct RefreshState {
    running: AtomicBool,
    cancel: AtomicBool,
    /// (total, done, failed) of the run in flight. Progress events are fire-
    /// and-forget, so a freshly mounted Settings page needs this snapshot to
    /// rejoin a background refresh instead of showing it as idle.
    progress: std::sync::Mutex<Option<(usize, usize, usize)>>,
}

impl RefreshState {
    fn begin(&self) -> Result<()> {
        let mut progress = self.progress.lock().unwrap();
        if self.running.load(Ordering::SeqCst) {
            return Err(Error::msg("A refresh is already running"));
        }
        self.cancel.store(false, Ordering::Relaxed);
        self.running.store(true, Ordering::SeqCst);
        *progress = Some((0, 0, 0));
        Ok(())
    }

    fn request_cancel(&self) {
        let _progress = self.progress.lock().unwrap();
        self.cancel.store(true, Ordering::Relaxed);
    }

    fn finish(&self) {
        let mut progress = self.progress.lock().unwrap();
        *progress = None;
        self.running.store(false, Ordering::SeqCst);
    }
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
         WHERE (processing_status = 'completed' AND (variants_ok = 0 OR variants_recheck = 1)) OR processing_status = 'failed'
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
    // Rows cataloged before extension filtering existed can carry videos and
    // other non-images; there is nothing a refresh could regenerate for them.
    Ok(rows
        .into_iter()
        .filter(|t| crate::keys::is_supported_image(&t.filename))
        .collect())
}

/// How many photos a refresh would touch right now. Counts via `targets` so
/// the number always matches what a run would actually process.
pub(crate) fn pending_count(conn: &Connection) -> Result<usize> {
    Ok(targets(conn)?.len())
}

#[tauri::command]
pub fn refresh_pending_count(db: tauri::State<Db>) -> Result<usize> {
    let conn = db.0.lock().unwrap();
    pending_count(&conn)
}

/// Ask the running refresh (if any) to stop after the photos currently in
/// flight finish. Already-refreshed photos keep their new variants/metadata.
#[tauri::command]
pub fn cancel_refresh(state: tauri::State<RefreshState>) {
    state.request_cancel();
}

/// Progress of the refresh currently in flight, or None when idle. Lets the
/// UI rejoin a background run on mount rather than waiting for its next
/// progress event (which may be many seconds away mid-download).
#[tauri::command]
pub fn refresh_status(state: tauri::State<RefreshState>) -> Option<RefreshProgress> {
    let snapshot = *state.progress.lock().unwrap();
    snapshot.map(|(total, done, failed)| RefreshProgress {
        total,
        done,
        failed,
        status: "running",
        photo_id: None,
        filename: None,
        error: None,
    })
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
        let state = self.0.state::<RefreshState>();
        state.finish();
    }
}

async fn run(app: &AppHandle) -> Result<RefreshReport> {
    // Register before waiting: cancellation and duplicate-run checks also
    // apply while an import/export owns the library.
    app.state::<RefreshState>().begin()?;
    let _guard = RunGuard(app.clone());
    let _operation = crate::library::write(app).await;
    if app.state::<RefreshState>().cancel.load(Ordering::Relaxed) {
        let db = app.state::<Db>();
        let total = pending_count(&db.0.lock().unwrap())?;
        let report = RefreshReport { total, refreshed: 0, failed: 0, cancelled: true };
        emit_finished(app, &report);
        return Ok(report);
    }

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
        let report = RefreshReport { total: 0, refreshed: 0, failed: 0, cancelled: false };
        emit_finished(app, &report);
        return Ok(report);
    }
    *app.state::<RefreshState>().progress.lock().unwrap() = Some((total, 0, 0));

    // (done, failed), updated and emitted under one lock so progress events
    // leave in counter order — the frontend relies on done+failed to detect a
    // run's first event, and two concurrent tasks would otherwise race
    // between incrementing and emitting.
    let counters = Arc::new(std::sync::Mutex::new((0usize, 0usize)));
    // Two lanes: every target passes through the wide HEAD-check lane; only
    // the ones missing their variants proceed into the narrow download lane.
    let check = Arc::new(Semaphore::new(CHECK_CONCURRENCY));
    let heavy = Arc::new(Semaphore::new(REFRESH_CONCURRENCY));
    let mut handles = Vec::with_capacity(total);

    for target in list {
        let app = app.clone();
        let counters = counters.clone();
        let check = check.clone();
        let heavy = heavy.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let error = match refresh_one(&app, &target, &check, &heavy).await {
                // Cancelled while queued — skip without counting as done/failed.
                Ok(Outcome::Skipped) => return,
                Ok(Outcome::Refreshed) => None,
                Err(err) => {
                    eprintln!("[refresh] {} failed: {err}", target.s3_key);
                    Some(err)
                }
            };
            {
                let mut counts = counters.lock().unwrap();
                match &error {
                    None => counts.0 += 1,
                    Some(_) => counts.1 += 1,
                }
                *app.state::<RefreshState>().progress.lock().unwrap() =
                    Some((total, counts.0, counts.1));
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
    let report = RefreshReport { total, refreshed, failed, cancelled };
    emit_finished(app, &report);

    // The catalog now carries real metadata — persist it so the next rebuild
    // takes the manifest fast path instead of another listing + refresh.
    if refreshed > 0 {
        crate::manifest::schedule_upload(app);
    }

    Ok(report)
}

fn emit_finished(app: &AppHandle, report: &RefreshReport) {
    let _ = app.emit(PROGRESS_EVENT, RefreshProgress {
        total: report.total, done: report.refreshed, failed: report.failed,
        status: if report.cancelled { "cancelled" } else { "done" },
        photo_id: None, filename: None, error: None,
    });
}

enum Outcome {
    Refreshed,
    /// Cancel was requested before this photo started any real work.
    Skipped,
}

/// Repair one photo. If every required variant and the original exist, the
/// row is just marked healthy — no download, no
/// metadata read. Only genuinely variant-less photos pay for a download,
/// regenerate, and upload (which also fills metadata, since the bytes are at
/// hand).
async fn refresh_one(
    app: &AppHandle,
    target: &Target,
    check: &Semaphore,
    heavy: &Semaphore,
) -> Result<Outcome> {
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        let photo = conn.query_row(&format!("SELECT {PHOTO_COLUMNS} FROM photos WHERE id = ?1"), [&target.id], db::photo_from_row)?;
        db::ensure_exclusive_keys(&conn, &photo)?;
    }
    {
        let _permit = check.acquire().await.expect("semaphore never closes");
        if app.state::<RefreshState>().cancel.load(Ordering::Relaxed) {
            return Ok(Outcome::Skipped);
        }
        if variants_exist(app, &target.s3_key).await? {
            let db = app.state::<Db>();
            let conn = db.0.lock().unwrap();
            mark_variants_ok(&conn, &target.id)?;
            return Ok(Outcome::Refreshed);
        }
    }

    // The check permit is released while queueing for the download lane, so
    // a backlog of regenerations never stalls the cheap HEAD sweep.
    let _permit = heavy.acquire().await.expect("semaphore never closes");
    if app.state::<RefreshState>().cancel.load(Ordering::Relaxed) {
        return Ok(Outcome::Skipped);
    }

    let bytes = crate::photos::fetch_bytes(app, &target.s3_key).await?;
    let file_size = bytes.len() as i64;

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
    )?;
    mark_variants_ok(&conn, &target.id)?;
    Ok(Outcome::Refreshed)
}

/// On-demand EXIF/dimension load for a single photo — the lightbox's "Load
/// info" button. Downloads (and locally caches) that one original, refills
/// the row's metadata, and returns the updated row.
#[tauri::command]
pub async fn load_photo_metadata(app: AppHandle, photo_id: String) -> Result<db::Photo> {
    let _operation = crate::library::write(&app).await;
    let (s3_key, filename) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        conn.query_row(
            "SELECT s3_key, filename FROM photos WHERE id = ?1",
            rusqlite::params![photo_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
    };

    let bytes = crate::photos::fetch_bytes(&app, &s3_key).await?;
    let file_size = bytes.len() as i64;
    let (width, height, exif) = tauri::async_runtime::spawn_blocking(move || read_meta(&bytes))
        .await
        .map_err(|e| Error::msg(e.to_string()))??;

    let photo = {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        store_refreshed(
            &conn,
            &photo_id,
            width,
            height,
            &exif,
            pipeline::mime_for_extension(&filename),
            file_size,
        )?;
        conn.query_row(
            &format!("SELECT {PHOTO_COLUMNS} FROM photos WHERE id = ?1"),
            rusqlite::params![photo_id],
            db::photo_from_row,
        )?
    };
    // Persist the metadata so a future rebuild keeps it.
    crate::manifest::schedule_upload(&app);
    Ok(photo)
}

/// Does the photo already have its grid variant in the bucket? Checked via
/// the 640px webp — the one every view needs; if it's there the rest of the
/// set is assumed complete (both the old web pipeline and this app write all
/// widths together). Any HEAD failure counts as missing, which errs toward
/// regenerating.
async fn variants_exist(app: &AppHandle, s3_key: &str) -> Result<bool> {
    let state = app.state::<S3State>();
    let guard = state.0.read().await;
    let ctx = guard.as_ref().ok_or_else(|| Error::msg("S3 is not configured"))?;
    variants_exist_in(ctx, s3_key).await
}

async fn variants_exist_in(ctx: &crate::settings::S3Ctx, s3_key: &str) -> Result<bool> {
    let mut keys = crate::keys::required_variants(s3_key);
    keys.push(s3_key.to_string());
    for key in keys {
        match ctx.client.head_object().bucket(&ctx.bucket).key(key).send().await {
            Ok(_) => {},
            Err(aws_sdk_s3::error::SdkError::ServiceError(e)) if e.raw().status().as_u16() == 404 => return Ok(false),
            Err(e) => return Err(Error::msg(format!("Could not check image variants: {}", crate::error::friendly_s3_error(&e)))),
        }
    }
    Ok(true)
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

/// Record that the photo's variant set is present in the bucket. Bumps
/// updated_at so grid tiles retry the variant instead of sticking with their
/// original-image fallback.
fn mark_variants_ok(conn: &Connection, photo_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE photos SET variants_ok = 1, variants_recheck = 0, processing_status = 'completed', updated_at = ?1 WHERE id = ?2",
        rusqlite::params![db::now(), photo_id],
    )?;
    Ok(())
}

/// Write freshly read metadata back. Never touches variants_ok — metadata
/// and variant presence are independent facts. `mime_type`/`file_size` only
/// fill gaps — a row that already knows them (e.g. from a manifest) keeps
/// its values.
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

    #[tokio::test]
    async fn queued_refresh_preserves_cancellation_and_rejects_a_second_run() {
        let library = crate::library::LibraryState::default();
        let busy = library.0.clone().lock_owned().await;
        let state = Arc::new(RefreshState::default());
        state.begin().unwrap();
        let queued = state.clone();
        let task = tokio::spawn(async move {
            let _operation = library.0.lock_owned().await;
            let cancelled = queued.cancel.load(Ordering::Relaxed);
            queued.finish();
            cancelled
        });
        assert!(state.begin().is_err());
        state.request_cancel();
        assert!(state.begin().is_err());
        assert!(!task.is_finished());
        drop(busy);
        assert!(task.await.unwrap());
        assert!(state.progress.lock().unwrap().is_none());
        state.begin().unwrap();
        assert!(!state.cancel.load(Ordering::Relaxed));
        state.finish();
    }

    #[test]
    fn a_full_set_recheck_preserves_known_thumbnail_availability_and_clears_on_success() {
        let conn = db::open_in_memory();
        insert_photo(&conn, "p", "a.jpg", "completed", true);
        conn.execute("UPDATE photos SET variants_recheck = 1", []).unwrap();
        assert_eq!(pending_count(&conn).unwrap(), 1);
        assert_eq!(crate::commands::folder_counts(&conn).unwrap()[0].cover_key.as_deref(), Some("inbox/a.jpg"));
        mark_variants_ok(&conn, "p").unwrap();
        assert_eq!(pending_count(&conn).unwrap(), 0);
        assert_eq!(crate::commands::folder_counts(&conn).unwrap()[0].cover_key.as_deref(), Some("inbox/a.jpg"));
    }

    #[tokio::test]
    async fn healthy_requires_all_six_variants_and_the_original() {
        let (ctx, server) = crate::test_support::s3(vec![(200, ""); 7]).await;
        assert!(variants_exist_in(&ctx, "inbox/photo_original.jpg").await.unwrap());
        let requests = server.await.unwrap();
        let mut keys = crate::keys::required_variants("inbox/photo_original.jpg");
        keys.push("inbox/photo_original.jpg".into());
        for key in keys {
            assert!(requests.iter().any(|request| request.starts_with(&format!("HEAD /test-only/{key} "))), "missing check for {key}");
        }
    }

    #[tokio::test]
    async fn a_missing_larger_variant_requires_repair_but_permission_errors_are_not_missing_files() {
        let (ctx, server) = crate::test_support::s3(vec![(200, ""), (200, ""), (404, "")]).await;
        assert!(!variants_exist_in(&ctx, "inbox/photo.jpg").await.unwrap());
        assert_eq!(server.await.unwrap().len(), 3);
        let (ctx, server) = crate::test_support::s3(vec![(403, "")]).await;
        assert!(variants_exist_in(&ctx, "inbox/photo.jpg").await.is_err());
        server.await.unwrap();
    }

    fn insert_photo(conn: &Connection, id: &str, filename: &str, status: &str, variants_ok: bool) {
        conn.execute(
            "INSERT INTO photos (id, filename, s3_key, folder, variants_ok, processing_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'inbox', ?4, ?5, ?6, ?6)",
            rusqlite::params![id, filename, format!("inbox/{filename}"), variants_ok, status, db::now()],
        )
        .unwrap();
    }

    #[test]
    fn targets_include_failed_imports_and_incomplete_variants() {
        let conn = db::open_in_memory();
        // Synced-in original without derivatives — needs a refresh.
        insert_photo(&conn, "bare", "a.jpg", "completed", false);
        // Healthy row: variants known present — leave alone, even though
        // its EXIF may never have been loaded.
        insert_photo(&conn, "healthy", "b.jpg", "completed", true);
        // A failed upload may have stored the original but only some variants.
        insert_photo(&conn, "stuck", "c.jpg", "failed", false);
        insert_photo(&conn, "active", "d.jpg", "processing", false);
        // Cataloged before extension filtering existed: nothing to regenerate
        // for a video, so refresh must not download it just to fail.
        insert_photo(&conn, "video", "run-silent-run-deep-1958.mp4", "completed", false);

        let list = targets(&conn).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|photo| photo.id == "bare" && photo.s3_key == "inbox/a.jpg"));
        assert!(list.iter().any(|photo| photo.id == "stuck"));
        // The advertised count always matches what a run would process.
        assert_eq!(pending_count(&conn).unwrap(), 2);
    }

    #[test]
    fn mark_variants_ok_flips_the_flag_and_touches_the_row() {
        let conn = db::open_in_memory();
        insert_photo(&conn, "p1", "a.jpg", "completed", false);
        let before: String = conn
            .query_row("SELECT updated_at FROM photos WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();

        mark_variants_ok(&conn, "p1").unwrap();

        let (flag, after): (bool, String) = conn
            .query_row("SELECT variants_ok, updated_at FROM photos WHERE id = 'p1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert!(flag);
        assert!(after >= before);
        assert_eq!(targets(&conn).unwrap().len(), 0);
    }

    #[test]
    fn store_refreshed_fills_metadata_without_claiming_variants() {
        let conn = db::open_in_memory();
        insert_photo(&conn, "p1", "a.jpg", "completed", false);

        let exif = ExifMeta {
            camera_make: Some("Fuji".into()),
            iso: Some(400),
            ..Default::default()
        };
        store_refreshed(&conn, "p1", 1600, 900, &exif, Some("image/jpeg"), 12345).unwrap();

        let (width, make, iso, mime, size, status, variants_ok): (i64, String, i64, String, i64, String, bool) = conn
            .query_row(
                "SELECT width, camera_make, iso, mime_type, file_size, processing_status, variants_ok
                 FROM photos WHERE id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
            .unwrap();
        assert_eq!(width, 1600);
        assert_eq!(make, "Fuji");
        assert_eq!(iso, 400);
        assert_eq!(mime, "image/jpeg");
        assert_eq!(size, 12345);
        assert_eq!(status, "completed");
        // Loading metadata says nothing about the bucket's variant set.
        assert!(!variants_ok);
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
