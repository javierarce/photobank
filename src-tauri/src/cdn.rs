//! CDN integration: reading objects through a CloudFront domain instead of
//! S3, and invalidating cached paths whenever an object's bytes change or its
//! key goes away.
//!
//! Both halves are optional and independent (see `S3Settings::cloudfront_*`).
//! Reads fall back to S3 whenever the CDN can't serve them, and invalidation
//! is always best-effort: it must never fail the mutation that triggered it,
//! because a stale edge cache is recoverable while a half-applied delete or
//! rename is not.

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

/// Drop one photo — its original and every derivative — from the CDN's edge
/// caches. A no-op when no distribution is configured.
///
/// This is a wildcard on the photo's variant stem rather than a list of the
/// nine keys it may own, because CloudFront bills per *path*: 1000 a month are
/// free, then half a cent each. Nine paths per photo would put a 200-photo
/// bulk delete over the line; one keeps it well inside. The stem can also
/// match a prefix-sharing sibling ("a.jpg" invalidating "apple.jpg"), which
/// costs that sibling one origin fetch — and S3→CloudFront transfer is free,
/// so over-matching is the cheap side to err on. It's also stricter coverage:
/// any derivative naming this list doesn't know about is swept up anyway.
pub async fn invalidate_photo(app: &AppHandle, s3_key: &str) {
    let stem = crate::keys::variant_base(s3_key);
    invalidate_paths(app, vec![format!("{}*", cdn_path(stem))]).await;
}

/// Drop everything under a folder, for a rename that re-keys all of it.
pub async fn invalidate_folder(app: &AppHandle, folder: &str) {
    invalidate_paths(app, vec![format!("{}/*", cdn_path(folder))]).await;
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
}
