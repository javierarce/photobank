//! CDN integration: reading objects through a CloudFront domain instead of
//! S3, and invalidating cached paths whenever an object's bytes change or its
//! key goes away.
//!
//! Both halves are optional and independent (see `S3Settings::cloudfront_*`).
//! Reads fall back to S3 whenever the CDN can't serve them, and invalidation
//! is always best-effort: it must never fail the mutation that triggered it,
//! because a stale edge cache is recoverable while a half-applied delete or
//! rename is not.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::settings::{S3Ctx, S3State};

/// encodeURIComponent's unreserved set, applied per path segment — matches
/// `encode_key` in photos.rs and `encodeKey` in src/lib/keys.ts, so a key
/// resolves to the same URL path everywhere (app, CloudFront, blog).
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

/// The absolute URL path CloudFront caches an object under: "/" + the encoded
/// key. Also the shape an invalidation path takes.
pub fn cdn_path(key: &str) -> String {
    format!("/{}", encode_key(key))
}

/// Fetch an object's bytes, preferring the CDN when one is configured.
///
/// The CDN is only ever an optimisation: a distribution that isn't set up yet,
/// an object the bucket policy doesn't expose, or a plain network blip all
/// fall through to S3 rather than surfacing an error. That keeps a
/// half-configured CDN from making the whole library unreadable.
pub async fn get_object(app: &AppHandle, key: &str) -> Result<Vec<u8>> {
    let state = app.state::<S3State>();
    let guard = state.0.read().await;
    let ctx = guard
        .as_ref()
        .ok_or_else(|| Error::msg("S3 is not configured — open Settings first"))?;

    if let Some(base) = ctx.cdn_read_base.as_deref() {
        if let Some(bytes) = get_via_cdn(base, key).await {
            return Ok(bytes);
        }
    }
    get_via_s3(ctx, key).await
}

/// How long to wait on the CDN before giving up and asking S3. Without a
/// timeout a distribution that accepts the connection but never answers would
/// hang the read forever instead of falling back.
const CDN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// One shared client for every CDN read. `reqwest::get` would build a fresh
/// one per call, so a grid of thumbnails would pay a TLS handshake per tile
/// instead of reusing pooled connections. None if the client can't be built,
/// which just means every read falls through to S3.
fn http() -> Option<&'static reqwest::Client> {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| reqwest::Client::builder().timeout(CDN_TIMEOUT).build().ok())
        .as_ref()
}

/// None on any failure — the caller falls back to S3, so there's nothing
/// useful to report and every reason not to fail the read.
async fn get_via_cdn(base: &str, key: &str) -> Option<Vec<u8>> {
    let url = format!("{base}{}", cdn_path(key));
    let response = http()?.get(&url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    // The Domain setting is free text, so it can point at a host that answers
    // 200 with an HTML error/parking page. Whatever comes back here is written
    // to the disk cache under the photo's key and served as an image forever
    // after — and 640px thumbnails are pinned, so that poisoning never ages
    // out. Anything that isn't an image falls through to S3 instead.
    let is_image = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim_start().starts_with("image/"));
    if !is_image {
        return None;
    }
    Some(response.bytes().await.ok()?.to_vec())
}

async fn get_via_s3(ctx: &S3Ctx, key: &str) -> Result<Vec<u8>> {
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
    Ok(bytes)
}

/// How long to wait for more mutations before flushing. Bulk delete and bulk
/// move fire their per-photo commands concurrently, and a batch replace does
/// the same, so a short quiet period is enough to see a whole batch as one.
const DEBOUNCE: Duration = Duration::from_secs(2);

/// CloudFront allows only 15 invalidation paths *containing a wildcard* to be
/// in progress per distribution — a separate, much smaller quota than the
/// 3,000 for individually-named files. Every path here has a wildcard, so a
/// batch bigger than this gets rejected with TooManyInvalidationsInProgress;
/// and since invalidation is best-effort, that rejection would be swallowed
/// and leave deleted photos edge-fetchable for their full year-long max-age.
/// Note the quota counts paths, not requests: putting 50 stems in one
/// CreateInvalidation is still 50 wildcard paths and still fails.
const MAX_WILDCARD_PATHS: usize = 15;

/// A folder contributing at least this many photos collapses to a single
/// "/folder/*". Below it, per-photo paths keep the blast radius tight.
const FOLDER_COLLAPSE: usize = 4;

/// Something whose CDN copies are now wrong.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Target {
    /// One photo, by its s3_key: the original and every derivative it owns.
    Photo(String),
    /// Every object under a folder.
    Folder(String),
}

/// Pending invalidations plus the generation counter that debounces the
/// flush, mirroring manifest::schedule_upload.
#[derive(Default)]
pub struct InvalidationState {
    pending: Arc<Mutex<HashSet<Target>>>,
    generation: Arc<AtomicU64>,
}

/// Queue one photo — its original and every derivative — for invalidation.
///
/// The path is a wildcard on the photo's variant stem rather than a list of
/// the nine keys it may own, because CloudFront also bills per path: 1000 a
/// month are free, then half a cent each. Nine paths per photo would put a
/// 200-photo bulk delete over the line; one keeps it well inside. The stem can
/// also match a prefix-sharing sibling ("a.jpg" invalidating "apple.jpg"),
/// which costs that sibling one origin fetch — and S3→CloudFront transfer is
/// free, so over-matching is the cheap side to err on. It's also stricter
/// coverage: any derivative naming this list doesn't know about is swept up.
pub fn invalidate_photo(app: &AppHandle, s3_key: &str) {
    schedule(app, Target::Photo(s3_key.to_string()));
}

/// Queue everything under a folder, for a rename that re-keys all of it.
pub fn invalidate_folder(app: &AppHandle, folder: &str) {
    schedule(app, Target::Folder(folder.to_string()));
}

fn schedule(app: &AppHandle, target: Target) {
    let state = app.state::<InvalidationState>();
    state.pending.lock().unwrap().insert(target);

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let counter = state.generation.clone();
    let pending = state.pending.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DEBOUNCE).await;
        if counter.load(Ordering::SeqCst) != generation {
            return; // superseded — a later mutation will flush this one too
        }
        let targets: Vec<Target> = pending.lock().unwrap().drain().collect();
        invalidate_paths(&app, collapse(&targets)).await;
    });
}

fn photo_path(s3_key: &str) -> String {
    format!("{}*", cdn_path(crate::keys::variant_base(s3_key)))
}

fn folder_path(folder: &str) -> String {
    format!("{}/*", cdn_path(folder))
}

/// Reduce a batch of targets to at most `MAX_WILDCARD_PATHS` paths, widening
/// them as the batch grows: per-photo while a folder has few, one path for the
/// whole folder once it has several, and — only if there are more folders than
/// the quota allows — the entire distribution. Widening costs nothing but
/// origin refetches, which are free; exceeding the quota costs the whole
/// invalidation.
fn collapse(targets: &[Target]) -> Vec<String> {
    let mut folders: HashSet<&str> = HashSet::new();
    let mut by_folder: HashMap<&str, Vec<&str>> = HashMap::new();
    for target in targets {
        match target {
            Target::Folder(folder) => {
                folders.insert(folder.as_str());
            }
            Target::Photo(key) => {
                let folder = key.split('/').next().unwrap_or_default();
                by_folder.entry(folder).or_default().push(key.as_str());
            }
        }
    }
    // A whole-folder target already covers every photo inside it.
    by_folder.retain(|folder, _| !folders.contains(folder));

    let mut paths: Vec<String> = folders.iter().map(|f| folder_path(f)).collect();
    for (folder, keys) in &by_folder {
        if keys.len() >= FOLDER_COLLAPSE {
            paths.push(folder_path(folder));
        } else {
            paths.extend(keys.iter().map(|key| photo_path(key)));
        }
    }
    paths.sort();
    paths.dedup();
    if paths.len() <= MAX_WILDCARD_PATHS {
        return paths;
    }

    let mut collapsed: Vec<String> = folders
        .iter()
        .chain(by_folder.keys())
        .map(|f| folder_path(f))
        .collect();
    collapsed.sort();
    collapsed.dedup();
    if collapsed.len() <= MAX_WILDCARD_PATHS {
        return collapsed;
    }
    vec!["/*".to_string()]
}

/// Best-effort CreateInvalidation. Failures are swallowed: the caller has
/// already committed its change, and an invalidation that didn't land only
/// means the edge serves the old bytes until its TTL runs out.
async fn invalidate_paths(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let cdn = {
        let state = app.state::<S3State>();
        let guard = state.0.read().await;
        match guard.as_ref().and_then(|ctx| ctx.cdn.clone()) {
            Some(cdn) => cdn,
            None => return,
        }
    };

    let Ok(items) = aws_sdk_cloudfront::types::Paths::builder()
        .quantity(paths.len() as i32)
        .set_items(Some(paths))
        .build()
    else {
        return;
    };
    // CallerReference dedupes retries of the *same* request; every call here is
    // a distinct change, so a fresh id each time is what we want.
    let Ok(batch) = aws_sdk_cloudfront::types::InvalidationBatch::builder()
        .paths(items)
        .caller_reference(uuid::Uuid::new_v4().to_string())
        .build()
    else {
        return;
    };

    let _ = cdn
        .client
        .create_invalidation()
        .distribution_id(&cdn.distribution_id)
        .invalidation_batch(batch)
        .send()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cdn_path_is_the_encoded_key_rooted_at_slash() {
        assert_eq!(cdn_path("inbox/photo.jpg"), "/inbox/photo.jpg");
        // Spaces and non-ASCII must be percent-encoded — CloudFront rejects
        // raw ones in an invalidation path, and the URL wouldn't resolve.
        assert_eq!(
            cdn_path("my photos/café #1.jpg"),
            "/my%20photos/caf%C3%A9%20%231.jpg"
        );
        // Slashes stay slashes; encodeURIComponent's unreserved set survives.
        assert_eq!(cdn_path("a(1)!~*'/b_c-d.e"), "/a(1)!~*'/b_c-d.e");
    }

    #[test]
    fn suffixed_duplicates_encode_the_way_a_browser_would_request_them() {
        // "photo (1).jpg" is what an import collision produces, and parens are
        // unreserved — only the space is escaped.
        assert_eq!(cdn_path("inbox/photo (1).jpg"), "/inbox/photo%20(1).jpg");
    }

    /// The wildcard `invalidate_photo` builds, without the network call.
    fn photo_pattern(s3_key: &str) -> String {
        format!("{}*", cdn_path(crate::keys::variant_base(s3_key)))
    }

    /// Does CloudFront's trailing-`*` wildcard cover this key?
    fn covers(pattern: &str, key: &str) -> bool {
        pattern
            .strip_suffix('*')
            .is_some_and(|prefix| cdn_path(key).starts_with(prefix))
    }

    #[test]
    fn one_wildcard_covers_a_photo_and_every_derivative_it_owns() {
        let pattern = photo_pattern("inbox/photo.jpg");
        assert!(covers(&pattern, "inbox/photo.jpg"), "the original itself");
        assert!(covers(&pattern, "inbox/photo_640.webp"));
        assert!(covers(&pattern, "inbox/photo_2880.jpg"));
        // Legacy widths this code no longer writes are swept up too.
        assert!(covers(&pattern, "inbox/photo_128.jpg"));
        // A different photo in the same folder is left alone.
        assert!(!covers(&pattern, "inbox/other.jpg"));
    }

    #[test]
    fn legacy_originals_invalidate_under_their_stripped_stem() {
        // "<base>_original.jpg" keeps its variants at "<base>_<width>", so the
        // wildcard has to start from the stripped stem to reach both.
        let pattern = photo_pattern("calella/R0007098_original.jpg");
        assert_eq!(pattern, "/calella/R0007098*");
        assert!(covers(&pattern, "calella/R0007098_original.jpg"));
        assert!(covers(&pattern, "calella/R0007098_640.webp"));
    }

    #[test]
    fn wildcards_are_encoded_so_cloudfront_accepts_them() {
        // A raw space in an invalidation path is rejected outright.
        assert_eq!(photo_pattern("my photos/café.jpg"), "/my%20photos/caf%C3%A9*");
    }

    fn photos(folder: &str, count: usize) -> Vec<Target> {
        (0..count)
            .map(|n| Target::Photo(format!("{folder}/photo{n}.jpg")))
            .collect()
    }

    #[test]
    fn a_small_batch_keeps_per_photo_paths() {
        let paths = collapse(&photos("berlin", 3));
        assert_eq!(
            paths,
            vec![
                "/berlin/photo0*".to_string(),
                "/berlin/photo1*".to_string(),
                "/berlin/photo2*".to_string(),
            ]
        );
    }

    #[test]
    fn a_bulk_delete_collapses_to_one_path_per_folder() {
        // The case that motivated this: handleBulkDelete fires one command per
        // photo concurrently, and CloudFront only allows 15 wildcard paths in
        // progress — 200 per-photo paths would have most of them rejected.
        let paths = collapse(&photos("berlin", 200));
        assert_eq!(paths, vec!["/berlin/*".to_string()]);
    }

    #[test]
    fn a_folder_target_absorbs_its_own_photos() {
        let mut targets = photos("berlin", 2);
        targets.push(Target::Folder("berlin".into()));
        // A rename already invalidates the whole prefix; listing its photos
        // again would just burn quota on paths the folder path covers.
        assert_eq!(collapse(&targets), vec!["/berlin/*".to_string()]);
    }

    #[test]
    fn mixed_folders_collapse_only_where_they_need_to() {
        let mut targets = photos("berlin", 10);
        targets.extend(photos("lisbon", 2));
        let paths = collapse(&targets);
        assert_eq!(
            paths,
            vec![
                "/berlin/*".to_string(),
                "/lisbon/photo0*".to_string(),
                "/lisbon/photo1*".to_string(),
            ]
        );
    }

    #[test]
    fn never_exceeds_the_wildcard_quota() {
        // Many folders, each too small to collapse on its own: the per-folder
        // pass alone would still emit more paths than CloudFront accepts.
        let targets: Vec<Target> = (0..40)
            .flat_map(|n| photos(&format!("folder{n}"), 2))
            .collect();
        let paths = collapse(&targets);
        assert!(
            paths.len() <= MAX_WILDCARD_PATHS,
            "emitted {} paths, over the quota: {paths:?}",
            paths.len()
        );
        // More folders than the quota allows, so it widens all the way.
        assert_eq!(paths, vec!["/*".to_string()]);
    }

    #[test]
    fn folders_within_the_quota_stay_scoped_rather_than_nuking_everything() {
        let targets: Vec<Target> = (0..12)
            .flat_map(|n| photos(&format!("folder{n}"), 5))
            .collect();
        let paths = collapse(&targets);
        assert_eq!(paths.len(), 12);
        assert!(paths.contains(&"/folder0/*".to_string()));
        // Widening stops at folder level while that still fits the quota.
        assert!(!paths.contains(&"/*".to_string()));
    }

    #[test]
    fn duplicate_targets_cost_one_path() {
        // A replace queues the same stem twice if the user retries.
        let targets = vec![
            Target::Photo("berlin/a.jpg".into()),
            Target::Photo("berlin/a.jpg".into()),
        ];
        assert_eq!(collapse(&targets), vec!["/berlin/a*".to_string()]);
    }

    #[test]
    fn an_empty_batch_produces_no_request() {
        assert!(collapse(&[]).is_empty());
    }
}
