import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { message } from "@tauri-apps/plugin-dialog";
import { copyPhotoToClipboard, exportPhotos } from "@/lib/api";
import { splitDisplayName } from "@/lib/keys";
import { DEFAULT_EXPORT_RESOLUTION } from "@/components/export-button";
import type { Photo } from "@/lib/types";

/** Breathing room kept between the menu and the window edges. */
const MARGIN = 8;

type Props = {
  /** What the menu acts on: the right-clicked photo, or the whole selection
   * when the click landed inside it (see useThumbnailContextMenu). */
  photos: Photo[];
  /** Viewport coordinates of the click that opened it. */
  x: number;
  y: number;
  /** Offers "Add to collection…", handing these photos to the caller's
   * dialog. Left out where there's no one folder to file into — the search
   * results span folders, and a collection groups one folder's photos. */
  onCollect?: (photos: Photo[]) => void;
  onClose: () => void;
};

/**
 * The right-click menu on a thumbnail. Copying the name and copying the image
 * are the two things the rest of the app can't do — everything else here
 * mirrors an action the lightbox or the selection toolbar already offers, so
 * the menu stays short.
 */
export function PhotoContextMenu({ photos, x, y, onCollect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Keep the menu on screen: measure it once it's up and pull it back inside
  // the viewport if the click was near the right or bottom edge. Done in a
  // layout effect so the correction lands before the browser paints.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN)),
      y: Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN)),
    });
  }, [x, y]);

  // Dismiss on anything that means "I'm done here": a click outside, Escape,
  // or the page moving out from under the menu.
  useEffect(() => {
    const onPointerDown = (e: globalThis.MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Capture phase + stopPropagation so Escape dismisses only the menu: it
      // runs before the bubble-phase document listeners that clear the
      // selection (photo-grid / search-results).
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const count = photos.length;

  // The name as the user sees it, minus the extension — what you'd paste into a
  // post or a caption. One per line for a multi-photo selection.
  const handleCopyFilename = async () => {
    onClose();
    const names = photos.map((p) => splitDisplayName(p.filename)[0]);
    try {
      await writeText(names.join("\n"));
    } catch {
      await message(
        count === 1 ? "Failed to copy the filename" : "Failed to copy the filenames",
        { title: "Copy failed", kind: "error" }
      );
    }
  };

  // The pixels themselves, for pasting into another app. Single photo only —
  // the system clipboard holds one image, so a selection has nothing sensible
  // to put there.
  const handleCopyImage = async () => {
    onClose();
    try {
      await copyPhotoToClipboard(photos[0].id);
    } catch (err) {
      // Tauri commands reject with a plain message string (see src/lib/api.ts)
      await message(typeof err === "string" ? err : "Failed to copy the image", {
        title: "Copy failed",
        kind: "error",
      });
    }
  };

  // Same version a plain click of the Download split button exports; the
  // lightbox and the selection toolbar are where you go to pick another.
  const handleDownload = async () => {
    onClose();
    try {
      await exportPhotos(
        photos.map((p) => p.id),
        DEFAULT_EXPORT_RESOLUTION
      );
    } catch (err) {
      // Tauri commands reject with a plain message string (see src/lib/api.ts)
      await message(
        typeof err === "string"
          ? err
          : count === 1
            ? "Failed to export photo"
            : "Failed to export photos",
        { title: "Download failed", kind: "error" }
      );
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="photo-context-menu"
      // Not a selection-clearing surface: keep clicks inside off the page's
      // background-deselect handler.
      data-selection-toolbar
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className="menu-in fixed z-50 min-w-48 overflow-hidden rounded-md border border-border bg-background py-1 shadow-lg"
      style={{ left: pos.x, top: pos.y }}
    >
      <MenuItem onClick={handleCopyFilename}>
        {count === 1 ? "Copy filename" : `Copy ${count} filenames`}
      </MenuItem>
      {count === 1 && <MenuItem onClick={handleCopyImage}>Copy image</MenuItem>}
      <MenuItem onClick={handleDownload}>
        {count === 1 ? "Download" : `Download ${count} photos`}
      </MenuItem>
      {onCollect && (
        // The dialog owns what happens next (pick a collection, name a new
        // one, or take these out of the one they're in), so this only hands
        // the photos over — hence the ellipsis.
        <MenuItem
          onClick={() => {
            onClose();
            onCollect(photos);
          }}
        >
          {count === 1
            ? "Add to collection…"
            : `Add ${count} photos to a collection…`}
        </MenuItem>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-foreground/5"
    >
      {children}
    </button>
  );
}
