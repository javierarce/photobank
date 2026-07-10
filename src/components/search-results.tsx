import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { imageUrl } from "@/lib/image-url";
import { exportPhotos, searchPhotos } from "@/lib/api";
import { PhotoLightbox } from "@/components/photo-lightbox";
import { usePhotoActions } from "@/hooks/use-photo-actions";

export function SearchResults() {
  const [searchParams] = useSearchParams();
  const q = searchParams.get("q") || "";
  const tag = searchParams.get("tag") || "";
  const {
    photos,
    setPhotos,
    active,
    setActive,
    handleDelete,
    handleMove,
    handleRename,
  } = usePhotoActions();
  const searchKey = q || tag ? `${q}|${tag}` : null;
  // Track the request lifecycle per search key; adjusting state during
  // render (instead of in the effect) avoids a cascading render pass
  const [status, setStatus] = useState<{
    key: string | null;
    state: "idle" | "loading" | "done" | "error";
  }>({ key: null, state: "idle" });
  if (status.key !== searchKey) {
    setStatus({ key: searchKey, state: searchKey ? "loading" : "idle" });
  }
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  useEffect(() => {
    if (!selectedIds.size || active) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedIds.size, active, clearSelection]);

  useEffect(() => {
    if (!q && !tag) return;
    const key = `${q}|${tag}`;
    let cancelled = false;

    searchPhotos({ q, tag })
      .then((photos) => {
        if (cancelled) return;
        setPhotos(photos);
        setStatus({ key, state: "done" });
      })
      .catch(() => {
        if (!cancelled) setStatus({ key, state: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [q, tag, setPhotos]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkDownload = async () => {
    if (!selectedIds.size) return;
    try {
      // Opens a save dialog on the Rust side; resolves with the written path
      // or null when the user cancels.
      await exportPhotos(Array.from(selectedIds));
    } catch {
      alert("Failed to export photos");
    }
  };

  if (status.state === "loading") {
    return <p className="text-sm text-foreground/60">Searching...</p>;
  }

  if (status.state === "error") {
    return <p className="text-sm text-red-600 dark:text-red-400">Search failed.</p>;
  }

  if (!q && !tag) {
    return <p className="text-sm text-foreground/60">Enter a search term.</p>;
  }

  if (!photos.length) {
    return <p className="text-sm text-foreground/60">No results found.</p>;
  }

  return (
    <div className="flex flex-col gap-4" onClick={(e) => {
      if (e.target === e.currentTarget) clearSelection();
    }}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-foreground/60">
          {photos.length} {photos.length === 1 ? "result" : "results"}
        </p>
        {selectedIds.size > 0 && (
          <button
            onClick={handleBulkDownload}
            className="rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
          >
            Download {selectedIds.size} selected
          </button>
        )}
      </div>
      <div className="fade-in grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {photos.map((photo) => (
          <div
            key={photo.id}
            className={`group relative aspect-square overflow-hidden rounded-md bg-foreground/5 ${
              selectedIds.has(photo.id)
                ? "ring-2 ring-accent ring-offset-2 ring-offset-background"
                : ""
            }`}
          >
            <button
              onClick={() => setActive(photo)}
              className="h-full w-full"
            >
              {photo.processingStatus === "completed" ? (
                <img
                  src={imageUrl(photo.s3Key, "640", "webp")}
                  alt={photo.filename}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <span className="text-xs text-foreground/40">
                    {photo.processingStatus}
                  </span>
                </div>
              )}
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-2 pb-2 pt-6">
                <p className="truncate text-xs text-white">
                  {photo.filename}
                </p>
                <p className="text-[10px] text-white/70">{photo.folder}</p>
              </div>
            </button>
            <label className="absolute right-2 top-2 z-10">
              <input
                type="checkbox"
                checked={selectedIds.has(photo.id)}
                onChange={() => toggleSelect(photo.id)}
                className="size-4 accent-foreground"
              />
            </label>
          </div>
        ))}
      </div>

      {active && (
        <PhotoLightbox
          photo={active}
          onClose={() => setActive(null)}
          onDelete={handleDelete}
          onMove={handleMove}
          onRename={handleRename}
        />
      )}
    </div>
  );
}
