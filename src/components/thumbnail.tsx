import { useState } from "react";
import { imageUrl, originalUrl } from "@/lib/image-url";
import { ThumbnailFallback } from "@/components/thumbnail-fallback";
import type { Photo } from "@/lib/types";

/** A grid/result thumbnail that never shows a broken image. The on-brand
 * placeholder sits behind the picture; the picture is invisible until it
 * actually loads, then fades in over the placeholder. So a variant/original
 * that's missing, still downloading, or that fails to decode simply leaves the
 * placeholder showing — never the browser's broken-image glyph. We can't rely
 * on `onError` alone here: for the custom `photo://` scheme WKWebView doesn't
 * reliably fire it, so visibility is gated on a successful `onLoad` instead. */
export function Thumbnail({ photo }: { photo: Photo }) {
  const [loaded, setLoaded] = useState(false);
  // When the 640px variant is missing from the bucket (original synced in
  // externally, refresh not done yet), fall back to the original object.
  const [fallback, setFallback] = useState(false);
  // Retry from scratch when the key changes (rename/move) or the row is touched
  // at all — a refresh regenerates variants under the same key and bumps
  // updated_at, and the tile instance survives the reload (keyed by id).
  const marker = `${photo.s3Key}@${photo.updatedAt}`;
  const [prevMarker, setPrevMarker] = useState(marker);
  if (prevMarker !== marker) {
    setPrevMarker(marker);
    setLoaded(false);
    setFallback(false);
  }
  return (
    <>
      {!loaded && (
        <div className="absolute inset-0">
          <ThumbnailFallback />
        </div>
      )}
      <img
        // Remount on any marker change so onLoad reliably re-fires — a refresh
        // can bump updatedAt without changing a non-fallback tile's src, and the
        // browser won't re-fire onLoad for an already-loaded, unchanged src,
        // which would otherwise strand the placeholder over a good thumbnail.
        key={marker}
        src={
          fallback ? originalUrl(photo.s3Key) : imageUrl(photo.s3Key, "640", "webp")
        }
        alt={photo.filename}
        className={`h-full w-full object-cover transition-opacity duration-150 ease-out ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
        loading="lazy"
        draggable={false}
        onLoad={() => setLoaded(true)}
        // A missing 640px variant drops to the original; if that's gone too the
        // image just stays hidden and the placeholder remains.
        onError={() => setFallback(true)}
      />
    </>
  );
}
