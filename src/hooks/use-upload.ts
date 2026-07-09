import { useCallback, useRef, useState } from "react";

export type UploadFile = {
  /** Stable client-side key; the DB id only exists once the API responds. */
  key: string;
  file: File;
  /** Local object URL used to preview the image while it uploads. */
  previewUrl: string;
  id?: string;
  status: "pending" | "uploading" | "done" | "error";
  progress: number;
};

type Options = {
  folder?: string;
  onUploadComplete?: () => void;
};

/**
 * Upload state + drag-and-drop plumbing shared by the folder page. Returns the
 * in-flight file list, a drag-active flag, handlers to spread over any element
 * that should accept drops, and a trigger that opens the native file picker.
 */
export function useUpload({ folder = "inbox", onUploadComplete }: Options = {}) {
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  // Drag events fire per child element, so a plain boolean flickers as the
  // cursor moves over nested nodes. Counting enter/leave keeps it stable.
  const dragDepth = useRef(0);
  const keyCounter = useRef(0);

  const updateFile = (file: File, update: Partial<UploadFile>) => {
    setFiles((prev) =>
      prev.map((f) => (f.file === file ? { ...f, ...update } : f))
    );
  };

  // Drop an upload and release its object URL. Used to prune finished uploads
  // once the real photo has loaded, and to dismiss failed ones.
  const removeUpload = useCallback((key: string) => {
    setFiles((prev) => {
      const gone = prev.find((f) => f.key === key);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((f) => f.key !== key);
    });
  }, []);

  const clearCompleted = useCallback(() => {
    setFiles((prev) => {
      prev.forEach((f) => {
        if (f.status === "done") URL.revokeObjectURL(f.previewUrl);
      });
      return prev.filter((f) => f.status !== "done");
    });
  }, []);

  const handleFiles = useCallback(
    async (fileList: FileList) => {
      const newFiles: UploadFile[] = Array.from(fileList)
        .filter((f) => f.type.startsWith("image/"))
        .map((file) => ({
          key: String(keyCounter.current++),
          file,
          previewUrl: URL.createObjectURL(file),
          status: "pending" as const,
          progress: 0,
        }));

      if (!newFiles.length) return;

      setFiles((prev) => [...prev, ...newFiles]);

      const response = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folder,
          files: newFiles.map((f) => ({
            filename: f.file.name,
            contentType: f.file.type,
            size: f.file.size,
          })),
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.error("[upload] API error:", response.status, err);
        newFiles.forEach((f) => updateFile(f.file, { status: "error" }));
        return;
      }

      const { uploads } = await response.json();

      await Promise.all(
        uploads.map(
          async (
            upload: { id: string; filename: string; presignedUrl: string },
            i: number
          ) => {
            const file = newFiles[i].file;

            updateFile(file, { id: upload.id, status: "uploading" });

            try {
              const xhr = new XMLHttpRequest();

              xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                  const progress = Math.round((e.loaded / e.total) * 100);
                  updateFile(file, { progress });
                }
              };

              await new Promise<void>((resolve, reject) => {
                xhr.onload = () => {
                  if (xhr.status >= 200 && xhr.status < 300) {
                    resolve();
                  } else {
                    console.error(
                      `[upload] S3 responded ${xhr.status}:`,
                      xhr.responseText
                    );
                    reject(new Error(`S3 ${xhr.status}: ${xhr.responseText}`));
                  }
                };
                xhr.onerror = () => reject(new Error("Network error"));
                xhr.open("PUT", upload.presignedUrl);
                xhr.setRequestHeader("Content-Type", file.type);
                xhr.send(file);
              });

              await fetch("/api/upload/confirm", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ photoIds: [upload.id] }),
              });

              updateFile(file, { status: "done", progress: 100 });
            } catch (err) {
              console.error("[upload] S3 upload failed:", file.name, err);
              updateFile(file, { status: "error" });
            }
          }
        )
      );

      onUploadComplete?.();
    },
    [folder, onUploadComplete]
  );

  const openFilePicker = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/*";
    input.onchange = () => input.files && handleFiles(input.files);
    input.click();
  }, [handleFiles]);

  const dragHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current += 1;
      setIsDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) {
        dragDepth.current = 0;
        setIsDragging(false);
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      handleFiles(e.dataTransfer.files);
    },
  };

  return {
    files,
    isDragging,
    dragHandlers,
    openFilePicker,
    removeUpload,
    clearCompleted,
  };
}
