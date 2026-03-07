"use client";

import { useCallback, useState } from "react";

type UploadFile = {
  file: File;
  id?: string;
  status: "pending" | "uploading" | "done" | "error";
  progress: number;
};

type Props = {
  folder?: string;
  onUploadComplete?: () => void;
};

export function UploadDropzone({ folder = "inbox", onUploadComplete }: Props) {
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const updateFile = (file: File, update: Partial<UploadFile>) => {
    setFiles((prev) =>
      prev.map((f) => (f.file === file ? { ...f, ...update } : f))
    );
  };

  const handleFiles = useCallback(
    async (fileList: FileList) => {
      const newFiles: UploadFile[] = Array.from(fileList)
        .filter((f) => f.type.startsWith("image/"))
        .map((file) => ({ file, status: "pending" as const, progress: 0 }));

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
                    reject(
                      new Error(`S3 ${xhr.status}: ${xhr.responseText}`)
                    );
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

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  return (
    <div className="flex flex-col gap-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onClick={() => {
          const input = document.createElement("input");
          input.type = "file";
          input.multiple = true;
          input.accept = "image/*";
          input.onchange = () => input.files && handleFiles(input.files);
          input.click();
        }}
        className={`flex min-h-48 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
          isDragging
            ? "border-blue-500 bg-blue-50 dark:bg-blue-950/20"
            : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-600"
        }`}
      >
        <div className="text-center">
          <p className="text-lg font-medium text-zinc-700 dark:text-zinc-300">
            Drop images here or click to select
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            Uploading to <span className="font-mono">{folder}/</span>
          </p>
        </div>
      </div>

      {files.length > 0 && (
        <ul className="flex flex-col gap-2">
          {files.map((f, i) => (
            <li
              key={i}
              className="flex items-center gap-3 rounded-md bg-zinc-100 px-4 py-3 dark:bg-zinc-900"
            >
              <span className="flex-1 truncate text-sm font-mono">
                {f.file.name}
              </span>
              <span className="text-xs text-zinc-500 tabular-nums">
                {f.status === "uploading" && `${f.progress}%`}
                {f.status === "done" && "Done"}
                {f.status === "error" && "Failed"}
                {f.status === "pending" && "Waiting..."}
              </span>
              {f.status === "uploading" && (
                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-300 dark:bg-zinc-700">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all"
                    style={{ width: `${f.progress}%` }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
