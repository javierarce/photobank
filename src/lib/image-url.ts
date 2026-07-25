import { encodeKey, variantBase, type VariantWidth, type VariantFormat } from "./keys";

type Resolution = `${VariantWidth}`;

// Served by the `photo://` protocol handler in src-tauri: it returns the
// object from the local disk cache, fetching it from S3 (or the CDN) first
// when missing. WKWebView rewrites custom schemes to
// http://<scheme>.localhost/<path>.
//
// `version` is a cache-buster, not part of the key: the handler reads only the
// URL path, so the query string never reaches S3. Replacing a photo keeps its
// key — that's the point — but the response is served `immutable`, so without
// a changing query the webview would show the old pixels until relaunch. Pass
// the photo's `updatedAt`, which every mutation bumps.
function resolveUrl(key: string, version?: string) {
  const url = `photo://localhost/${encodeKey(key)}`;
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}

export function imageUrl(
  s3Key: string,
  resolution: Resolution = "640",
  format: VariantFormat = "webp",
  version?: string
) {
  return resolveUrl(`${variantBase(s3Key)}_${resolution}.${format}`, version);
}

export function originalUrl(s3Key: string, version?: string) {
  return resolveUrl(s3Key, version);
}

// Served by the `preview://` protocol handler in src-tauri: it reads the bytes
// of a local file path off disk. Used to preview a dropped/picked image in its
// upload tile before the import finishes. `path` is an absolute filesystem
// path; encode it whole (slashes included) into a single URL path segment.
export function previewUrl(path: string) {
  return `preview://localhost/${encodeURIComponent(path)}`;
}
