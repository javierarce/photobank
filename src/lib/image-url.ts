import { encodeKey, variantBase, type VariantWidth, type VariantFormat } from "./keys";

type Resolution = `${VariantWidth}`;

// Served by the `photo://` protocol handler in src-tauri: it returns the
// object from the local disk cache, fetching it from S3 first when missing.
// WKWebView rewrites custom schemes to http://<scheme>.localhost/<path>.
function resolveUrl(key: string) {
  return `photo://localhost/${encodeKey(key)}`;
}

export function imageUrl(
  s3Key: string,
  resolution: Resolution = "640",
  format: VariantFormat = "webp"
) {
  return resolveUrl(`${variantBase(s3Key)}_${resolution}.${format}`);
}

export function originalUrl(s3Key: string) {
  return resolveUrl(s3Key);
}

// Served by the `preview://` protocol handler in src-tauri: it reads the bytes
// of a local file path off disk. Used to preview a dropped/picked image in its
// upload tile before the import finishes. `path` is an absolute filesystem
// path; encode it whole (slashes included) into a single URL path segment.
export function previewUrl(path: string) {
  return `preview://localhost/${encodeURIComponent(path)}`;
}
