import { useCallback, useEffect, useState } from "react";
import { clearFolderCover, getFolderCover, setFolderCover } from "@/lib/api";

/** Everyone currently showing a folder's cover state. Two of them can be up at
 * once — the lightbox sidebar's toggle and the right-click menu's item — so a
 * change made in one has to reach the other instead of leaving it offering to
 * set a cover that's already set. */
const listeners = new Set<(folder: string, coverId: string | null) => void>();

function publish(folder: string, coverId: string | null) {
  for (const listener of listeners) listener(folder, coverId);
}

/**
 * The photo a folder shows on the home page, plus the two ways to change it.
 * `coverId` is undefined until the current pick has been read, which is what
 * callers disable their control on — otherwise a photo that IS the cover would
 * briefly offer to set it again.
 */
export function useFolderCover(folder: string) {
  const [coverId, setCoverId] = useState<string | null | undefined>(undefined);

  // Another folder answers to another pick. Forget the old one during render
  // rather than in the effect below, so nothing shows a stale cover for a frame.
  const [prevFolder, setPrevFolder] = useState(folder);
  if (prevFolder !== folder) {
    setPrevFolder(folder);
    setCoverId(undefined);
  }

  useEffect(() => {
    // Dropped once this read can no longer be the truth: the hook unmounted or
    // moved folders, or someone else changed the cover while it was in flight —
    // otherwise the reply would land afterwards and restore the old pick.
    let stale = false;
    getFolderCover(folder)
      .then((id) => {
        if (!stale) setCoverId(id);
      })
      // A failed read only costs the "already the cover" state; treating it as
      // "no pick" keeps the control usable, and setting one is idempotent.
      .catch(() => {
        if (!stale) setCoverId(null);
      });

    const onChange = (changed: string, id: string | null) => {
      if (changed !== folder) return;
      stale = true;
      setCoverId(id);
    };
    listeners.add(onChange);
    return () => {
      stale = true;
      listeners.delete(onChange);
    };
  }, [folder]);

  // Both reject with the backend's message string; callers report it.
  const setCover = useCallback(
    async (photoId: string) => {
      await setFolderCover(folder, photoId);
      publish(folder, photoId);
    },
    [folder]
  );

  const clearCover = useCallback(async () => {
    await clearFolderCover(folder);
    publish(folder, null);
  }, [folder]);

  return { coverId, setCover, clearCover };
}
