import { useEffect, useState } from "react";
import { clearFolderCover, getFolderCover, setFolderCover } from "@/lib/api";
import type { Photo } from "@/lib/types";

/** Picks (or unpicks) the photo the home page shows for its folder.
 * Self-contained like ExportButton: it reads the folder's current pick itself,
 * so both grids get the toggle from the lightbox without threading a handler
 * through. A photo belongs to exactly one folder, so this is unambiguous even
 * when the lightbox was opened from a cross-folder search. */
export function FolderCoverButton({
  photo,
  disabled,
}: {
  photo: Photo;
  disabled?: boolean;
}) {
  // undefined while the current pick is still being read — the button waits
  // rather than flashing "Set as cover" on a photo that already is one.
  const [coverId, setCoverId] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The lightbox keeps this button mounted while it pages through photos, so
  // re-baseline when another one arrives: a stale error must not carry over,
  // and a photo from another folder answers to another pick. Adjusting during
  // render (not in the effect below) avoids an extra render pass.
  const [prev, setPrev] = useState({ id: photo.id, folder: photo.folder });
  if (prev.id !== photo.id) {
    setPrev({ id: photo.id, folder: photo.folder });
    setError(null);
    if (prev.folder !== photo.folder) setCoverId(undefined);
  }

  useEffect(() => {
    let cancelled = false;
    getFolderCover(photo.folder)
      .then((id) => {
        if (!cancelled) setCoverId(id);
      })
      // A failed read only costs the "already the cover" state; treating it as
      // "no pick" keeps the button usable, and setting one is idempotent.
      .catch(() => {
        if (!cancelled) setCoverId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [photo.folder]);

  const isCover = coverId === photo.id;

  const toggle = async () => {
    if (saving || coverId === undefined) return;
    setSaving(true);
    setError(null);
    try {
      if (isCover) {
        await clearFolderCover(photo.folder);
        setCoverId(null);
      } else {
        await setFolderCover(photo.folder, photo.id);
        setCoverId(photo.id);
      }
    } catch (err) {
      // Tauri commands reject with a plain message string (see src/lib/api.ts).
      setError(typeof err === "string" ? err : "Failed to update folder cover");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled || saving || coverId === undefined}
        data-testid="folder-cover"
        title={`Show this photo on the ${photo.folder} card on the home page`}
        className="w-full rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-foreground/5 active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none"
      >
        {isCover ? "Remove folder cover" : "Set as folder cover"}
      </button>
      {error && (
        <p
          className="mt-1 text-xs text-red-600 dark:text-red-400"
          data-testid="folder-cover-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}
