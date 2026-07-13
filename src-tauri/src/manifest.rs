//! Catalog durability: the bucket is the source of truth. After any
//! mutation, the full catalog (photos + tags + associations) is exported to
//! s3://<bucket>/photobank-manifest.json on a debounce, so a fresh install
//! (or a second Mac) can rebuild its SQLite catalog from the bucket alone.
//! Concurrency model is last-writer-wins — this is a single-user app.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::operation::get_object::GetObjectError;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::db::{self, Db, Photo, PHOTO_COLUMNS};
use crate::error::{Error, Result};
use crate::settings::{S3Ctx, S3State};

pub const MANIFEST_KEY: &str = "photobank-manifest.json";
/// One generation of history: the previous manifest is copied here before
/// every upload, so a clobbered manifest (or a bad rebuild) can be undone by
/// restoring this object.
pub const MANIFEST_BACKUP_KEY: &str = "photobank-manifest.prev.json";
const DEBOUNCE: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct ManifestState(pub Arc<AtomicU64>);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TagRow {
    id: String,
    name: String,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhotoTagRow {
    photo_id: String,
    tag_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    exported_at: String,
    photos: Vec<Photo>,
    tags: Vec<TagRow>,
    photo_tags: Vec<PhotoTagRow>,
}

/// Debounced manifest upload: consecutive mutations within the window
/// collapse into one PUT (imports of a whole batch upload once).
pub fn schedule_upload(app: &AppHandle) {
    let state = app.state::<ManifestState>();
    let generation = state.0.fetch_add(1, Ordering::SeqCst) + 1;
    let counter = state.0.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DEBOUNCE).await;
        if counter.load(Ordering::SeqCst) != generation {
            return; // superseded by a newer mutation
        }
        if let Err(err) = upload(&app).await {
            eprintln!("[manifest] upload failed: {err}");
        }
    });
}

async fn upload(app: &AppHandle) -> Result<()> {
    let state = app.state::<S3State>();
    let guard = state.0.read().await;
    let ctx = guard
        .as_ref()
        .ok_or_else(|| Error::msg("S3 is not configured"))?;
    // A catalog from another bucket must never overwrite this bucket's
    // manifest (e.g. right after switching buckets in Settings).
    crate::settings::ensure_catalog_matches_bucket(app, ctx)?;

    let manifest = build(app)?;
    let json = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| Error::msg(format!("manifest serialize: {e}")))?;

    backup_previous(ctx).await;
    ctx.client
        .put_object()
        .bucket(&ctx.bucket)
        .key(MANIFEST_KEY)
        .content_type("application/json")
        .body(json.into())
        .send()
        .await
        .map_err(|e| {
            Error::msg(format!(
                "manifest upload: {}",
                aws_smithy_types::error::display::DisplayErrorContext(&e)
            ))
        })?;
    Ok(())
}

/// Best-effort copy of the current manifest to MANIFEST_BACKUP_KEY before it
/// is overwritten. A missing manifest (first upload to the bucket) is normal;
/// any other failure is logged but never blocks the upload itself.
async fn backup_previous(ctx: &S3Ctx) {
    let result = ctx
        .client
        .copy_object()
        .bucket(&ctx.bucket)
        .copy_source(format!("{}/{}", ctx.bucket, MANIFEST_KEY))
        .key(MANIFEST_BACKUP_KEY)
        .send()
        .await;
    if let Err(err) = result {
        let missing = matches!(&err, SdkError::ServiceError(context)
            if context.raw().status().as_u16() == 404);
        if !missing {
            eprintln!(
                "[manifest] backup copy failed: {}",
                aws_smithy_types::error::display::DisplayErrorContext(&err)
            );
        }
    }
}

fn build(app: &AppHandle) -> Result<Manifest> {
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();

    let photos = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {PHOTO_COLUMNS} FROM photos ORDER BY created_at"
        ))?;
        let rows = stmt
            .query_map([], db::photo_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let tags = {
        let mut stmt = conn.prepare("SELECT id, name, created_at FROM tags ORDER BY name")?;
        let rows = stmt
            .query_map([], |row| {
                Ok(TagRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let photo_tags = {
        let mut stmt = conn.prepare("SELECT photo_id, tag_id FROM photo_tags")?;
        let rows = stmt
            .query_map([], |row| {
                Ok(PhotoTagRow {
                    photo_id: row.get(0)?,
                    tag_id: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };

    Ok(Manifest {
        version: 1,
        exported_at: db::now(),
        photos,
        tags,
        photo_tags,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildReport {
    pub photos: usize,
    pub tags: usize,
    /// "manifest" when photobank-manifest.json was found, otherwise
    /// "listing" (bucket scan, EXIF/tags unavailable).
    pub source: &'static str,
}

/// Replace the local catalog with the bucket's contents. Prefers the
/// manifest; falls back to listing original objects (keys without a variant
/// suffix) when no manifest exists, e.g. a bucket written by the old web app.
#[tauri::command]
pub async fn rebuild_from_bucket(app: AppHandle) -> Result<RebuildReport> {
    // Rebuild is the one sanctioned way to (re-)bind the catalog to the
    // configured bucket, so record the identity along with the new catalog.
    let identity = {
        let state = app.state::<S3State>();
        let guard = state.0.read().await;
        guard
            .as_ref()
            .ok_or_else(|| Error::msg("S3 is not configured — open Settings first"))?
            .identity
            .clone()
    };

    let manifest = download_manifest(&app).await?;

    if let Some(manifest) = manifest {
        let report = RebuildReport {
            photos: manifest.photos.len(),
            tags: manifest.tags.len(),
            source: "manifest",
        };
        replace_catalog(&app, manifest, &identity)?;
        return Ok(report);
    }

    let originals = list_originals(&app).await?;
    let count = originals.len();
    replace_catalog_from_listing(&app, originals, &identity)?;
    // The listing path has no tag data; the next mutation re-uploads a
    // manifest so future rebuilds take the fast path.
    schedule_upload(&app);
    Ok(RebuildReport {
        photos: count,
        tags: 0,
        source: "listing",
    })
}

async fn download_manifest(app: &AppHandle) -> Result<Option<Manifest>> {
    let state = app.state::<S3State>();
    let guard = state.0.read().await;
    let ctx = guard
        .as_ref()
        .ok_or_else(|| Error::msg("S3 is not configured — open Settings first"))?;

    let response = ctx
        .client
        .get_object()
        .bucket(&ctx.bucket)
        .key(MANIFEST_KEY)
        .send()
        .await;
    let object = match response {
        Ok(object) => object,
        // Only a genuine "no such object" may trigger the listing fallback.
        // Any other failure (network, auth, throttling) must surface —
        // otherwise a transient error during rebuild would silently produce
        // a tag-less catalog and later overwrite the good manifest with it.
        Err(err) if manifest_is_missing(&err) => return Ok(None),
        Err(err) => {
            return Err(Error::msg(format!(
                "manifest download failed: {}",
                aws_smithy_types::error::display::DisplayErrorContext(&err)
            )))
        }
    };
    let bytes = object
        .body
        .collect()
        .await
        .map_err(|e| Error::msg(e.to_string()))?
        .into_bytes();
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|e| Error::msg(format!("manifest is not valid JSON: {e}")))?;
    Ok(Some(manifest))
}

fn manifest_is_missing(err: &SdkError<GetObjectError>) -> bool {
    match err {
        SdkError::ServiceError(context) => {
            context.err().is_no_such_key() || context.raw().status().as_u16() == 404
        }
        _ => false,
    }
}

fn replace_catalog(app: &AppHandle, manifest: Manifest, bucket_identity: &str) -> Result<()> {
    let db = app.state::<Db>();
    let mut guard = db.0.lock().unwrap();
    let tx = guard.transaction()?;

    tx.execute("DELETE FROM photo_tags", [])?;
    tx.execute("DELETE FROM tags", [])?;
    tx.execute("DELETE FROM photos", [])?;
    db::set_meta(&tx, db::META_CATALOG_BUCKET, bucket_identity)?;

    for p in &manifest.photos {
        tx.execute(
            "INSERT INTO photos (id, filename, s3_key, folder, mime_type, file_size, width,
                height, processing_status, camera_make, camera_model, lens, focal_length,
                aperture, shutter_speed, iso, taken_at, gps_latitude, gps_longitude,
                created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                ?17, ?18, ?19, ?20, ?21)",
            rusqlite::params![
                p.id,
                p.filename,
                p.s3_key,
                p.folder,
                p.mime_type,
                p.file_size,
                p.width,
                p.height,
                p.processing_status,
                p.camera_make,
                p.camera_model,
                p.lens,
                p.focal_length,
                p.aperture,
                p.shutter_speed,
                p.iso,
                p.taken_at,
                p.gps_latitude,
                p.gps_longitude,
                p.created_at,
                p.updated_at,
            ],
        )?;
    }
    for t in &manifest.tags {
        tx.execute(
            "INSERT INTO tags (id, name, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![t.id, t.name, t.created_at],
        )?;
    }
    for pt in &manifest.photo_tags {
        tx.execute(
            "INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?1, ?2)",
            rusqlite::params![pt.photo_id, pt.tag_id],
        )?;
    }

    tx.commit()?;
    Ok(())
}

/// Keys that are variants rather than originals: "<base>_<width>.<jpg|webp>".
fn is_variant_key(key: &str) -> bool {
    let Some(name) = key.rsplit('/').next() else {
        return false;
    };
    let Some(stem) = name.rsplit_once('.').map(|(stem, ext)| {
        (stem, matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "webp"))
    }) else {
        return false;
    };
    let (stem, is_variant_ext) = stem;
    if !is_variant_ext {
        return false;
    }
    stem.rsplit_once('_')
        .map(|(_, width)| matches!(width, "128" | "640" | "1280" | "2880"))
        .unwrap_or(false)
}

async fn list_originals(app: &AppHandle) -> Result<Vec<String>> {
    let state = app.state::<S3State>();
    let guard = state.0.read().await;
    let ctx = guard
        .as_ref()
        .ok_or_else(|| Error::msg("S3 is not configured — open Settings first"))?;

    let mut keys = Vec::new();
    let mut continuation: Option<String> = None;
    loop {
        let mut request = ctx.client.list_objects_v2().bucket(&ctx.bucket);
        if let Some(token) = &continuation {
            request = request.continuation_token(token);
        }
        let page = request.send().await.map_err(|e| {
            Error::msg(format!(
                "bucket listing failed: {}",
                aws_smithy_types::error::display::DisplayErrorContext(&e)
            ))
        })?;
        for object in page.contents() {
            if let Some(key) = object.key() {
                // Originals live at "folder/filename"; skip variants, the
                // manifest and its backup, and anything not in the
                // two-segment scheme
                if key == MANIFEST_KEY || key == MANIFEST_BACKUP_KEY || is_variant_key(key) {
                    continue;
                }
                if key.split('/').count() != 2 {
                    continue;
                }
                keys.push(key.to_string());
            }
        }
        match page.next_continuation_token() {
            Some(token) => continuation = Some(token.to_string()),
            None => break,
        }
    }
    Ok(keys)
}

fn replace_catalog_from_listing(
    app: &AppHandle,
    keys: Vec<String>,
    bucket_identity: &str,
) -> Result<()> {
    let db = app.state::<Db>();
    let mut guard = db.0.lock().unwrap();
    let tx = guard.transaction()?;

    tx.execute("DELETE FROM photo_tags", [])?;
    tx.execute("DELETE FROM tags", [])?;
    tx.execute("DELETE FROM photos", [])?;
    db::set_meta(&tx, db::META_CATALOG_BUCKET, bucket_identity)?;

    for key in keys {
        let Some((folder, filename)) = key.split_once('/') else {
            continue;
        };
        // Variants are assumed to exist (the old worker made them); EXIF and
        // dimensions are unknown from a listing, so those stay empty.
        tx.execute(
            "INSERT OR IGNORE INTO photos
                (id, filename, s3_key, folder, processing_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'completed', ?5, ?5)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                filename,
                key,
                folder,
                db::now(),
            ],
        )?;
    }

    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_variant_key, manifest_is_missing};
    use aws_sdk_s3::error::SdkError;
    use aws_sdk_s3::operation::get_object::GetObjectError;
    use aws_sdk_s3::types::error::NoSuchKey;
    use aws_smithy_runtime_api::http::{Response, StatusCode};
    use aws_smithy_types::body::SdkBody;

    fn service_error(err: GetObjectError, status: u16) -> SdkError<GetObjectError> {
        let raw = Response::new(StatusCode::try_from(status).unwrap(), SdkBody::empty());
        SdkError::service_error(err, raw)
    }

    #[test]
    fn a_missing_manifest_allows_the_listing_fallback() {
        let no_such_key = GetObjectError::NoSuchKey(NoSuchKey::builder().build());
        assert!(manifest_is_missing(&service_error(no_such_key, 404)));

        // Some S3-compatible services return a bare 404 without a NoSuchKey
        // error code
        let bare_404 = GetObjectError::generic(
            aws_sdk_s3::error::ErrorMetadata::builder().code("NotFound").build(),
        );
        assert!(manifest_is_missing(&service_error(bare_404, 404)));
    }

    #[test]
    fn transient_failures_do_not_allow_the_listing_fallback() {
        let throttled = GetObjectError::generic(
            aws_sdk_s3::error::ErrorMetadata::builder().code("SlowDown").build(),
        );
        assert!(!manifest_is_missing(&service_error(throttled, 503)));

        let denied = GetObjectError::generic(
            aws_sdk_s3::error::ErrorMetadata::builder().code("AccessDenied").build(),
        );
        assert!(!manifest_is_missing(&service_error(denied, 403)));

        let timeout: SdkError<GetObjectError> = SdkError::timeout_error(Box::new(
            std::io::Error::new(std::io::ErrorKind::TimedOut, "request timed out"),
        ));
        assert!(!manifest_is_missing(&timeout));
    }

    #[test]
    fn variant_keys_are_detected() {
        assert!(is_variant_key("inbox/photo_640.webp"));
        assert!(is_variant_key("inbox/photo_2880.jpg"));
        assert!(is_variant_key("inbox/photo_128.jpg"));
        assert!(!is_variant_key("inbox/photo.jpg"));
        assert!(!is_variant_key("inbox/photo_641.webp"));
        assert!(!is_variant_key("inbox/my_640.png"));
        assert!(!is_variant_key("inbox/sunset_beach.jpg"));
    }
}
