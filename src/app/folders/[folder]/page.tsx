"use client";

import { use, useRef } from "react";
import { PhotoGrid, PhotoGridRef } from "@/components/photo-grid";
import { UploadDropzone } from "@/components/upload-dropzone";

type Props = {
  params: Promise<{ folder: string }>;
};

export default function FolderPage({ params }: Props) {
  const { folder } = use(params);
  const decodedFolder = decodeURIComponent(folder);
  const photoGridRef = useRef<PhotoGridRef>(null);

  return (
    <div className="min-h-screen font-sans">
      <main className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="text-xl font-semibold text-foreground">
          {decodedFolder}
        </h1>

        <section className="mt-8">
          <UploadDropzone
            folder={decodedFolder}
            onUploadComplete={() => photoGridRef.current?.refresh()}
          />
        </section>

        <section className="mt-8">
          <PhotoGrid folder={decodedFolder} ref={photoGridRef} />
        </section>
      </main>
    </div>
  );
}
