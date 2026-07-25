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

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS, NON_ALPHANUMERIC};
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

/// RFC 1738's "unsafe" characters. These, plus non-ASCII (which
/// percent_encoding always escapes), are the ONLY things CloudFront wants
/// encoded in an invalidation path:
///
/// > If the path includes non-ASCII characters or unsafe characters as defined
/// > in RFC 1738, URL-encode those characters. Don't URL-encode any other
/// > characters in the path, or CloudFront won't invalidate the old version of
/// > the updated file.
///
/// So invalidation paths can NOT reuse `COMPONENT` above, which also escapes
/// `& + , : ; = @ $` — a photo named "Ben & Jerry.jpg" would be encoded into a
/// path CloudFront silently fails to match, and the stale object would survive
/// its full year-long max-age.
const INVALIDATION_UNSAFE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'<')
    .add(b'>')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'{')
    .add(b'}')
    .add(b'|')
    .add(b'\\')
    .add(b'^')
    .add(b'~')
    .add(b'[')
    .add(b']')
    .add(b'`');

/// The absolute URL path CloudFront serves an object at — for *fetching* it.
pub fn request_path(key: &str) -> String {
    format!("/{}", encode_key(key))
}

/// The path CloudFront matches an *invalidation* against. Different rules from
/// `request_path` (see INVALIDATION_UNSAFE); `/` is left alone because it
/// isn't unsafe and has to stay a separator.
fn invalidation_path(key: &str) -> String {
    format!("/{}", utf8_percent_encode(key, INVALIDATION_UNSAFE))
}

/// CloudFront can't match an invalidation path containing `~` — "whether it's
/// URL-encoded or not" — so any target carrying one has to be widened to
/// something that doesn't.
fn unmatchable(name: &str) -> bool {
    name.contains('~')
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
    let url = format!("{base}{}", request_path(key));
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

/// CloudFront's invalidation quotas are rate-based: "150 paths or tags per
/// second" and "1 wildcard invalidation per second". Every path we send
/// carries a wildcard, so the second row binds — and its wording doesn't say
/// whether "a wildcard invalidation" counts a path or a request.
///
/// This is calibrated for the stricter reading (per path): DEBOUNCE spaces
/// flushes 2s apart, so 2 paths per flush averages the documented 1/second. If
/// the looser reading turns out to hold, this is merely more conservative than
/// it needs to be — which costs blast radius, not correctness. Exceeding it
/// would cost the whole invalidation, silently, since the send is best-effort.
///
/// An older "15 wildcard paths in progress" quota no longer appears in the
/// docs; don't recalibrate against it.
const MAX_WILDCARD_PATHS: usize = 2;

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

/// Send anything still queued, synchronously, before the process goes away.
///
/// The queue is debounced and lives only in memory, so quitting inside the
/// window would drop it with no retry on next launch — and a dropped delete
/// leaves the photo edge-fetchable for its full year-long max-age. Bounded so
/// a hung network can't wedge quit; a crash or force-quit can still lose the
/// batch, which is the price of the queue not being persisted.
pub fn flush_on_exit(app: &AppHandle) {
    let targets: Vec<Target> = {
        let state = app.state::<InvalidationState>();
        let mut pending = state.pending.lock().unwrap();
        pending.drain().collect()
    };
    if targets.is_empty() {
        return;
    }
    let app = app.clone();
    let _ = tauri::async_runtime::block_on(tokio::time::timeout(
        EXIT_FLUSH_TIMEOUT,
        async move { invalidate_paths(&app, collapse(&targets)).await },
    ));
}

/// Quit shouldn't hang on an unreachable CloudFront.
const EXIT_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

fn photo_path(s3_key: &str) -> String {
    format!("{}*", invalidation_path(crate::keys::variant_base(s3_key)))
}

fn folder_path(folder: &str) -> String {
    format!("{}/*", invalidation_path(folder))
}

/// Reduce a batch of targets to at most `MAX_WILDCARD_PATHS` paths, widening
/// in steps as the batch grows: one path per photo, then one per folder, then
/// the whole distribution. Widening only costs origin refetches, and
/// S3→CloudFront transfer is free; overshooting the quota costs the entire
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
                // A '~' in the filename makes the per-photo path unmatchable,
                // but the folder's own path usually still works.
                if unmatchable(key) {
                    folders.insert(folder);
                } else {
                    by_folder.entry(folder).or_default().push(key.as_str());
                }
            }
        }
    }
    // A whole-folder target already covers every photo inside it.
    by_folder.retain(|folder, _| !folders.contains(folder));

    // A '~' in a *folder* name leaves nothing narrower than the distribution
    // that CloudFront can match.
    if folders.iter().chain(by_folder.keys()).any(|f| unmatchable(f)) {
        return vec!["/*".to_string()];
    }

    let mut paths: Vec<String> = folders.iter().map(|f| folder_path(f)).collect();
    for keys in by_folder.values() {
        paths.extend(keys.iter().map(|key| photo_path(key)));
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
    fn request_path_is_the_encoded_key_rooted_at_slash() {
        assert_eq!(request_path("inbox/photo.jpg"), "/inbox/photo.jpg");
        // Spaces and non-ASCII must be percent-encoded or the URL won't
        // resolve. This is the *fetch* path — invalidation encodes differently.
        assert_eq!(
            request_path("my photos/café #1.jpg"),
            "/my%20photos/caf%C3%A9%20%231.jpg"
        );
        // Slashes stay slashes; encodeURIComponent's unreserved set survives.
        assert_eq!(request_path("a(1)!~*'/b_c-d.e"), "/a(1)!~*'/b_c-d.e");
    }

    #[test]
    fn suffixed_duplicates_encode_the_way_a_browser_would_request_them() {
        // "photo (1).jpg" is what an import collision produces, and parens are
        // unreserved — only the space is escaped.
        assert_eq!(request_path("inbox/photo (1).jpg"), "/inbox/photo%20(1).jpg");
    }

    /// The wildcard `invalidate_photo` builds, without the network call.
    fn photo_pattern(s3_key: &str) -> String {
        photo_path(s3_key)
    }

    /// Does CloudFront's trailing-`*` wildcard cover this key?
    fn covers(pattern: &str, key: &str) -> bool {
        pattern
            .strip_suffix('*')
            .is_some_and(|prefix| invalidation_path(key).starts_with(prefix))
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
        let paths = collapse(&photos("berlin", 2));
        assert_eq!(
            paths,
            vec!["/berlin/photo0*".to_string(), "/berlin/photo1*".to_string()]
        );
    }

    #[test]
    fn invalidation_paths_encode_only_rfc1738_unsafe_characters() {
        // AWS: "Don't URL-encode any other characters in the path, or
        // CloudFront won't invalidate the old version of the updated file."
        // The request-URL set would escape every one of these.
        assert_eq!(
            photo_path("berlin/Ben & Jerry, cafe@home; a+b=c$d:e.jpg"),
            "/berlin/Ben%20&%20Jerry,%20cafe@home;%20a+b=c$d:e*"
        );
        // Unsafe and non-ASCII still get encoded.
        assert_eq!(
            photo_path("my photos/café #1.jpg"),
            "/my%20photos/caf%C3%A9%20%231*"
        );
        assert_eq!(photo_path("a/b%c{d}e|f.jpg"), "/a/b%25c%7Bd%7De%7Cf*");
    }

    #[test]
    fn a_tilde_widens_because_cloudfront_cannot_match_it_at_all() {
        // AWS: "CloudFront doesn't support this character for invalidations,
        // whether it's URL-encoded or not." Emitting the per-photo path would
        // be a silent no-op, so the folder stands in for it.
        assert_eq!(
            collapse(&[Target::Photo("berlin/photo~1.jpg".into())]),
            vec!["/berlin/*".to_string()]
        );
        // Nothing narrower than the distribution can reach a '~' folder.
        assert_eq!(
            collapse(&[Target::Photo("ber~lin/photo.jpg".into())]),
            vec!["/*".to_string()]
        );
        assert_eq!(
            collapse(&[Target::Folder("ber~lin".into())]),
            vec!["/*".to_string()]
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
    fn widening_stops_at_folder_level_while_that_fits() {
        let mut targets = photos("berlin", 10);
        targets.extend(photos("lisbon", 2));
        // Per-photo would be 12 paths; per-folder is 2, which fits — so it
        // widens one step and no further, rather than taking the whole
        // distribution.
        assert_eq!(
            collapse(&targets),
            vec!["/berlin/*".to_string(), "/lisbon/*".to_string()]
        );
    }

    #[test]
    fn never_exceeds_the_wildcard_budget() {
        // Bulk-deleting a search result that spans more folders than the
        // budget allows: even one path per folder is too many, so it widens
        // all the way rather than emitting a batch that gets throttled.
        let targets: Vec<Target> = (0..40)
            .flat_map(|n| photos(&format!("folder{n}"), 2))
            .collect();
        let paths = collapse(&targets);
        assert!(
            paths.len() <= MAX_WILDCARD_PATHS,
            "emitted {} paths, over budget: {paths:?}",
            paths.len()
        );
        assert_eq!(paths, vec!["/*".to_string()]);
    }

    #[test]
    fn every_shape_of_batch_stays_within_budget() {
        // The property that matters, independent of any single expectation
        // above: no batch, however shaped, emits more wildcard paths than the
        // budget allows.
        for folders in [1usize, 2, 3, 12, 40] {
            for per_folder in [1usize, 2, 5, 200] {
                let targets: Vec<Target> = (0..folders)
                    .flat_map(|n| photos(&format!("folder{n}"), per_folder))
                    .collect();
                let paths = collapse(&targets);
                assert!(
                    paths.len() <= MAX_WILDCARD_PATHS,
                    "{folders} folders x {per_folder} photos emitted {} paths",
                    paths.len()
                );
            }
        }
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
