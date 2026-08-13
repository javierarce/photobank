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
