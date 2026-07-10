import { useState } from "react";
import { deletePhoto, updatePhoto } from "@/lib/api";
import type { Photo } from "@/lib/types";

/**
 * Shared photo collection state + delete/move/rename actions, used by the
 * folder grid and the search results.
 */
export function usePhotoActions() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  // The photo currently open in the lightbox
  const [active, setActive] = useState<Photo | null>(null);

  const handleDelete = async (photo: Photo) => {
    if (!confirm(`Delete ${photo.filename}?`)) return;

    try {
      await deletePhoto(photo.id);
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      setActive((prev) => (prev?.id === photo.id ? null : prev));
    } catch {
      alert("Failed to delete photo");
    }
  };

  const handleMove = async (photo: Photo) => {
    const newFolder = prompt("Move to folder:", photo.folder)?.trim();
    if (!newFolder || newFolder === photo.folder) return;

    try {
      await updatePhoto(photo.id, { folder: newFolder });
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      setActive((prev) => (prev?.id === photo.id ? null : prev));
    } catch (err) {
      alert(typeof err === "string" ? err : "Failed to move photo");
    }
  };

  const handleRename = async (photo: Photo, newFilename: string) => {
    try {
      const updated = await updatePhoto(photo.id, { filename: newFilename });
      setPhotos((prev) => prev.map((p) => (p.id === photo.id ? updated : p)));
      setActive((prev) => (prev?.id === photo.id ? updated : prev));
    } catch {
      setPhotos((prev) => prev.map((p) => (p.id === photo.id ? photo : p)));
      setActive((prev) => (prev?.id === photo.id ? photo : prev));
      throw new Error("Failed to rename");
    }
  };

  return {
    photos,
    setPhotos,
    active,
    setActive,
    handleDelete,
    handleMove,
    handleRename,
  };
}
