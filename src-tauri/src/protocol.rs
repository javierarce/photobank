use std::path::{Path, PathBuf};
use std::time::SystemTime;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::sync::atomic::{AtomicBool, Ordering};
use sha2::{Digest, Sha256};
use crate::error::{Error, Result};

#[derive(Default)]
pub struct CacheState {
    locks: Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>,
    eviction_pending: AtomicBool,
    eviction_running: AtomicBool,
}

fn key_lock(app: &AppHandle, path: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let state = app.state::<CacheState>();
    let mut locks = state.locks.lock().unwrap();
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(Weak::upgrade) { return lock; }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
    lock
}


use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

/// Disk budget for everything except the pinned 640px thumbnails. Oldest
/// files are evicted first (by mtime — most large variants are viewed once,
/// so plain age is a good-enough LRU stand-in).
const LARGE_CACHE_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Serve `photo://localhost/<s3-key>` from the disk cache, fetching from the
/// CDN (or S3) on a miss. Grid thumbnails and lightbox images all go through
/// here, which makes fetch-through and offline reads transparent to the
/// frontend. A `?v=` query is ignored — see `resolveUrl` in
/// src/lib/image-url.ts for why callers add one.
pub async fn handle(app: AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match respond(&app, request.uri().path()).await {
        Ok(response) => response,
        Err((status, message)) => Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(message.into_bytes())
            .expect("static response builder never fails"),
    }
}

/// Serve `preview://localhost/<percent-encoded-absolute-path>` straight off
/// the local disk. Dropped/picked images arrive as filesystem paths (not
/// `File` objects, since Tauri intercepts the OS drag), so this lets an
/// upload tile show the source pixels before the import finishes. Reads are
/// gated to supported image extensions so the scheme can't be pointed at
/// arbitrary local files.
pub async fn handle_preview(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match respond_preview(request.uri().path()).await {
        Ok(response) => response,
        Err((status, message)) => Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(message.into_bytes())
            .expect("static response builder never fails"),
    }
}

async fn respond_preview(
    path: &str,
) -> std::result::Result<Response<Vec<u8>>, (StatusCode, String)> {
    let local = decode_local_path(path)
        .ok_or((StatusCode::BAD_REQUEST, "invalid preview path".to_string()))?;
    if !is_previewable(&local) {
        return Err((StatusCode::FORBIDDEN, "unsupported preview type".to_string()));
    }
    let bytes = tokio::fs::read(&local)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, format!("read failed: {e}")))?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type(&local.to_string_lossy()))
        // A path can be reused (same drop retried) with different bytes, so
        // don't let the webview cache a stale preview.
        .header(header::CACHE_CONTROL, "no-store")
        .body(bytes)
        .expect("response builder with static headers never fails"))
}

/// Percent-decode the whole URL path into an absolute filesystem path. Unlike
/// `decode_key`, the path is decoded as one string (its own slashes are
/// encoded), and it must be absolute — a defensive guard, not a security
/// boundary, since the scheme only ever serves local image files.
fn decode_local_path(path: &str) -> Option<PathBuf> {
    let decoded = percent_decode_str(path.trim_start_matches('/'))
        .decode_utf8()
        .ok()?
        .to_string();
    if decoded.is_empty() || !decoded.starts_with('/') || decoded.contains('\0') {
        return None;
    }
    Some(PathBuf::from(decoded))
}

/// Only serve the formats the importer accepts (mirrors keys.rs
/// `SUPPORTED_EXTENSIONS`), all of which WKWebView can decode.
fn is_previewable(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("jpg") | Some("jpeg") | Some("png") | Some("webp")
    )
}

async fn respond(
    app: &AppHandle,
    path: &str,
) -> std::result::Result<Response<Vec<u8>>, (StatusCode, String)> {
    let key = decode_key(path).ok_or((StatusCode::BAD_REQUEST, "invalid key".to_string()))?;
    let bytes = fetch_bytes(app, &key).await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type(&key))
        .header(header::CACHE_CONTROL, "no-store")
        .body(bytes)
        .expect("response builder with static headers never fails"))
}

/// All reads use the same namespace and per-object lock as import/replace.
/// Capture the namespace before awaiting: a late response from an old bucket
/// or rebuild may only populate its old namespace.
pub async fn fetch_bytes(app: &AppHandle, key: &str) -> Result<Vec<u8>> {
    let (identity, epoch) = namespace(app);
    let path = object_path(&cache_dir(app), &identity, &epoch, key);
    let lock = key_lock(app, &path);
    let _guard = lock.lock().await;
    if let Ok(bytes) = tokio::fs::read(&path).await {
        if image::guess_format(&bytes).is_ok() { return Ok(bytes); }
        let _ = tokio::fs::remove_file(&path).await;
    }
    let ctx = {
        let state = app.state::<crate::settings::S3State>();
        let guard = state.0.read().await;
        guard.clone().ok_or_else(|| Error::msg("S3 is not configured"))?
    };
    if ctx.identity != identity {
        return Err(Error::msg("The catalog belongs to a different bucket. Rebuild it in Settings before downloading images."));
    }
    let bytes = crate::cdn::get_object_from(&ctx, key).await?;
    image::guess_format(&bytes).map_err(|_| Error::msg("The downloaded object is not a supported image"))?;
    write_cache(&path, &bytes).await;
    schedule_eviction(app);
    Ok(bytes)
}

/// Percent-decode the URL path into an S3 key, rejecting anything that could
/// escape the cache directory when joined onto it.
fn decode_key(path: &str) -> Option<String> {
    let mut segments = Vec::new();
    for raw in path.trim_start_matches('/').split('/') {
        let segment = percent_decode_str(raw).decode_utf8().ok()?.to_string();
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.contains(['/', '\\', '\0'])
        {
            return None;
        }
        segments.push(segment);
    }
    if segments.is_empty() {
        return None;
    }
    Some(segments.join("/"))
}

fn content_type(key: &str) -> &'static str {
    let ext = key.rsplit('.').next().map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("webp") => "image/webp",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("tif") | Some("tiff") => "image/tiff",
        _ => "application/octet-stream",
    }
}

fn cache_dir(app: &AppHandle) -> PathBuf {
    crate::paths::cache(app).join("photos-v2")
}

fn namespace(app: &AppHandle) -> (String, String) {
    let db = app.state::<crate::db::Db>();
    let conn = db.0.lock().unwrap();
    (
        crate::db::get_meta(&conn, crate::db::META_CATALOG_BUCKET).ok().flatten().unwrap_or_default(),
        crate::db::get_meta(&conn, "cache_epoch").ok().flatten().unwrap_or_default(),
    )
}

fn object_path(root: &Path, identity: &str, epoch: &str, key: &str) -> PathBuf {
    let namespace = format!("{:x}", Sha256::digest(format!("{}:{identity}{epoch}", identity.len()).as_bytes()));
    let name = format!("{:x}.image", Sha256::digest(key.as_bytes()));
    root.join(namespace).join(if is_pinned(key) { "pinned" } else { "large" }).join(name)
}

/// 640px thumbnails are small and power the instant grid — never evicted.
fn is_pinned(key: &str) -> bool {
    key.rsplit('/')
        .next()
        .map(|name| name.contains("_640."))
        .unwrap_or(false)
}

/// Seed the cache from elsewhere in the app (the importer writes freshly
/// generated variants here so the grid renders without refetching from S3).
pub async fn cache_put(app: &AppHandle, key: &str, data: &[u8]) {
    let path = cache_path(app, key);
    let lock = key_lock(app, &path);
    let _guard = lock.lock().await;
    write_cache(&path, data).await;
    schedule_eviction(app);
}

pub fn cache_path(app: &AppHandle, key: &str) -> PathBuf {
    let (identity, epoch) = namespace(app);
    object_path(&cache_dir(app), &identity, &epoch, key)
}

pub async fn remove_cache(app: &AppHandle, key: &str) {
    let path = cache_path(app, key);
    let lock = key_lock(app, &path);
    let _guard = lock.lock().await;
    let _ = tokio::fs::remove_file(path).await;
}

fn schedule_eviction(app: &AppHandle) {
    let state = app.state::<CacheState>();
    state.eviction_pending.store(true, Ordering::SeqCst);
    if state.eviction_running.swap(true, Ordering::SeqCst) { return; }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            app.state::<CacheState>().eviction_pending.store(false, Ordering::SeqCst);
            let root = cache_dir(&app);
            let _ = tauri::async_runtime::spawn_blocking(move || evict_large(&root)).await;
            let state = app.state::<CacheState>();
            state.eviction_running.store(false, Ordering::SeqCst);
            if !state.eviction_pending.load(Ordering::SeqCst)
                || state.eviction_running.swap(true, Ordering::SeqCst) { break; }
        }
    });
}

async fn write_cache(path: &Path, data: &[u8]) {
    if let Some(parent) = path.parent() {
        if tokio::fs::create_dir_all(parent).await.is_err() {
            return;
        }
    }
    // Write to a temp sibling then rename, so a crash mid-write never leaves
    // a truncated image that would be served forever.
    let tmp = path.with_extension(format!("{}.tmp-download", uuid::Uuid::new_v4()));
    if tokio::fs::write(&tmp, data).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, path).await;
    }
    let _ = tokio::fs::remove_file(&tmp).await;
}

fn evict_large(dir: &Path) {
    evict_to_budget(dir, LARGE_CACHE_CAP_BYTES);
}

fn evict_to_budget(dir: &Path, budget: u64) {
    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    collect_files(dir, &mut files);

    let mut large: Vec<_> = files
        .into_iter()
        .filter(|(path, _, _)| {
            !path.components().any(|part| part.as_os_str() == "pinned")
                && path.extension().is_some_and(|ext| ext == "image")
        })
        .collect();

    let total: u64 = large.iter().map(|(_, size, _)| size).sum();
    if total <= budget {
        return;
    }

    large.sort_by_key(|(_, _, mtime)| *mtime);
    let mut excess = total - budget;
    for (path, size, _) in large {
        if excess == 0 {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            excess = excess.saturating_sub(size);
        }
    }
}

fn collect_files(dir: &Path, out: &mut Vec<(PathBuf, u64, SystemTime)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out);
        } else if let Ok(meta) = entry.metadata() {
            let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            out.push((path, meta.len(), mtime));
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn cache_paths_separate_bucket_endpoint_epoch_case_and_format() {
        let root = std::path::Path::new("cache");
        let paths: std::collections::HashSet<_> = [
            ("bucket-a", "", "inbox/photo.jpg"),
            ("bucket-b", "", "inbox/photo.jpg"),
            ("bucket-a @ https://example.test", "", "inbox/photo.jpg"),
            ("bucket-a", "rebuilt", "inbox/photo.jpg"),
            ("bucket-a", "", "inbox/Photo.jpg"),
            ("bucket-a", "", "inbox/photo.webp"),
        ].into_iter().map(|(bucket, epoch, key)| super::object_path(root, bucket, epoch, key).to_string_lossy().to_lowercase()).collect();
        assert_eq!(paths.len(), 6, "paths must differ even on a case-insensitive filesystem");
    }

    #[tokio::test]
    async fn concurrent_cache_writes_preserve_each_formats_complete_bytes() {
        let temp = crate::test_support::TempDir::new();
        let jpg = temp.0.join("photo.jpg");
        let webp = temp.0.join("photo.webp");
        let jpg_bytes = vec![1; 100_000];
        let webp_bytes = vec![2; 100_000];
        tokio::join!(super::write_cache(&jpg, &jpg_bytes), super::write_cache(&webp, &webp_bytes));
        assert_eq!(std::fs::read(&jpg).unwrap(), jpg_bytes);
        assert_eq!(std::fs::read(&webp).unwrap(), webp_bytes);
        assert_eq!(std::fs::read_dir(&temp.0).unwrap().count(), 2);
    }

    #[tokio::test]
    async fn cache_eviction_enforces_the_budget_without_removing_thumbnails_or_temporary_files() {
        let temp = crate::test_support::TempDir::new();
        let pinned = super::object_path(&temp.0, "bucket", "", "inbox/photo_640.webp");
        let large = super::object_path(&temp.0, "bucket", "", "inbox/photo.jpg");
        super::write_cache(&pinned, &[1; 100]).await;
        super::write_cache(&large, &[2; 100]).await;
        let in_flight = large.with_extension("tmp-download");
        std::fs::write(&in_flight, [3; 100]).unwrap();
        super::evict_to_budget(&temp.0, 0);
        assert!(pinned.exists());
        assert!(in_flight.exists());
        assert!(!large.exists());
    }
    use super::{content_type, decode_key, decode_local_path, is_pinned, is_previewable};
    use std::path::PathBuf;

    #[test]
    fn decode_local_path_decodes_absolute_paths() {
        assert_eq!(
            decode_local_path("/%2FUsers%2Fjav%2Fmy%20photo.jpg"),
            Some(PathBuf::from("/Users/jav/my photo.jpg"))
        );
    }

    #[test]
    fn decode_local_path_rejects_relative_and_empty() {
        assert_eq!(decode_local_path("/"), None);
        assert_eq!(decode_local_path("/relative%2Fpath.jpg"), None);
    }

    #[test]
    fn previewable_gates_on_supported_extensions() {
        assert!(is_previewable(&PathBuf::from("/a/b.jpg")));
        assert!(is_previewable(&PathBuf::from("/a/b.JPEG")));
        assert!(is_previewable(&PathBuf::from("/a/b.png")));
        assert!(is_previewable(&PathBuf::from("/a/b.webp")));
        assert!(!is_previewable(&PathBuf::from("/a/b.gif")));
        assert!(!is_previewable(&PathBuf::from("/a/secrets.txt")));
        assert!(!is_previewable(&PathBuf::from("/a/noext")));
    }

    #[test]
    fn decode_key_decodes_segments() {
        assert_eq!(
            decode_key("/my%20photos/caf%C3%A9%20%231_640.webp"),
            Some("my photos/café #1_640.webp".to_string())
        );
        assert_eq!(decode_key("/inbox/a.jpg"), Some("inbox/a.jpg".to_string()));
    }

    #[test]
    fn decode_key_rejects_traversal() {
        assert_eq!(decode_key("/../etc/passwd"), None);
        assert_eq!(decode_key("/inbox/%2E%2E/secret"), None);
        assert_eq!(decode_key("/inbox/a%2Fb.jpg"), None);
        assert_eq!(decode_key("/"), None);
    }

    #[test]
    fn pinning_targets_640_thumbnails() {
        assert!(is_pinned("inbox/photo_640.webp"));
        assert!(is_pinned("inbox/photo_640.jpg"));
        assert!(!is_pinned("inbox/photo_2880.webp"));
        assert!(!is_pinned("inbox/photo.jpg"));
        // The variant marker only counts in the filename, not the folder
        assert!(!is_pinned("trip_640.photos/original.jpg"));
    }

    #[test]
    fn content_types_cover_served_formats() {
        assert_eq!(content_type("a/b_640.webp"), "image/webp");
        assert_eq!(content_type("a/b_1280.jpg"), "image/jpeg");
        assert_eq!(content_type("a/b.PNG"), "image/png");
        assert_eq!(content_type("a/original"), "application/octet-stream");
    }
}
