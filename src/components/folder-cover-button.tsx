import { useState } from "react";
import { useFolderCover } from "@/hooks/use-folder-cover";
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
  const { coverId, setCover, clearCover } = useFolderCover(photo.folder);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The lightbox keeps this button mounted while it pages through photos, so a
  // stale error must not carry over when another one arrives. Adjusting during
  // render (not in an effect) avoids an extra render pass.
  const [prevId, setPrevId] = useState(photo.id);
  if (prevId !== photo.id) {
    setPrevId(photo.id);
    setError(null);
  }

  const isCover = coverId === photo.id;

  const toggle = async () => {
    if (saving || coverId === undefined) return;
    setSaving(true);
    setError(null);
    try {
      if (isCover) await clearCover();
      else await setCover(photo.id);
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
