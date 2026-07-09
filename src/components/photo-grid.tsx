"use client";

import {
  useEffect,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { imageUrl } from "@/lib/image-url";
import { PhotoLightbox } from "@/components/photo-lightbox";
import { usePhotoActions } from "@/hooks/use-photo-actions";
import type { UploadFile } from "@/hooks/use-upload";

export type PhotoGridRef = {
  refresh: () => Promise<void>;
};

type Props = {
  folder: string;
  /** In-flight uploads, rendered as tiles with an inline progress bar. */
  uploads?: UploadFile[];
  onDismissUpload?: (key: string) => void;
};

export const PhotoGrid = forwardRef<PhotoGridRef, Props>(function PhotoGrid(
  { folder, uploads = [], onDismissUpload },
  ref
) {
  const {
    photos,
    setPhotos,
    active,
    setActive,
    handleDelete,
    handleMove,
    handleRename,
  } = usePhotoActions();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPhotos = useCallback(() => {
    return fetch(`/api/photos?folder=${encodeURIComponent(folder)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setPhotos(data.photos);
        setError(null);
      })
      .catch(() => setError("Failed to load photos."))
      .finally(() => setLoading(false));
  }, [folder, setPhotos]);

  useEffect(() => {
    loadPhotos();
  }, [loadPhotos]);

  // Poll while any photos are still processing
  useEffect(() => {
    const hasUnfinished = photos.some(
      (p) => p.processingStatus === "pending" || p.processingStatus === "processing"
    );
    if (!hasUnfinished) return;

    const interval = setInterval(loadPhotos, 3000);
    return () => clearInterval(interval);
  }, [photos, loadPhotos]);

  useImperativeHandle(ref, () => ({ refresh: loadPhotos }));

  // Keep showing the local preview while the photo is pending/processing —
  // the real tile has nothing to render until the worker finishes. Hand off
  // only once the 640px variant has actually loaded (preloaded below), so the
  // preview is never replaced by a blank tile.
  const photoById = new Map(photos.map((p) => [p.id, p]));
  const activeUploads = uploads.filter(
    (u) => !u.id || photoById.get(u.id)?.processingStatus !== "failed"
  );
  const activeUploadIds = new Set(activeUploads.map((u) => u.id));
  const visiblePhotos = photos.filter((p) => !activeUploadIds.has(p.id));
  const uploadsAwaitingThumbnail = activeUploads.filter(
    (u) => u.id && photoById.get(u.id)?.processingStatus === "completed"
  );

  // Failed processing hands off to the photo tile, which owns the error state.
  useEffect(() => {
    if (!onDismissUpload) return;
    for (const u of uploads) {
      if (!u.id) continue;
      const photo = photos.find((p) => p.id === u.id);
      if (photo?.processingStatus === "failed") onDismissUpload(u.key);
    }
  }, [uploads, photos, onDismissUpload]);

  if (loading && !activeUploads.length) {
    return <p className="text-sm text-foreground/60">Loading photos...</p>;
  }

  if (error && !activeUploads.length) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  if (!photos.length && !activeUploads.length) {
    return (
      <p className="text-sm text-foreground/60">No photos in this folder.</p>
    );
  }

  return (
    <>
      {onDismissUpload &&
        uploadsAwaitingThumbnail.map((upload) => (
          <img
            key={upload.key}
            src={imageUrl(photoById.get(upload.id!)!.s3Key, "640", "webp")}
            alt=""
            className="hidden"
            onLoad={() => onDismissUpload(upload.key)}
            onError={() => onDismissUpload(upload.key)}
          />
        ))}
      <div className="fade-in grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {activeUploads.map((upload) => (
          <UploadTile
            key={upload.key}
            upload={upload}
            onDismiss={onDismissUpload}
          />
        ))}
        {visiblePhotos.map((photo) => (
          <button
            key={photo.id}
            onClick={() => setActive(photo)}
            className="group relative aspect-square overflow-hidden rounded-md bg-foreground/5"
          >
            {photo.processingStatus === "completed" ? (
              <img
                src={imageUrl(photo.s3Key, "640", "webp")}
                alt={photo.filename}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <span className="text-xs text-foreground/40">
                  {photo.processingStatus === "pending" && "Pending..."}
                  {photo.processingStatus === "processing" &&
                    "Processing..."}
                  {photo.processingStatus === "failed" && "Failed"}
                </span>
              </div>
            )}
          </button>
        ))}
      </div>

      {active && (
        <PhotoLightbox
          photo={active}
          onClose={() => setActive(null)}
          onDelete={handleDelete}
          onMove={handleMove}
          onRename={handleRename}
        />
      )}
    </>
  );
});

/** A grid tile for an in-flight upload: image preview + inline progress. */
function UploadTile({
  upload,
  onDismiss,
}: {
  upload: UploadFile;
  onDismiss?: (key: string) => void;
}) {
  const failed = upload.status === "error";

  return (
    <div className="fade-in relative aspect-square overflow-hidden rounded-md bg-foreground/5">
      <img
        src={upload.previewUrl}
        alt={upload.file.name}
        className="h-full w-full object-cover"
      />
      <div
        className={`absolute inset-0 ${failed ? "bg-red-950/50" : "bg-background/40"}`}
      />

      {failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <span className="text-xs font-medium text-red-100">Failed</span>
          {onDismiss && (
            <button
              type="button"
              onClick={() => onDismiss(upload.key)}
              className="rounded-md bg-background/80 px-2 py-1 text-xs text-foreground/70 transition-colors hover:text-foreground"
            >
              Dismiss
            </button>
          )}
        </div>
      ) : upload.status === "done" ? (
        <span className="absolute left-2 top-2 rounded bg-background/70 px-1.5 py-0.5 text-[11px] font-medium text-foreground/70">
          Processing…
        </span>
      ) : (
        <>
          <span className="absolute left-2 top-2 rounded bg-background/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-foreground/70">
            {upload.progress}%
          </span>
          <div className="absolute inset-x-0 bottom-0 h-1 bg-foreground/10">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${upload.progress}%` }}
            />
          </div>
        </>
      )}
    </div>
  );
}
