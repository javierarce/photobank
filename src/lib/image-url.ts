const CDN_BASE = process.env.NEXT_PUBLIC_CDN_URL;

type Resolution = "128" | "640" | "1280" | "2880";
type Format = "jpg" | "webp";

function resolveUrl(key: string) {
  if (CDN_BASE) {
    return `${CDN_BASE}/${key}`;
  }
  return `/api/images?key=${encodeURIComponent(key)}`;
}

export function imageUrl(
  s3Key: string,
  resolution: Resolution = "640",
  format: Format = "webp"
) {
  const base = s3Key.replace(/\.[^.]+$/, "");
  return resolveUrl(`${base}_${resolution}.${format}`);
}

export function originalUrl(s3Key: string) {
  return resolveUrl(s3Key);
}
