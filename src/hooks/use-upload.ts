import { createContext, useContext } from "react";
import type { UploadSummary } from "@/lib/upload-progress";

export type UploadFile = {
  /** Stable key: "folder/filename" — matches import://progress events. */
  key: string;
  /** Destination folder this import is bound for. */
  folder: string;
  filename: string;
  /** Absolute source path on disk, for previewing the pixels pre-import. */
  path?: string;
  /** The catalog id, once the importer has created the row. */
  id?: string;
  status: "pending" | "uploading" | "cancelling" | "done" | "error";
  progress: number;
  error?: string;
};

/** Called with the target folder once an import batch settles. */
export type CompleteListener = (folder: string) => void;

/** A cursor position in CSS pixels, as the native drag events report it. */
export type DragPosition = { x: number; y: number };

/**
 * Follows a drag that started *inside* the app (photo tiles being filed into a
 * collection). Those can't be tracked with the DOM's own dragover/drop: wry
 * hands every drag over the webview to Tauri and, having claimed it, never
 * lets WebKit run its drop handling (see wry's wkwebview/drag_drop.rs). So the
 * native events are the only ones that arrive, and the position has to be
 * hit-tested against the DOM to find what's under the cursor.
 */
export type DragTracker = {
  /** The cursor moved over the window; null when it left it. */
  onMove: (position: DragPosition | null) => void;
  /** Dropped at this position. */
  onDrop: (position: DragPosition) => void;
};

export type UploadContextValue = {
  files: UploadFile[];
  /** True while a native file drag is anywhere over the window. */
  isDragging: boolean;
  /** The folder whose drop target sits under the cursor, or null. */
  dropFolder: string | null;
  /** True while a native file drag is over the registered drop sink — the New
   * folder dialog, which stages files instead of importing them. */
  overDropSink: boolean;
  /**
   * Whole-batch progress for one folder, or for every folder at once when
   * called with no argument. Counts files whose tiles have already been
   * dismissed, so the percentage only ever moves forwards.
   */
  summarize: (folder?: string) => UploadSummary;
  removeUpload: (key: string) => void;
  /** Signal the importer to cancel an in-flight or queued upload by its key. */
  cancelUpload: (key: string) => void;
  clearCompleted: () => void;
  /** Open the OS file picker and import the selection into `folder`. */
  openFilePicker: (folder: string) => void;
  /** Open the OS file picker and return the chosen paths without importing
   * them — for a destination that doesn't exist yet. */
  pickImages: () => Promise<string[]>;
  /** Import already-known paths (e.g. files staged in a dialog) into `folder`. */
  importPaths: (paths: string[], folder: string) => void;
  /**
   * Divert drops that land on a `[data-drop-sink]` element to `fn`, which
   * receives the importable paths instead of the importer. Only one sink is
   * active at a time (a modal); returns an unsubscribe.
   */
  registerDropSink: (fn: (paths: string[]) => void) => () => void;
  /**
   * Follow an in-app drag (see [`DragTracker`]) instead of raising the import
   * overlay for it. Only one tracker is active at a time — the visible grid —
   * and it only hears about drags that began inside the page; returns an
   * unsubscribe.
   */
  registerDragTracker: (tracker: DragTracker) => () => void;
  /** Subscribe to import-batch completion; returns an unsubscribe fn. */
  onUploadComplete: (fn: CompleteListener) => () => void;
};

export const UploadContext = createContext<UploadContextValue | null>(null);

export function useUpload() {
  const ctx = useContext(UploadContext);
  if (!ctx) {
    throw new Error("useUpload must be used within an UploadProvider");
  }
  return ctx;
}
