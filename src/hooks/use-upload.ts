import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { importPhotos } from "@/lib/api";

export type UploadFile = {
  /** Stable key: "folder/filename" — matches import://progress events. */
  key: string;
  filename: string;
  /** The catalog id, once the importer has created the row. */
  id?: string;
  status: "pending" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
};

type Options = {
  folder?: string;
  onUploadComplete?: () => void;
};

type ImportProgressEvent = {
  key: string;
  photoId: string | null;
  filename: string;
  folder: string;
  progress: number;
  status: "starting" | "processing" | "uploading" | "done" | "error";
  error: string | null;
};

const IMPORT_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "tif", "tiff", "bmp"];

function isImportable(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  return !!ext && IMPORT_EXTENSIONS.includes(ext);
}

function basename(path: string) {
  return path.split("/").pop() ?? path;
}

/**
 * Import state + drag-and-drop plumbing. File drops come from Tauri's
 * native drag-drop events (real paths, not File objects); processing and
 * upload progress stream back as import://progress events from Rust.
 */
export function useUpload({ folder = "inbox", onUploadComplete }: Options = {}) {
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  // The listeners live across renders; keep the latest callbacks reachable.
  const folderRef = useRef(folder);
  const onCompleteRef = useRef(onUploadComplete);
  useEffect(() => {
    folderRef.current = folder;
    onCompleteRef.current = onUploadComplete;
  });

  const removeUpload = useCallback((key: string) => {
    setFiles((prev) => prev.filter((f) => f.key !== key));
  }, []);

  const clearCompleted = useCallback(() => {
    setFiles((prev) => prev.filter((f) => f.status !== "done"));
  }, []);

  const handlePaths = useCallback(async (paths: string[]) => {
    const importable = paths.filter(isImportable);
    if (!importable.length) return;
    const targetFolder = folderRef.current;

    setFiles((prev) => {
      const next = [...prev];
      for (const path of importable) {
        const filename = basename(path);
        const key = `${targetFolder}/${filename}`;
        const existing = next.findIndex((f) => f.key === key);
        const entry: UploadFile = { key, filename, status: "pending", progress: 0 };
        if (existing >= 0) next[existing] = entry;
        else next.push(entry);
      }
      return next;
    });

    try {
      await importPhotos(importable, targetFolder);
    } catch (err) {
      // Batch-level failure (e.g. invalid folder); per-file failures arrive
      // as error events instead.
      const message = String(err);
      setFiles((prev) =>
        prev.map((f) =>
          f.status === "pending" || f.status === "uploading"
            ? { ...f, status: "error", error: message }
            : f
        )
      );
      return;
    }
    onCompleteRef.current?.();
  }, []);

  const handlePathsRef = useRef(handlePaths);
  useEffect(() => {
    handlePathsRef.current = handlePaths;
  });

  // Progress events from the Rust importer.
  useEffect(() => {
    const unlisten = listen<ImportProgressEvent>("import://progress", (event) => {
      const p = event.payload;
      setFiles((prev) =>
        prev.map((f) => {
          if (f.key !== p.key) return f;
          const status =
            p.status === "done" ? "done" : p.status === "error" ? "error" : "uploading";
          return {
            ...f,
            id: p.photoId ?? f.id,
            progress: p.progress,
            status,
            error: p.error ?? undefined,
          };
        })
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Native file drops. Tauri intercepts OS drags, so HTML5 drop events never
  // fire; this also means we get real filesystem paths.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setIsDragging(true);
      } else if (event.payload.type === "leave") {
        setIsDragging(false);
      } else if (event.payload.type === "drop") {
        setIsDragging(false);
        handlePathsRef.current(event.payload.paths);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const openFilePicker = useCallback(async () => {
    const selection = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: [...IMPORT_EXTENSIONS] }],
    });
    if (!selection) return;
    const paths = Array.isArray(selection) ? selection : [selection];
    handlePathsRef.current(paths);
  }, []);

  /** Kept for API compatibility with the old HTML5 implementation; native
   * drag events replace these entirely. */
  const dragHandlers = {};

  return {
    files,
    isDragging,
    dragHandlers,
    openFilePicker,
    removeUpload,
    clearCompleted,
  };
}
