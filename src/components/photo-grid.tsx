import {
  useEffect,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { imageUrl } from "@/lib/image-url";
import { listPhotos } from "@/lib/api";
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
    return listPhotos(folder)
      .then((photos) => {
        setPhotos(photos);
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

  // Hide uploads whose real photo has already arrived from the API so the tile
  // hands off seamlessly instead of briefly showing a duplicate.
  const photoIds = new Set(photos.map((p) => p.id));
  const pendingUploads = uploads.filter((u) => !u.id || !photoIds.has(u.id));

  if (loading && !pendingUploads.length) {
    return <p className="text-sm text-foreground/60">Loading photos...</p>;
  }

  if (error && !pendingUploads.length) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  if (!photos.length && !pendingUploads.length) {
    return (
      <p className="text-sm text-foreground/60">No photos in this folder.</p>
    );
  }

  return (
    <>
      <div className="fade-in grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {pendingUploads.map((upload) => (
          <UploadTile
            key={upload.key}
            upload={upload}
            onDismiss={onDismissUpload}
          />
        ))}
        {photos.map((photo) => (
          <button
            key={photo.id}
            onClick={() => setActive(photo)}
            className="group relative aspect-square overflow-hidden rounded-md bg-foreground/5"
          >
            {photo.processingStatus === "completed" ? (
              <img
                src={imageUrl(photo.s3Key, "640", "webp")}
                alt={photo.filename}
                className="h-full w-full object-cover transition-transform group-hover:scale-105"
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

/** A grid tile for an in-flight import: filename + inline progress. The
 * pixels arrive when the finished photo replaces this tile, so the preview
 * is a quiet placeholder rather than a local file read. */
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
      <div className="flex h-full items-center justify-center p-3">
        <span className="max-w-full truncate font-mono text-xs text-foreground/50">
          {upload.filename}
        </span>
      </div>

      {failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-red-950/50">
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
