"use client";

import { useRef } from "react";
import { UploadDropzone } from "@/components/upload-dropzone";
import { FolderList, FolderListRef } from "@/components/folder-list";

export default function Home() {
  const folderListRef = useRef<FolderListRef>(null);

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto max-w-5xl px-6 py-8">
        <section>
          <h2 className="mb-4 text-lg font-medium text-black dark:text-zinc-100">
            Upload
          </h2>
          <UploadDropzone
            onUploadComplete={() => folderListRef.current?.refresh()}
          />
        </section>

        <section className="mt-12">
          <h2 className="mb-4 text-lg font-medium text-black dark:text-zinc-100">
            Folders
          </h2>
          <FolderList ref={folderListRef} />
        </section>
      </main>
    </div>
  );
}
