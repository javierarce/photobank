import { useCallback, useState } from "react";
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

  // Bulk variants for the header's multi-select toolbar. They resolve to
  // `true` only when the operation actually ran, so the caller knows whether
  // to clear the selection (a cancelled prompt/confirm leaves it intact).
  const handleBulkDelete = useCallback(async (targets: Photo[]) => {
    if (!targets.length) return false;
    const label =
      targets.length === 1
        ? targets[0].filename
        : `${targets.length} photos`;
    if (!confirm(`Delete ${label}?`)) return false;

    const ids = new Set(targets.map((p) => p.id));
    try {
      await Promise.all(targets.map((p) => deletePhoto(p.id)));
      setPhotos((prev) => prev.filter((p) => !ids.has(p.id)));
      setActive((prev) => (prev && ids.has(prev.id) ? null : prev));
      return true;
    } catch {
      alert("Failed to delete photos");
      return false;
    }
  }, []);

  const handleBulkMove = useCallback(async (targets: Photo[]) => {
    if (!targets.length) return false;
    const newFolder = prompt(
      targets.length === 1
        ? "Move to folder:"
        : `Move ${targets.length} photos to folder:`,
      targets[0].folder
    )?.trim();
    if (!newFolder) return false;

    // Only touch photos that actually change folder — a same-folder pick (the
    // prompt is pre-filled with the current folder) is a no-op, so those rows
    // must stay put instead of being filtered out of the grid.
    const moving = targets.filter((p) => p.folder !== newFolder);
    if (!moving.length) return false;

    const movedIds = new Set(moving.map((p) => p.id));
    try {
      await Promise.all(
        moving.map((p) => updatePhoto(p.id, { folder: newFolder }))
      );
      setPhotos((prev) => prev.filter((p) => !movedIds.has(p.id)));
      setActive((prev) => (prev && movedIds.has(prev.id) ? null : prev));
      return true;
    } catch (err) {
      alert(typeof err === "string" ? err : "Failed to move photos");
      return false;
    }
  }, []);

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
    handleBulkDelete,
    handleBulkMove,
    handleRename,
  };
}
