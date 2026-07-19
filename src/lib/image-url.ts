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
