use std::path::{Path, PathBuf};
use std::time::SystemTime;

use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

use crate::settings::S3State;

/// Disk budget for everything except the pinned 640px thumbnails. Oldest
/// files are evicted first (by mtime — most large variants are viewed once,
/// so plain age is a good-enough LRU stand-in).
const LARGE_CACHE_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Serve `photo://localhost/<s3-key>` from the disk cache, fetching from S3
/// on a miss. Grid thumbnails and lightbox images all go through here, which
/// makes S3 fetch-through and offline reads transparent to the frontend.
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

async fn respond(
    app: &AppHandle,
    path: &str,
) -> std::result::Result<Response<Vec<u8>>, (StatusCode, String)> {
    let key = decode_key(path).ok_or((StatusCode::BAD_REQUEST, "invalid key".to_string()))?;
    let cache_path = cache_dir(app).join(&key);

    let bytes = match tokio::fs::read(&cache_path).await {
        Ok(bytes) => bytes,
        Err(_) => fetch_and_cache(app, &key, &cache_path).await?,
    };

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type(&key))
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(bytes)
        .expect("response builder with static headers never fails"))
}

async fn fetch_and_cache(
    app: &AppHandle,
    key: &str,
    cache_path: &Path,
) -> std::result::Result<Vec<u8>, (StatusCode, String)> {
    let state = app.state::<S3State>();
    let guard = state.0.read().await;
    let ctx = guard
        .as_ref()
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "S3 is not configured".to_string()))?;

    let object = ctx
        .client
        .get_object()
        .bucket(&ctx.bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, format!("fetch failed: {e}")))?;
    let data = object
        .body
        .collect()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?
        .into_bytes()
        .to_vec();
    drop(guard);

    write_cache(cache_path, &data).await;
    if !is_pinned(key) {
        let dir = cache_dir(app);
        tauri::async_runtime::spawn_blocking(move || evict_large(&dir));
    }
    Ok(data)
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
    app.path()
        .app_cache_dir()
        .expect("app cache dir is always resolvable on macOS")
        .join("photos")
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
    write_cache(&cache_dir(app).join(key), data).await;
}

/// Where a key lives (or would live) in the disk cache.
pub fn cache_path(app: &AppHandle, key: &str) -> PathBuf {
    cache_dir(app).join(key)
}

async fn write_cache(path: &Path, data: &[u8]) {
    if let Some(parent) = path.parent() {
        if tokio::fs::create_dir_all(parent).await.is_err() {
            return;
        }
    }
    // Write to a temp sibling then rename, so a crash mid-write never leaves
    // a truncated image that would be served forever.
    let tmp = path.with_extension("tmp-download");
    if tokio::fs::write(&tmp, data).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, path).await;
    }
}

fn evict_large(dir: &Path) {
    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    collect_files(dir, &mut files);

    let mut large: Vec<_> = files
        .into_iter()
        .filter(|(path, _, _)| {
            !path
                .file_name()
                .map(|n| n.to_string_lossy().contains("_640."))
                .unwrap_or(false)
        })
        .collect();

    let total: u64 = large.iter().map(|(_, size, _)| size).sum();
    if total <= LARGE_CACHE_CAP_BYTES {
        return;
    }

    large.sort_by_key(|(_, _, mtime)| *mtime);
    let mut excess = total - LARGE_CACHE_CAP_BYTES;
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
    use super::{content_type, decode_key, is_pinned};

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
