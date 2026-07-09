"use client";

import { use, useRef } from "react";
import { PhotoGrid, PhotoGridRef } from "@/components/photo-grid";
import { useUpload } from "@/hooks/use-upload";

type Props = {
  params: Promise<{ folder: string }>;
};

export default function FolderPage({ params }: Props) {
  const { folder } = use(params);
  const decodedFolder = decodeURIComponent(folder);
  const photoGridRef = useRef<PhotoGridRef>(null);
  const {
    files,
    isDragging,
    dragHandlers,
    openFilePicker,
    removeUpload,
  } = useUpload({
    folder: decodedFolder,
    // Refresh so the grid picks up the new photo rows; the grid dismisses each
    // upload tile itself once the processed thumbnail is ready to display.
    onUploadComplete: () => photoGridRef.current?.refresh(),
  });

  return (
    <div className="relative min-h-screen font-sans" {...dragHandlers}>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold text-foreground">
            {decodedFolder}
          </h1>
          <button
            type="button"
            onClick={openFilePicker}
            className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground/70 transition-colors hover:border-foreground/35 hover:text-foreground"
          >
            Upload
          </button>
        </div>

        <section className="mt-8">
          <PhotoGrid
            folder={decodedFolder}
            ref={photoGridRef}
            uploads={files}
            onDismissUpload={removeUpload}
          />
        </section>
      </main>

      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-accent/5 p-6">
          <div className="rounded-xl border-2 border-dashed border-accent bg-background/80 px-10 py-8 text-center backdrop-blur-sm">
            <p className="text-base font-medium text-foreground/80">
              Drop images to upload
            </p>
            <p className="mt-1 text-sm text-foreground/50">
              Uploading to <span className="font-mono">{decodedFolder}/</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
