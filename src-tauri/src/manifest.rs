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
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{self, Db, Photo, PHOTO_COLUMNS};
use crate::error::{friendly_s3_error, Error, Result};
use crate::settings::{S3Ctx, S3State};

pub const MANIFEST_KEY: &str = "photobank-manifest.json";
/// Emitted while the listing fallback pages through the bucket, so a rebuild
/// over a large bucket shows movement instead of a frozen "Rebuilding…".
pub const REBUILD_PROGRESS_EVENT: &str = "rebuild://progress";
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
        .map_err(|e| Error::msg(format!("manifest upload: {}", friendly_s3_error(&e))))?;
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
            eprintln!("[manifest] backup copy failed: {}", friendly_s3_error(&err));
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildProgress {
    /// Objects (originals + variants) listed so far.
    pub scanned: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildReport {
    pub photos: usize,
    pub tags: usize,
    /// "manifest" when photobank-manifest.json was found, otherwise
    /// "listing" (bucket scan, EXIF/tags unavailable).
    pub source: &'static str,
    /// Photos left without variants/metadata (never processed by this app —
    /// e.g. synced into the bucket externally). A background refresh has
    /// already been started for them.
    pub needs_refresh: usize,
}

/// Replace the local catalog with the bucket's contents. The listing decides
/// WHICH photos exist — the bucket's objects are the source of truth, so
/// photos the manifest never knew (e.g. variant-only sets from the earliest
/// web pipeline) appear and rows whose objects vanished drop out. The
/// manifest, when present, contributes ids, metadata, and tags for the keys
/// it knows, so loaded EXIF and tagging survive a rebuild.
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
    let originals = list_originals(&app).await?;

    let source: &'static str = if manifest.is_some() { "manifest" } else { "listing" };
    let (photos, tags) = replace_catalog(&app, originals, manifest, &identity)?;
    // Persist the merge (rescued photos, corrected variant flags) so the
    // manifest converges on what the bucket actually holds.
    schedule_upload(&app);

    // The merge can leave rows whose variants are missing from the bucket
    // (originals synced in externally without derivatives). Those would show
    // broken tiles — start regenerating them in the background right away.
    // EXIF/dimensions are NOT backfilled here; they load on demand per photo.
    let needs_refresh = {
        let db = app.state::<crate::db::Db>();
        let conn = db.0.lock().unwrap();
        crate::refresh::pending_count(&conn)?
    };
    if needs_refresh > 0 {
        crate::refresh::spawn_if_needed(&app);
    }
    Ok(RebuildReport { photos, tags, source, needs_refresh })
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
                friendly_s3_error(&err)
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

/// Rewrite the catalog as: one row per listed original, carrying the
/// manifest's metadata when it knows the key and a bare listing-derived row
/// otherwise. Returns (photos, tags) written.
fn replace_catalog(
    app: &AppHandle,
    originals: Vec<ListedOriginal>,
    manifest: Option<Manifest>,
    bucket_identity: &str,
) -> Result<(usize, usize)> {
    let manifest = manifest.unwrap_or(Manifest {
        version: 1,
        exported_at: String::new(),
        photos: Vec::new(),
        tags: Vec::new(),
        photo_tags: Vec::new(),
    });
    let by_key: std::collections::HashMap<&str, &Photo> = manifest
        .photos
        .iter()
        .map(|p| (p.s3_key.as_str(), p))
        .collect();

    let db = app.state::<Db>();
    let mut guard = db.0.lock().unwrap();
    let tx = guard.transaction()?;

    tx.execute("DELETE FROM photo_tags", [])?;
    tx.execute("DELETE FROM tags", [])?;
    tx.execute("DELETE FROM photos", [])?;
    db::set_meta(&tx, db::META_CATALOG_BUCKET, bucket_identity)?;

    let photos = originals.len();
    let mut kept_ids: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for original in &originals {
        if let Some(p) = by_key.get(original.key.as_str()) {
            kept_ids.insert(p.id.as_str());
            tx.execute(
                "INSERT INTO photos (id, filename, s3_key, folder, mime_type, file_size, width,
                    height, processing_status, camera_make, camera_model, lens, focal_length,
                    aperture, shutter_speed, iso, taken_at, gps_latitude, gps_longitude,
                    variants_ok, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                    ?17, ?18, ?19, ?20, ?21, ?22)",
                rusqlite::params![
                    p.id,
                    p.filename,
                    p.s3_key,
                    p.folder,
                    p.mime_type,
                    p.file_size.or(original.size),
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
                    // The listing just looked at the bucket — fresher than
                    // whatever the manifest recorded.
                    original.has_variants,
                    p.created_at,
                    p.updated_at,
                ],
            )?;
        } else {
            let Some((folder, filename)) = original.key.split_once('/') else {
                continue;
            };
            // Size and variant presence come from the listing itself; EXIF
            // and dimensions are unknown until the user loads them per photo.
            tx.execute(
                "INSERT OR IGNORE INTO photos
                    (id, filename, s3_key, folder, mime_type, file_size, variants_ok,
                     processing_status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'completed', ?8, ?8)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    filename,
                    original.key,
                    folder,
                    crate::pipeline::mime_for_extension(filename),
                    original.size,
                    original.has_variants,
                    db::now(),
                ],
            )?;
        }
    }

    for t in &manifest.tags {
        tx.execute(
            "INSERT INTO tags (id, name, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![t.id, t.name, t.created_at],
        )?;
    }
    for pt in &manifest.photo_tags {
        // Associations only survive for photos whose object is still in the
        // bucket; the photos FK would reject the rest anyway.
        if !kept_ids.contains(pt.photo_id.as_str()) {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?1, ?2)",
            rusqlite::params![pt.photo_id, pt.tag_id],
        )?;
    }

    // A manifest snapshotted mid-batch (schedule_upload fires per completed
    // photo) can carry pending/processing rows for imports that never finished.
    // Restoring runs mid-session, so the startup sweep won't catch them — flip
    // them here, in the same transaction, so a rebuild can't reinstate a wedged
    // row that blocks its name and keeps the grid's processing poll alive.
    db::reconcile_interrupted_imports(&tx)?;

    tx.commit()?;
    Ok((photos, manifest.tags.len()))
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

/// An original object found by scanning the bucket. `has_variants` comes from
/// the same listing (the photo's `_640.webp` key was seen), so the rebuild
/// never needs a per-photo HEAD or download to know a photo is displayable.
struct ListedOriginal {
    key: String,
    size: Option<i64>,
    has_variants: bool,
}

async fn list_originals(app: &AppHandle) -> Result<Vec<ListedOriginal>> {
    let state = app.state::<S3State>();
    let guard = state.0.read().await;
    let ctx = guard
        .as_ref()
        .ok_or_else(|| Error::msg("S3 is not configured — open Settings first"))?;

    let mut entries = Vec::new();
    let mut continuation: Option<String> = None;
    loop {
        let mut request = ctx.client.list_objects_v2().bucket(&ctx.bucket);
        if let Some(token) = &continuation {
            request = request.continuation_token(token);
        }
        let page = request
            .send()
            .await
            .map_err(|e| Error::msg(format!("bucket listing failed: {}", friendly_s3_error(&e))))?;
        for object in page.contents() {
            if let Some(key) = object.key() {
                entries.push((key.to_string(), object.size()));
            }
        }
        let _ = app.emit(REBUILD_PROGRESS_EVENT, RebuildProgress { scanned: entries.len() });
        match page.next_continuation_token() {
            Some(token) => continuation = Some(token.to_string()),
            None => break,
        }
    }
    Ok(originals_from_listing(entries))
}

/// Split a full bucket listing into cataloged originals, resolving each one's
/// `has_variants` against the variant keys seen in the same listing. The
/// 640px webp stands in for the whole set — every view needs it, and both
/// pipelines (old web worker, this app) write all widths together.
///
/// Two rescue rules for width-suffixed images, which `is_variant_key` alone
/// would misread:
/// - A "variant" that has its own derivative set (`<key stem>_640.webp` in
///   the listing) is really a photo — e.g. a Nikon `DSC_1280.jpg` imported
///   by this app. It is cataloged as a normal original.
/// - A variant set with no original at all (an early version of the old web
///   pipeline didn't store one) is cataloged under its largest variant as a
///   stand-in original. The stand-in keeps its full stem — `variant_base`
///   never strips width markers — so the refresh generates a fresh
///   derivative set from it rather than reusing the orphaned one.
fn originals_from_listing(entries: Vec<(String, Option<i64>)>) -> Vec<ListedOriginal> {
    // Cataloged photos live at "folder/filename" and must be images; the
    // manifest, its backup, videos, and deeper paths are not photos.
    let is_candidate = |key: &str| {
        key != MANIFEST_KEY
            && key != MANIFEST_BACKUP_KEY
            && crate::keys::is_supported_image(key)
            && key.split('/').count() == 2
    };
    let variant_keys: std::collections::HashSet<&str> = entries
        .iter()
        .filter(|(key, _)| is_variant_key(key))
        .map(|(key, _)| key.as_str())
        .collect();
    let has_grid_variant = |key: &str| {
        variant_keys.contains(
            crate::keys::variant_key(key, 640, crate::keys::VariantFormat::Webp).as_str(),
        )
    };
    let is_original =
        |key: &str| is_candidate(key) && (!is_variant_key(key) || has_grid_variant(key));

    let mut originals: Vec<ListedOriginal> = entries
        .iter()
        .filter(|(key, _)| is_original(key))
        .map(|(key, size)| ListedOriginal {
            has_variants: has_grid_variant(key),
            key: key.clone(),
            size: *size,
        })
        .collect();

    // Orphaned variant sets: group leftovers by their old-pipeline stem and
    // pick the best stand-in per group (largest width, jpg over webp),
    // skipping stems a real original already covers.
    let covered: std::collections::HashSet<&str> = originals
        .iter()
        .map(|original| crate::keys::variant_base(&original.key))
        .collect();
    let mut stand_ins: std::collections::BTreeMap<&str, (u8, &String, Option<i64>)> =
        std::collections::BTreeMap::new();
    for (key, size) in &entries {
        if !is_candidate(key) || is_original(key) {
            continue;
        }
        let stem = orphan_stem(key);
        if covered.contains(stem) {
            continue;
        }
        let rank = stand_in_rank(key);
        let entry = stand_ins.entry(stem).or_insert((rank, key, *size));
        if rank < entry.0 {
            *entry = (rank, key, *size);
        }
    }
    drop(covered);
    originals.extend(stand_ins.into_values().map(|(_, key, size)| ListedOriginal {
        has_variants: has_grid_variant(key),
        key: key.clone(),
        size,
    }));
    originals
}

/// The stem an old-pipeline derivative hangs off, width marker stripped.
/// ONLY for grouping orphaned variants during a rebuild — global key
/// derivation (keys::variant_base) must never strip widths, because real
/// photos are named like `DSC_1280.jpg` too. Misgrouping here is harmless:
/// it can only affect keys that would otherwise not be cataloged at all.
fn orphan_stem(key: &str) -> &str {
    let base = crate::keys::variant_base(key);
    match base.rsplit_once('_') {
        Some((stem, "128" | "640" | "1280" | "2880")) => stem,
        _ => base,
    }
}

/// Stand-in preference for an orphaned variant set: the largest width first
/// (closest to the lost original), jpg over webp at equal width.
fn stand_in_rank(key: &str) -> u8 {
    let width = match crate::keys::base_key(key).rsplit_once('_') {
        Some((_, "2880")) => 0,
        Some((_, "1280")) => 2,
        Some((_, "640")) => 4,
        _ => 6,
    };
    width + u8::from(!key.to_ascii_lowercase().ends_with(".jpg"))
}

#[cfg(test)]
mod tests {
    use super::{is_variant_key, manifest_is_missing, originals_from_listing};
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
    fn listing_resolves_variant_presence_without_extra_requests() {
        let entries = vec![
            // Current scheme, complete set.
            ("inbox/full.jpg".to_string(), Some(100)),
            ("inbox/full_640.webp".to_string(), Some(10)),
            ("inbox/full_640.jpg".to_string(), Some(10)),
            // Original synced in without derivatives.
            ("inbox/bare.jpg".to_string(), Some(200)),
            // Legacy web-pipeline scheme: original carries the _original
            // marker, variants hang off the stripped stem.
            ("trips/R001_original.jpg".to_string(), Some(300)),
            ("trips/R001_640.webp".to_string(), Some(30)),
            // Noise the catalog must ignore.
            ("photobank-manifest.json".to_string(), Some(1)),
            ("photobank-manifest.prev.json".to_string(), Some(1)),
            ("not-nested".to_string(), Some(1)),
            ("a/b/too-deep.jpg".to_string(), Some(1)),
            // Non-image content sharing the bucket is not a photo.
            ("films/charulata-1964.mp4".to_string(), Some(900)),
        ];

        let originals = originals_from_listing(entries);
        let by_key: std::collections::HashMap<&str, &super::ListedOriginal> =
            originals.iter().map(|o| (o.key.as_str(), o)).collect();

        assert_eq!(originals.len(), 3);
        assert!(by_key["inbox/full.jpg"].has_variants);
        assert_eq!(by_key["inbox/full.jpg"].size, Some(100));
        assert!(!by_key["inbox/bare.jpg"].has_variants);
        assert!(by_key["trips/R001_original.jpg"].has_variants);
    }

    #[test]
    fn orphaned_variant_sets_are_cataloged_under_their_largest_variant() {
        // The earliest web pipeline didn't store an original object at all —
        // e.g. photobank.systems' copenhaguen folder holds 26 such photos.
        let entries = vec![
            // Orphaned set: the 2880 jpg is the closest thing to an
            // original left, so it becomes the catalog row's key.
            ("cph/P508_640.webp".to_string(), Some(6)),
            ("cph/P508_1280.jpg".to_string(), Some(12)),
            ("cph/P508_2880.jpg".to_string(), Some(28)),
            ("cph/P508_2880.webp".to_string(), Some(27)),
            // Sparse orphan: only a 1280 jpg survives.
            ("cph/P509_1280.jpg".to_string(), Some(13)),
            // Not an orphan: its original is present, so its variants must
            // not produce a second catalog row.
            ("cph/P510_original.jpg".to_string(), Some(50)),
            ("cph/P510_2880.jpg".to_string(), Some(25)),
        ];

        let originals = originals_from_listing(entries);
        let by_key: std::collections::HashMap<&str, &super::ListedOriginal> =
            originals.iter().map(|o| (o.key.as_str(), o)).collect();

        assert_eq!(originals.len(), 3);
        // Stand-ins keep their full stem (variant_base never strips widths),
        // so their fresh derivative set ("…_2880_640.webp") doesn't exist yet
        // and the refresh regenerates it from the stand-in bytes.
        let full = by_key["cph/P508_2880.jpg"];
        assert!(!full.has_variants);
        assert_eq!(full.size, Some(28));
        assert!(!by_key["cph/P509_1280.jpg"].has_variants);
        assert!(by_key.contains_key("cph/P510_original.jpg"));
    }

    #[test]
    fn width_named_photos_with_their_own_derivatives_are_originals() {
        let entries = vec![
            // A Nikon-style counter name this app previously imported: its
            // own derivative set proves it is a photo, not a derivative of
            // some "inbox/DSC" — it must keep its row and its variants.
            ("inbox/DSC_1280.jpg".to_string(), Some(40)),
            ("inbox/DSC_1280_640.webp".to_string(), Some(4)),
            ("inbox/DSC_1280_2880.jpg".to_string(), Some(20)),
            // A never-imported sibling: rescued as a stand-in of its own,
            // not merged into DSC_1280's derivatives.
            ("inbox/DSC_2880.jpg".to_string(), Some(41)),
        ];

        let originals = originals_from_listing(entries);
        let by_key: std::collections::HashMap<&str, &super::ListedOriginal> =
            originals.iter().map(|o| (o.key.as_str(), o)).collect();

        assert_eq!(originals.len(), 2, "{:?}", by_key.keys());
        assert!(by_key["inbox/DSC_1280.jpg"].has_variants);
        assert!(!by_key["inbox/DSC_2880.jpg"].has_variants);
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
