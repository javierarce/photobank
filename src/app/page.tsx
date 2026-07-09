"use client";

import { useRef } from "react";
import { FolderList, FolderListRef } from "@/components/folder-list";
import { useUpload } from "@/hooks/use-upload";

export default function Home() {
  const folderListRef = useRef<FolderListRef>(null);
  const { files, isDragging, dragHandlers, openFilePicker, clearCompleted } =
    useUpload({
      onUploadComplete: async () => {
        await folderListRef.current?.refresh();
        clearCompleted();
      },
    });

  const uploading = files.filter(
    (f) => f.status === "pending" || f.status === "uploading"
  ).length;
  const failed = files.filter((f) => f.status === "error").length;

  return (
    <div className="relative min-h-screen font-sans" {...dragHandlers}>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <section>
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold text-foreground">Upload</h2>
            <button
              type="button"
              onClick={openFilePicker}
              className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground/70 transition-colors hover:border-foreground/35 hover:text-foreground"
            >
              Select images
            </button>
          </div>
          <p className="mt-1 text-sm text-foreground/50">
            {uploading > 0 ? (
              <span className="tabular-nums text-accent">
                Uploading {uploading} image{uploading > 1 ? "s" : ""}…
              </span>
            ) : failed > 0 ? (
              <span className="text-red-600 dark:text-red-400">
                {failed} image{failed > 1 ? "s" : ""} failed to upload
              </span>
            ) : (
              <>
                Drop images anywhere, or click Select images. Uploading to{" "}
                <span className="font-mono">inbox/</span>
              </>
            )}
          </p>
        </section>

        <section className="mt-12">
          <h2 className="mb-4 text-lg font-semibold text-foreground">
            Folders
          </h2>
          <FolderList ref={folderListRef} />
        </section>
      </main>

      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-accent/5 p-6">
          <div className="rounded-xl border-2 border-dashed border-accent bg-background/80 px-10 py-8 text-center backdrop-blur-sm">
            <p className="text-base font-medium text-foreground/80">
              Drop images to upload
            </p>
            <p className="mt-1 text-sm text-foreground/50">
              Uploading to <span className="font-mono">inbox/</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
