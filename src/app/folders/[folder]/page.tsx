"use client";

import { use, useRef } from "react";
import Link from "next/link";
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
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto max-w-5xl px-6 py-16">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Photobank
          </Link>
          <span className="text-sm text-zinc-400">/</span>
          <h1 className="font-mono text-lg font-semibold text-black dark:text-zinc-50">
            {decodedFolder}
          </h1>
        </div>

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
