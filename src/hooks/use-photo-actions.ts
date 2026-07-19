import { useCallback, useState } from "react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { deletePhoto, loadPhotoMetadata, updatePhoto } from "@/lib/api";
import type { Photo } from "@/lib/types";

/** Native OS confirm dialog — the webview's window.confirm doesn't render. */
function confirmDelete(label: string): Promise<boolean> {
  return ask(`Delete ${label}? This can't be undone.`, {
    title: "Delete",
    kind: "warning",
    okLabel: "Delete",
    cancelLabel: "Cancel",
  });
}

/**
 * Shared photo collection state + delete/move/rename actions, used by the
 * folder grid and the search results.
 */
export function usePhotoActions() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  // The photo currently open in the lightbox
  const [active, setActive] = useState<Photo | null>(null);

  const handleDelete = async (photo: Photo) => {
    if (!(await confirmDelete(photo.filename))) return;

    // Remove the thumbnail immediately for a snappy delete; the bucket cleanup
    // happens in the background. If it fails, splice the photo back at its
    // original position (the grid is ordered newest-first) so it reappears in
    // place rather than jumping to the end.
    const index = photos.findIndex((p) => p.id === photo.id);
    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
    setActive((prev) => (prev?.id === photo.id ? null : prev));

    try {
      await deletePhoto(photo.id);
    } catch (err) {
      setPhotos((prev) => {
        if (prev.some((p) => p.id === photo.id)) return prev;
        const next = [...prev];
        next.splice(Math.min(Math.max(index, 0), next.length), 0, photo);
        return next;
      });
      // Tauri commands reject with a plain message string (see src/lib/api.ts)
      await message(typeof err === "string" ? err : "Failed to delete photo", {
        title: "Delete failed",
        kind: "error",
      });
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
    if (!(await confirmDelete(label))) return false;

    const ids = new Set(targets.map((p) => p.id));

    // Drop all the selected thumbnails up front. Capture the pre-delete array
    // (via the updater, to avoid a stale closure) so failures can be restored
    // in their original order without disturbing photos added meanwhile.
    let snapshot: Photo[] = [];
    setPhotos((prev) => {
      snapshot = prev;
      return prev.filter((p) => !ids.has(p.id));
    });
    setActive((prev) => (prev && ids.has(prev.id) ? null : prev));

    // Run the bucket deletes in the background and return right away, so the
    // caller can clear the selection the instant the thumbnails vanish rather
    // than waiting a network round-trip for the toolbar to catch up. Only
    // failures roll back.
    void (async () => {
      const results = await Promise.allSettled(
        targets.map((p) => deletePhoto(p.id))
      );
      const failed = new Set(
        targets
          .filter((_, i) => results[i].status === "rejected")
          .map((p) => p.id)
      );
      if (!failed.size) return;

      // Restore only the photos whose delete failed, keeping snapshot order and
      // prepending anything added since (the grid is newest-first).
      setPhotos((prev) => {
        const keep = new Set(prev.map((p) => p.id));
        failed.forEach((id) => keep.add(id));
        const known = new Set(snapshot.map((p) => p.id));
        const added = prev.filter((p) => !known.has(p.id));
        return [...added, ...snapshot.filter((p) => keep.has(p.id))];
      });
      // Tauri commands reject with a plain message string — surface the first
      // one (e.g. the catalog↔bucket guard's rebuild instruction) over the
      // generic count
      const rejection = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected"
      );
      const detail =
        typeof rejection?.reason === "string" ? rejection.reason : null;
      await message(
        detail ??
          (failed.size === targets.length
            ? "Failed to delete photos"
            : `Failed to delete ${failed.size} of ${targets.length} photos`),
        { title: "Delete failed", kind: "error" }
      );
    })();

    return true;
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

  // Fetch one photo's EXIF/dimensions from its original in the bucket (the
  // lightbox's "Load info" button). Rejections propagate so the button can
  // show the error inline.
  const handleLoadInfo = useCallback(async (photo: Photo) => {
    const updated = await loadPhotoMetadata(photo.id);
    setPhotos((prev) => prev.map((p) => (p.id === photo.id ? updated : p)));
    setActive((prev) => (prev?.id === photo.id ? updated : prev));
  }, []);

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
    handleLoadInfo,
  };
}
