import { baseKey, encodeKey, type VariantWidth, type VariantFormat } from "./keys";

const CDN_BASE = process.env.NEXT_PUBLIC_CDN_URL;

type Resolution = `${VariantWidth}`;

function resolveUrl(key: string) {
  if (CDN_BASE) {
    return `${CDN_BASE}/${encodeKey(key)}`;
  }
  return `/api/images?key=${encodeURIComponent(key)}`;
}

export function imageUrl(
  s3Key: string,
  resolution: Resolution = "640",
  format: VariantFormat = "webp"
) {
  return resolveUrl(`${baseKey(s3Key)}_${resolution}.${format}`);
}

export function originalUrl(s3Key: string) {
  return resolveUrl(s3Key);
}
