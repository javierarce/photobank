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

export type PhotoGridRef = {
  refresh: () => void;
};

export const PhotoGrid = forwardRef<PhotoGridRef, { folder: string }>(function PhotoGrid({ folder }, ref) {
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
    fetch(`/api/photos?folder=${encodeURIComponent(folder)}`)
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

  if (loading) {
    return <p className="text-sm text-zinc-500">Loading photos...</p>;
  }

  if (error) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  if (!photos.length) {
    return (
      <p className="text-sm text-zinc-500">No photos in this folder.</p>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {photos.map((photo) => (
          <button
            key={photo.id}
            onClick={() => setActive(photo)}
            className="group relative aspect-square overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-900"
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
                <span className="text-xs text-zinc-400">
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
