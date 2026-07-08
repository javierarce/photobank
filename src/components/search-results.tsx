"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { imageUrl } from "@/lib/image-url";
import { PhotoLightbox } from "@/components/photo-lightbox";
import { usePhotoActions } from "@/hooks/use-photo-actions";

export function SearchResults() {
  const searchParams = useSearchParams();
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
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (tag) params.set("tag", tag);

    fetch(`/api/search?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setPhotos(data.photos);
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

    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoIds: Array.from(selectedIds) }),
    });

    if (!res.ok) return;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "photos.zip";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (status.state === "loading") {
    return <p className="text-sm text-zinc-500">Searching...</p>;
  }

  if (status.state === "error") {
    return <p className="text-sm text-red-600 dark:text-red-400">Search failed.</p>;
  }

  if (!q && !tag) {
    return <p className="text-sm text-zinc-500">Enter a search term.</p>;
  }

  if (!photos.length) {
    return <p className="text-sm text-zinc-500">No results found.</p>;
  }

  return (
    <div className="flex flex-col gap-4" onClick={(e) => {
      if (e.target === e.currentTarget) clearSelection();
    }}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          {photos.length} {photos.length === 1 ? "result" : "results"}
        </p>
        {selectedIds.size > 0 && (
          <button
            onClick={handleBulkDownload}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-black dark:hover:bg-zinc-200"
          >
            Download {selectedIds.size} selected
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {photos.map((photo) => (
          <div
            key={photo.id}
            className={`group relative aspect-square overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-900 ${
              selectedIds.has(photo.id)
                ? "ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-black"
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
                  className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  loading="lazy"
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <span className="text-xs text-zinc-400">
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
                className="h-4 w-4 rounded border-zinc-300 accent-blue-500"
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
