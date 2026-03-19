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
import type { Photo } from "@/lib/types";

export type PhotoGridRef = {
  refresh: () => void;
};

export const PhotoGrid = forwardRef<PhotoGridRef, { folder: string }>(function PhotoGrid({ folder }, ref) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Photo | null>(null);

  const loadPhotos = useCallback(() => {
    fetch(`/api/photos?folder=${encodeURIComponent(folder)}`)
      .then((r) => r.json())
      .then((data) => setPhotos(data.photos))
      .finally(() => setLoading(false));
  }, [folder]);

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

  const handleDelete = async (photo: Photo) => {
    if (!confirm(`Delete ${photo.filename}?`)) return;

    const res = await fetch(`/api/photos/${photo.id}`, { method: "DELETE" });
    if (res.ok) {
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      if (selected?.id === photo.id) setSelected(null);
    }
  };

  const handleMove = async (photo: Photo) => {
    const newFolder = prompt("Move to folder:", photo.folder);
    if (!newFolder || newFolder === photo.folder) return;

    const res = await fetch(`/api/photos/${photo.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: newFolder }),
    });
    if (res.ok) {
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      if (selected?.id === photo.id) setSelected(null);
    }
  };

  const handleRename = async (photo: Photo, newFilename: string) => {
    const res = await fetch(`/api/photos/${photo.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: newFilename }),
    });
    if (res.ok) {
      const { photo: updated } = await res.json();
      setPhotos((prev) => prev.map((p) => (p.id === photo.id ? updated : p)));
      if (selected?.id === photo.id) setSelected(updated);
    } else {
      setPhotos((prev) => prev.map((p) => (p.id === photo.id ? photo : p)));
      if (selected?.id === photo.id) setSelected(photo);
      throw new Error("Failed to rename");
    }
  };

  if (loading) {
    return <p className="text-sm text-zinc-500">Loading photos...</p>;
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
            onClick={() => setSelected(photo)}
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

      {selected && (
        <PhotoLightbox
          photo={selected}
          onClose={() => setSelected(null)}
          onDelete={handleDelete}
          onMove={handleMove}
          onRename={handleRename}
        />
      )}
    </>
  );
});
