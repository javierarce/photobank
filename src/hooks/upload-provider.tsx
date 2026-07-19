import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { cancelImport, importPhotos } from "@/lib/api";
import { isSupportedImage, SUPPORTED_EXTENSIONS } from "@/lib/keys";
import {
  UploadContext,
  type CompleteListener,
  type UploadFile,
} from "@/hooks/use-upload";

type ImportProgressEvent = {
  key: string;
  photoId: string | null;
  filename: string;
  folder: string;
  progress: number;
  status:
    | "starting"
    | "processing"
    | "uploading"
    | "done"
    | "error"
    | "cancelled";
  error: string | null;
};

const isImportable = isSupportedImage;

function basename(path: string) {
  return path.split("/").pop() ?? path;
}

/**
 * Resolve the drop-target folder under a native cursor position by hit-testing
 * the DOM. Elements opt in by carrying a `data-drop-folder` attribute: the home
 * page tags each folder card, a folder page tags its whole surface. A drop that
 * lands on nothing (e.g. the gap between cards) returns null and imports
 * nowhere.
 *
 * Tauri types this position as `PhysicalPosition`, but on macOS the value is
 * actually in logical (CSS) pixels — wry reads it from the NSView coordinate
 * system in points and tauri-runtime-wry wraps it without applying the scale
 * factor. `document.elementFromPoint` wants CSS pixels, so we pass it straight
 * through; dividing by devicePixelRatio would wrongly pull every Retina drop
 * toward the top-left corner.
 */
function folderAtPoint(position: { x: number; y: number }): string | null {
  const el = document.elementFromPoint(position.x, position.y);
  const target = el?.closest<HTMLElement>("[data-drop-folder]");
  return target?.dataset.dropFolder ?? null;
}

/**
 * App-wide import state. Living above the router means an upload started on
 * one screen keeps streaming progress after you navigate — the folder card,
 * the folder grid's upload tiles, and the drag overlay all read this one
 * source. File drops arrive as Tauri native drag-drop events (real paths, not
 * File objects); processing/upload progress streams back as import://progress
 * events from Rust.
 */
export function UploadProvider({ children }: { children: ReactNode }) {
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [dropFolder, setDropFolder] = useState<string | null>(null);

  const listeners = useRef<Set<CompleteListener>>(new Set());
  const onUploadComplete = useCallback((fn: CompleteListener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const removeUpload = useCallback((key: string) => {
    setFiles((prev) => prev.filter((f) => f.key !== key));
  }, []);

  const cancelUpload = useCallback((key: string) => {
    // Optimistically show the tile as cancelling but keep it (and its id, so
    // the still-present catalog row stays de-duped behind it) until the
    // importer confirms with a `cancelled` event. Only pending/uploading tiles
    // are cancellable; a done tile is already uploaded.
    setFiles((prev) =>
      prev.map((f) =>
        f.key === key && (f.status === "pending" || f.status === "uploading")
          ? { ...f, status: "cancelling" }
          : f
      )
    );
    // If the request itself fails, leave the tile be — real progress events
    // will settle it on its actual terminal state.
    cancelImport(key).catch(() => {});
  }, []);

  const clearCompleted = useCallback(() => {
    setFiles((prev) => prev.filter((f) => f.status !== "done"));
  }, []);

  const handlePaths = useCallback(async (paths: string[], folder: string) => {
    const importable = paths.filter(isImportable);
    if (!importable.length) return;

    setFiles((prev) => {
      const next = [...prev];
      for (const path of importable) {
        const filename = basename(path);
        const key = `${folder}/${filename}`;
        const existing = next.findIndex((f) => f.key === key);
        const entry: UploadFile = {
          key,
          folder,
          filename,
          status: "pending",
          progress: 0,
        };
        if (existing >= 0) next[existing] = entry;
        else next.push(entry);
      }
      return next;
    });

    try {
      await importPhotos(importable, folder);
    } catch (err) {
      // Batch-level failure (e.g. invalid folder); per-file failures arrive
      // as error events instead. Scope to this folder so a concurrent import
      // elsewhere is left untouched.
      const message = String(err);
      setFiles((prev) =>
        prev.map((f) =>
          f.folder === folder &&
          (f.status === "pending" || f.status === "uploading")
            ? { ...f, status: "error", error: message }
            : f
        )
      );
      return;
    }
    for (const fn of listeners.current) fn(folder);
  }, []);

  const handlePathsRef = useRef(handlePaths);
  useEffect(() => {
    handlePathsRef.current = handlePaths;
  });

  // Progress events from the Rust importer.
  useEffect(() => {
    const unlisten = listen<ImportProgressEvent>("import://progress", (event) => {
      const p = event.payload;
      // A cancelled import has already cleaned up its catalog row server-side;
      // refresh the folder so nothing lingers, then drop its tile below.
      if (p.status === "cancelled") {
        for (const fn of listeners.current) fn(p.folder);
      }
      setFiles((prev) =>
        prev.flatMap((f) => {
          if (f.key !== p.key) return [f];
          // The import is gone — remove its tile.
          if (p.status === "cancelled") return [];
          // While cancelling, ignore in-flight progress; only a terminal
          // done/error resolves the tile (a cancel that lost the race).
          if (
            f.status === "cancelling" &&
            p.status !== "done" &&
            p.status !== "error"
          ) {
            return [f];
          }
          const status =
            p.status === "done" ? "done" : p.status === "error" ? "error" : "uploading";
          return [
            {
              ...f,
              id: p.photoId ?? f.id,
              progress: p.progress,
              status,
              error: p.error ?? undefined,
            },
          ];
        })
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Native file drops. Tauri intercepts OS drags, so HTML5 drop events never
  // fire; this also means we get real filesystem paths and a cursor position
  // we can hit-test to pick the destination folder.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        setIsDragging(true);
        setDropFolder(folderAtPoint(p.position));
      } else if (p.type === "leave") {
        setIsDragging(false);
        setDropFolder(null);
      } else if (p.type === "drop") {
        setIsDragging(false);
        setDropFolder(null);
        const folder = folderAtPoint(p.position);
        // No drop target under the cursor — the user must aim at a folder.
        if (folder) handlePathsRef.current(p.paths, folder);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const openFilePicker = useCallback(async (folder: string) => {
    const selection = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: [...SUPPORTED_EXTENSIONS] }],
    });
    if (!selection) return;
    const paths = Array.isArray(selection) ? selection : [selection];
    handlePathsRef.current(paths, folder);
  }, []);

  return (
    <UploadContext.Provider
      value={{
        files,
        isDragging,
        dropFolder,
        removeUpload,
        cancelUpload,
        clearCompleted,
        openFilePicker,
        onUploadComplete,
      }}
    >
      {children}
    </UploadContext.Provider>
  );
}
