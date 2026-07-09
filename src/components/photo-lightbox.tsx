import { useEffect, useRef, useState } from "react";
import { imageUrl } from "@/lib/image-url";
import { exportPhotos } from "@/lib/api";
import { PhotoTags } from "@/components/photo-tags";
import type { Photo } from "@/lib/types";

type Props = {
  photo: Photo;
  onClose: () => void;
  onDelete?: (photo: Photo) => void;
  onMove?: (photo: Photo) => void;
  onRename?: (photo: Photo, newFilename: string) => Promise<void>;
};

function splitFilename(filename: string): [string, string] {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) return [filename, ""];
  return [filename.slice(0, dotIndex), filename.slice(dotIndex)];
}

export function PhotoLightbox({
  photo,
  onClose,
  onDelete,
  onMove,
  onRename,
}: Props) {
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, ext] = splitFilename(photo.filename);
  const [editValue, setEditValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset transient state when a different photo (or filename) comes in.
  // Adjusting state during render avoids an extra effect-driven render pass.
  const [prevPhotoId, setPrevPhotoId] = useState(photo.id);
  if (prevPhotoId !== photo.id) {
    setPrevPhotoId(photo.id);
    setLoaded(false);
  }

  const [prevFilename, setPrevFilename] = useState(photo.filename);
  if (prevFilename !== photo.filename) {
    setPrevFilename(photo.filename);
    setEditValue(splitFilename(photo.filename)[0]);
    setEditing(false);
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editing) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, editing]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[90vh] w-[min(95vw,1200px)] overflow-hidden rounded-lg bg-background"
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
            {editing ? (
              <div className="flex items-baseline font-mono text-sm font-medium text-foreground">
                <input
                  ref={inputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      e.currentTarget.blur();
                    } else if (e.key === "Escape") {
                      setEditValue(name);
                      setEditing(false);
                    }
                  }}
                  onBlur={async () => {
                    const trimmed = editValue.trim();
                    if (!trimmed || trimmed === name || !onRename) {
                      setEditValue(name);
                      setEditing(false);
                      return;
                    }
                    setEditing(false);
                    setError(null);
                    setRenaming(true);
                    setLoaded(false);
                    try {
                      await onRename(photo, trimmed + ext);
                    } catch {
                      setEditValue(name);
                      setError("Failed to rename file");
                    } finally {
                      setRenaming(false);
                    }
                  }}
                  className="min-w-0 flex-1 rounded border border-border bg-transparent px-1 py-0.5 text-sm outline-none focus:border-foreground/30"
                  data-testid="filename-input"
                />
                <span className="shrink-0 text-foreground/40">{ext}</span>
              </div>
            ) : (
              <p
                className={`font-mono text-sm font-medium text-foreground ${onRename && !renaming ? "cursor-pointer rounded px-1 py-0.5 hover:bg-foreground/5" : ""}`}
                onClick={() => onRename && !renaming && setEditing(true)}
                data-testid="filename-display"
              >
                {editValue}{ext}
              </p>
            )}
            {error && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400" data-testid="rename-error">
                {error}
              </p>
            )}
            <p className="mt-1 text-xs text-foreground/60">{photo.folder}/</p>
          </div>

          {(photo.cameraModel || photo.width || photo.takenAt) && (
            <div className="flex flex-col gap-3 text-sm text-foreground/60">
              {photo.cameraModel && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                    Camera
                  </p>
                  <p>
                    {photo.cameraMake} {photo.cameraModel}
                  </p>
                  {photo.lens && <p>{photo.lens}</p>}
                </div>
              )}

              {(photo.focalLength ||
                photo.aperture ||
                photo.shutterSpeed ||
                photo.iso) && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                    Settings
                  </p>
                  <p>
                    {[
                      photo.focalLength,
                      photo.aperture,
                      photo.shutterSpeed,
                      photo.iso ? `ISO ${photo.iso}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              )}

              {photo.width && photo.height && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                    Dimensions
                  </p>
                  <p>
                    {photo.width} &times; {photo.height}
                  </p>
                </div>
              )}

              {photo.takenAt && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                    Date
                  </p>
                  <p>
                    {new Date(photo.takenAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              )}

              {photo.gpsLatitude && photo.gpsLongitude && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                    Location
                  </p>
                  <a
                    href={`https://maps.google.com/?q=${photo.gpsLatitude},${photo.gpsLongitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    {photo.gpsLatitude.toFixed(4)}, {photo.gpsLongitude.toFixed(4)}
                  </a>
                </div>
              )}
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/40">
              Tags
            </p>
            <PhotoTags photoId={photo.id} disabled={renaming} />
          </div>

          <div className="mt-auto flex flex-col gap-2">
            {onMove && (
              <button
                onClick={() => onMove(photo)}
                disabled={renaming}
                className="w-full rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-foreground/5 disabled:opacity-50 disabled:pointer-events-none"
              >
                Move
              </button>
            )}
            <button
              onClick={() =>
                exportPhotos([photo.id]).catch(() =>
                  alert("Failed to export photo")
                )
              }
              disabled={renaming}
              className="w-full rounded-md border border-border px-3 py-1.5 text-center text-sm transition-colors hover:bg-foreground/5 disabled:opacity-50 disabled:pointer-events-none"
            >
              Download
            </button>
            {onDelete && (
              <button
                onClick={() => onDelete(photo)}
                disabled={renaming}
                className="w-full rounded-md border border-red-500/30 px-3 py-1.5 text-sm text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50 disabled:pointer-events-none dark:text-red-400"
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
