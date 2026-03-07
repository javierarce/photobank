"use client";

import { useEffect, useState } from "react";
import { imageUrl } from "@/lib/image-url";
import { PhotoTags } from "@/components/photo-tags";
import type { Photo } from "@/lib/types";

type Props = {
  photo: Photo;
  onClose: () => void;
  onDelete?: (photo: Photo) => void;
  onMove?: (photo: Photo) => void;
  onRename?: (photo: Photo) => void;
};

export function PhotoLightbox({
  photo,
  onClose,
  onDelete,
  onMove,
  onRename,
}: Props) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
  }, [photo.id]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[90vh] w-[min(95vw,1200px)] overflow-hidden rounded-lg bg-white dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex w-0 flex-1 items-center justify-center bg-black">
          {!loaded && (
            <div className="absolute inset-0 flex items-center justify-center">
              <svg
                className="h-8 w-8 animate-spin text-white/40"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            </div>
          )}
          <img
            src={imageUrl(photo.s3Key, "2880", "webp")}
            alt={photo.filename}
            onLoad={() => setLoaded(true)}
            className={`max-h-[90vh] w-auto object-contain transition-opacity duration-300 ${
              loaded ? "opacity-100" : "opacity-0"
            }`}
          />
        </div>
        <div className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto p-4">
          <div>
            <p className="font-mono text-sm font-medium text-black dark:text-zinc-100">
              {photo.filename}
            </p>
            <p className="mt-1 text-xs text-zinc-500">{photo.folder}/</p>
          </div>

          {(photo.cameraModel || photo.width) && (
            <div className="flex flex-col gap-1 text-xs text-zinc-500">
              {photo.cameraModel && (
                <p>
                  {photo.cameraMake} {photo.cameraModel}
                </p>
              )}
              {photo.width && photo.height && (
                <p>
                  {photo.width} &times; {photo.height}
                </p>
              )}
              {photo.takenAt && (
                <p>{new Date(photo.takenAt).toLocaleDateString()}</p>
              )}
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Tags
            </p>
            <PhotoTags photoId={photo.id} />
          </div>

          <div className="mt-auto flex flex-col gap-2">
            {onRename && (
              <button
                onClick={() => onRename(photo)}
                className="w-full rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              >
                Rename
              </button>
            )}
            {onMove && (
              <button
                onClick={() => onMove(photo)}
                className="w-full rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              >
                Move
              </button>
            )}
            <a
              href={imageUrl(photo.s3Key, "2880", "jpg")}
              download
              className="block w-full rounded-md bg-zinc-100 px-3 py-1.5 text-center text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            >
              Download
            </a>
            {onDelete && (
              <button
                onClick={() => onDelete(photo)}
                className="w-full rounded-md bg-red-100 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
