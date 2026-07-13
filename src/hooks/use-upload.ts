import { createContext, useContext } from "react";

export type UploadFile = {
  /** Stable key: "folder/filename" — matches import://progress events. */
  key: string;
  /** Destination folder this import is bound for. */
  folder: string;
  filename: string;
  /** The catalog id, once the importer has created the row. */
  id?: string;
  status: "pending" | "uploading" | "done" | "error";
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
  removeUpload: (key: string) => void;
  clearCompleted: () => void;
  /** Open the OS file picker and import the selection into `folder`. */
  openFilePicker: (folder: string) => void;
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
