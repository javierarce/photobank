import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { imageUrl, originalUrl } from "@/lib/image-url";
import { displayName } from "@/lib/keys";
import { exportPhotos } from "@/lib/api";
import { ExportButton } from "@/components/export-button";
import { FolderCoverButton } from "@/components/folder-cover-button";
import { PhotoTags } from "@/components/photo-tags";
import type { Photo } from "@/lib/types";

type Props = {
  photo: Photo;
  onClose: () => void;
  onDelete?: (photo: Photo) => void;
  onMove?: (photo: Photo) => void;
  onRename?: (photo: Photo, newFilename: string) => Promise<void>;
  /** Swap the photo's pixels for another file, keeping its key and tags.
   * Resolves once the new version is live; rejects with a message string. */
  onReplace?: (photo: Photo) => Promise<void>;
  /** Fetch EXIF/dimensions for this photo from the bucket on demand. */
  onLoadInfo?: (photo: Photo) => Promise<void>;
  /** Called after the photo's tags are added/removed, so the surrounding view
   * can re-run a tag-based search. */
  onTagsChange?: () => void;
  // Provided when there is a neighbouring photo to move to; omitted at the
  // ends of the list so the arrows and arrow keys become no-ops.
  onPrev?: () => void;
  onNext?: () => void;
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
  onReplace,
  onLoadInfo,
  onTagsChange,
  onPrev,
  onNext,
}: Props) {
  const [loaded, setLoaded] = useState(false);
  // When the 2880px variant is missing (photo synced into the bucket
  // externally, refresh not done yet), fall back to the original object.
  const [fallback, setFallback] = useState(false);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  /** 0–100 from the backend while a replace runs. */
  const [replaceProgress, setReplaceProgress] = useState(0);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  // Show and edit the user-facing name (legacy "_original" marker stripped),
  // never the raw stored filename.
  const [name, ext] = splitFilename(displayName(photo.filename));
  const [editValue, setEditValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Reset transient state when a different photo (or filename) comes in.
  // Adjusting state during render avoids an extra effect-driven render pass.
  const [prevPhotoId, setPrevPhotoId] = useState(photo.id);
  if (prevPhotoId !== photo.id) {
    setPrevPhotoId(photo.id);
    setLoaded(false);
    setFallback(false);
    setLoadingInfo(false);
    setInfoError(null);
    setReplaceError(null);
    setReplaceProgress(0);
  }

  const [prevFilename, setPrevFilename] = useState(photo.filename);
  if (prevFilename !== photo.filename) {
    setPrevFilename(photo.filename);
    setEditValue(splitFilename(displayName(photo.filename))[0]);
    setEditing(false);
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // The backend reports a replace on the same channel a drop uses, keyed by
  // the photo's s3_key. Subscribed for as long as the lightbox is open, not
  // just while replacing: registering a listener is async, so arming it on
  // click would race the first events.
  useEffect(() => {
    const unlisten = listen<{ key: string; progress: number }>(
      "import://progress",
      (event) => {
        if (event.payload.key === photo.s3Key) {
          setReplaceProgress(event.payload.progress);
        }
      }
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [photo.s3Key]);

  const handleReplace = async () => {
    if (!onReplace || replacing) return;
    setReplaceError(null);
    setReplaceProgress(0);
    setReplacing(true);
    // The picture deliberately stays on screen: onReplace opens the file
    // picker first, so blanking here would hide the photo before the user has
    // even chosen a file — and leave it hidden if they back out. It's also
    // still the truth until the new bytes land. The progress bar carries the
    // "something is happening" signal instead.
    try {
      await onReplace(photo);
    } catch (err) {
      // Tauri commands reject with a plain message string (see src/lib/api.ts).
      // A cancelled file picker resolves without error, so anything here is real.
      setReplaceError(typeof err === "string" ? err : "Failed to replace photo");
    } finally {
      setReplacing(false);
    }
  };

  const handleLoadInfo = async () => {
    if (!onLoadInfo || loadingInfo) return;
    setInfoError(null);
    setLoadingInfo(true);
    try {
      await onLoadInfo(photo);
      // Success replaces the photo prop with a row that has dimensions, so
      // the button unmounts; no local success state needed.
    } catch (err) {
      // Tauri commands reject with a plain message string (see src/lib/api.ts)
      setInfoError(typeof err === "string" ? err : "Failed to load photo info");
    } finally {
      setLoadingInfo(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (editing) return;
      if (e.key === "Escape") onClose();
      // Navigating mid-replace would carry the in-flight state onto whichever
      // photo lands next, since the panel outlives the photo it started on.
      else if (replacing) return;
      else if (e.key === "ArrowLeft") onPrev?.();
      else if (e.key === "ArrowRight") onNext?.();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onPrev, onNext, editing, replacing]);

  return (
    <div
      className="backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={(e) => {
        // Don't let the backdrop click bubble to the page's deselect handler.
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="modal-in relative flex h-[85vh] w-[min(95vw,1200px)] overflow-hidden rounded-lg border-0 bg-background dark:border dark:border-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex w-0 flex-1 items-center justify-center bg-black">
          {!loaded && (
            <div className="absolute inset-0 flex items-center justify-center">
              <svg
                className="h-8 w-8 animate-spin text-white/40 [animation-duration:0.6s]"
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
            // updatedAt doubles as a cache-buster: a replace keeps the key but
            // changes the bytes, and the handler serves them `immutable`.
            src={
              fallback
                ? originalUrl(photo.s3Key, photo.updatedAt)
                : imageUrl(photo.s3Key, "2880", "webp", photo.updatedAt)
            }
            alt={photo.filename}
            onLoad={() => setLoaded(true)}
            onError={() => setFallback(true)}
            className={`h-full w-full object-contain transition-opacity duration-150 ease-out ${
              loaded ? "opacity-100" : "opacity-0"
            }`}
          />
          {/* Same language as the grid's upload tiles: a percentage badge and
              a bar along the bottom edge. */}
          {replacing && (
            <>
              <span
                className="absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-xs font-medium tabular-nums text-white"
                data-testid="replace-progress"
              >
                Replacing… {replaceProgress}%
              </span>
              <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
                <div
                  className="h-full bg-accent transition-[width] duration-200 ease-linear"
                  style={{ width: `${replaceProgress}%` }}
                />
              </div>
            </>
          )}
          {onPrev && (
            <button
              type="button"
              aria-label="Previous photo"
              onClick={onPrev}
              disabled={replacing}
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white/80 transition hover:bg-black/60 hover:text-white active:scale-95 disabled:pointer-events-none disabled:opacity-40"
            >
              <svg
                className="h-6 w-6"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
          )}
          {onNext && (
            <button
              type="button"
              aria-label="Next photo"
              onClick={onNext}
              disabled={replacing}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white/80 transition hover:bg-black/60 hover:text-white active:scale-95 disabled:pointer-events-none disabled:opacity-40"
            >
              <svg
                className="h-6 w-6"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </button>
          )}
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
                className={`font-mono text-sm font-medium text-foreground ${onRename && !renaming && !replacing ? "cursor-pointer rounded px-1 py-0.5 hover:bg-foreground/5" : ""}`}
                onClick={() => onRename && !renaming && !replacing && setEditing(true)}
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
            <button
              type="button"
              // Close first so the parent clears `active`; otherwise the
              // lightbox would stay mounted over the destination folder.
              onClick={() => {
                onClose();
                navigate(`/folders/${encodeURIComponent(photo.folder)}`);
              }}
              className="mt-1 -ml-1 rounded px-1 py-0.5 text-left text-xs text-foreground/60 transition hover:bg-foreground/5 hover:text-foreground"
              data-testid="folder-link"
            >
              {photo.folder}
            </button>
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

          {onLoadInfo && !photo.width && (
            <div>
              <button
                type="button"
                onClick={handleLoadInfo}
                disabled={loadingInfo || renaming}
                data-testid="load-info"
                className="w-full rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-foreground/5 active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none"
              >
                {loadingInfo ? "Loading info…" : "Load info"}
              </button>
              <p className="mt-1.5 text-xs text-foreground/40">
                Reads dimensions and EXIF from the original in your bucket.
              </p>
              {infoError && (
                <p
                  className="mt-1 text-xs text-red-600 dark:text-red-400"
                  data-testid="load-info-error"
                >
                  {infoError}
                </p>
              )}
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/40">
              Tags
            </p>
            <PhotoTags
              photoId={photo.id}
              disabled={renaming || replacing}
              onTagsChange={onTagsChange}
            />
          </div>

          <div className="mt-auto flex flex-col gap-2">
            {replaceError && (
              <p
                className="text-xs text-red-600 dark:text-red-400"
                data-testid="replace-error"
              >
                {replaceError}
              </p>
            )}
            <FolderCoverButton photo={photo} disabled={renaming || replacing} />
            {onReplace && (
              <button
                type="button"
                onClick={handleReplace}
                disabled={renaming || replacing}
                data-testid="replace-photo"
                title="Swap in a new version of this file, keeping its name and link"
                className="w-full rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-foreground/5 active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none"
              >
                {replacing ? "Replacing…" : "Replace…"}
              </button>
            )}
            {onMove && (
              <button
                onClick={() => onMove(photo)}
                disabled={renaming || replacing}
                className="w-full rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-foreground/5 active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none"
              >
                Move
              </button>
            )}
            <ExportButton
              fullWidth
              menuPlacement="top"
              disabled={renaming || replacing}
              onExport={(resolution) =>
                exportPhotos([photo.id], resolution).catch(() =>
                  alert("Failed to export photo")
                )
              }
            />
            {onDelete && (
              <button
                onClick={() => onDelete(photo)}
                disabled={renaming || replacing}
                className="w-full rounded-md border border-red-500/30 px-3 py-1.5 text-sm text-red-600 transition hover:bg-red-500/10 active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none dark:text-red-400"
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
