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
import { SelectionCheck } from "@/components/selection-check";
import { usePhotoActions } from "@/hooks/use-photo-actions";
import { useSelection, useThumbnailActivation } from "@/hooks/use-selection";
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
    handleBulkDelete,
    handleBulkMove,
    handleRename,
  } = usePhotoActions();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { selected, isSelected, clear, selectAll, setPool, setActions } =
    useSelection();
  const { onClick, onDoubleClick } = useThumbnailActivation(setActive);

  // Expose bulk actions to the toolbar while this grid is on screen; clear the
  // selection when they run so stale tiles don't linger.
  useEffect(() => {
    setActions({
      onDelete: async (targets) => {
        if (await handleBulkDelete(targets)) clear();
      },
      onMove: async (targets) => {
        if (await handleBulkMove(targets)) clear();
      },
    });
    return () => setActions(null);
  }, [setActions, handleBulkDelete, handleBulkMove, clear]);

  // Publish the selectable pool so the toolbar's "Select all" knows the set.
  useEffect(() => {
    setPool(photos);
    return () => setPool([]);
  }, [photos, setPool]);

  // Selection belongs to the current folder; drop it when the folder changes
  // or when leaving the grid entirely.
  useEffect(() => {
    return () => clear();
  }, [folder, clear]);

  // Escape clears the selection; Cmd/Ctrl+A selects everything. Both yield to
  // the lightbox and to text fields.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (active) return;
      if (e.key === "Escape" && selected.length) {
        clear();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
        const target = e.target as HTMLElement;
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }
        if (!photos.length) return;
        e.preventDefault();
        selectAll(photos);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selected.length, active, clear, selectAll, photos]);

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
      <div className="fade-in grid select-none grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
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
            onClick={(e) => onClick(e, photo)}
            onDoubleClick={() => onDoubleClick(photo)}
            className={`group relative aspect-square overflow-hidden rounded-md border-2 bg-foreground/5 ${
              isSelected(photo.id) ? "border-accent" : "border-transparent"
            }`}
          >
            {photo.processingStatus === "completed" ? (
              <img
                src={imageUrl(photo.s3Key, "640", "webp")}
                alt={photo.filename}
                className="h-full w-full object-cover"
                loading="lazy"
                draggable={false}
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
            {isSelected(photo.id) && <SelectionCheck />}
          </button>
        ))}
      </div>

      {active &&
        (() => {
          const index = visiblePhotos.findIndex((p) => p.id === active.id);
          const count = visiblePhotos.length;
          // Wrap around so the arrows cycle through the folder endlessly.
          const canNavigate = index >= 0 && count > 1;
          const prev = visiblePhotos[(index - 1 + count) % count];
          const next = visiblePhotos[(index + 1) % count];
          return (
            <PhotoLightbox
              photo={active}
              onClose={() => setActive(null)}
              onDelete={handleDelete}
              onMove={handleMove}
              onRename={handleRename}
              onPrev={canNavigate ? () => setActive(prev) : undefined}
              onNext={canNavigate ? () => setActive(next) : undefined}
            />
          );
        })()}
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
