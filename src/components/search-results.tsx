import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { displayName } from "@/lib/keys";
import { searchPhotos } from "@/lib/api";
import { usesMetadataFilter } from "@/lib/search-query";
import { PhotoLightbox } from "@/components/photo-lightbox";
import { BulkTagDialog } from "@/components/bulk-tag-dialog";
import { SelectionCheck } from "@/components/selection-check";
import { SelectionToolbar } from "@/components/selection-toolbar";
import { Thumbnail } from "@/components/thumbnail";
import type { Photo } from "@/lib/types";
import { usePhotoActions } from "@/hooks/use-photo-actions";
import { useSelection, useThumbnailActivation } from "@/hooks/use-selection";

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
    handleBulkDelete,
    handleBulkMove,
    handleRename,
    handleLoadInfo,
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

  // Photos being bulk-tagged, captured when the editor opens.
  const [tagTargets, setTagTargets] = useState<Photo[] | null>(null);
  // Bumped after a bulk tag edit to re-run the search, so photos that no longer
  // match a tag-based query (e.g. removing the tag being viewed) drop out.
  const [reloadNonce, setReloadNonce] = useState(0);

  const { selected, isSelected, clear, selectAll, setPool, setActions } =
    useSelection();
  const { onClick, onDoubleClick } = useThumbnailActivation(setActive);

  // Expose bulk actions + the selectable pool to the toolbar while results
  // are on screen.
  useEffect(() => {
    setActions({
      onDelete: async (targets) => {
        if (await handleBulkDelete(targets)) clear();
      },
      onMove: async (targets) => {
        if (await handleBulkMove(targets)) clear();
      },
      onTag: (targets) => setTagTargets(targets),
    });
    return () => setActions(null);
  }, [setActions, handleBulkDelete, handleBulkMove, clear]);

  useEffect(() => {
    setPool(photos);
    return () => setPool([]);
  }, [photos, setPool]);

  // A new search is a fresh set of results; drop any lingering selection.
  useEffect(() => {
    return () => clear();
  }, [searchKey, clear]);

  // Escape clears the selection; Cmd/Ctrl+A selects everything. Both yield to
  // the lightbox and to text fields.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // The lightbox and the bulk-tag editor own the keyboard while open.
      if (active || tagTargets) return;
      if (e.key === "Escape" && selected.length) {
        clear();
        return;
      }
      const target = e.target as HTMLElement;
      const inField =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
        if (inField) return;
        if (!photos.length) return;
        e.preventDefault();
        selectAll(photos);
      }
      // T opens the bulk tag editor for the current selection.
      if (
        (e.key === "t" || e.key === "T") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        selected.length
      ) {
        if (inField) return;
        e.preventDefault();
        setTagTargets(selected);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selected, active, tagTargets, clear, selectAll, photos]);

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
  }, [q, tag, setPhotos, reloadNonce]);

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
    <div className="flex flex-col gap-4">
      <div className="flex min-h-[34px] items-center justify-between gap-4">
        {selected.length > 0 ? (
          <SelectionToolbar />
        ) : (
          <p className="text-sm text-foreground/60">
            {photos.length} {photos.length === 1 ? "result" : "results"}
          </p>
        )}
      </div>
      {usesMetadataFilter(q) && (
        <p className="-mt-2 text-xs text-foreground/40">
          Metadata filters only match photos whose info has been loaded.
        </p>
      )}
      <div className="fade-in grid select-none gap-2 grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))]">
        {photos.map((photo) => (
          <button
            key={photo.id}
            onClick={(e) => onClick(e, photo)}
            onDoubleClick={() => onDoubleClick(photo)}
            className={`group relative aspect-square overflow-hidden rounded-md border-2 bg-foreground/0 dark:bg-foreground/5 ${
              isSelected(photo.id) ? "border-accent" : "border-transparent"
            }`}
          >
            {photo.processingStatus === "completed" ? (
              <Thumbnail photo={photo} />
            ) : (
              <div className="flex h-full items-center justify-center">
                <span className="text-xs text-foreground/40">
                  {photo.processingStatus}
                </span>
              </div>
            )}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-2 pb-2 pt-6">
              <p className="truncate text-xs text-white">{displayName(photo.filename)}</p>
              <p className="text-[10px] text-white/70">{photo.folder}</p>
            </div>
            {isSelected(photo.id) && <SelectionCheck />}
          </button>
        ))}
      </div>

      {active &&
        (() => {
          const index = photos.findIndex((p) => p.id === active.id);
          const count = photos.length;
          // Wrap around so the arrows cycle through the results endlessly.
          const canNavigate = index >= 0 && count > 1;
          const prev = photos[(index - 1 + count) % count];
          const next = photos[(index + 1) % count];
          return (
            <PhotoLightbox
              photo={active}
              onClose={() => setActive(null)}
              onDelete={handleDelete}
              onMove={handleMove}
              onRename={handleRename}
              onLoadInfo={handleLoadInfo}
              onPrev={canNavigate ? () => setActive(prev) : undefined}
              onNext={canNavigate ? () => setActive(next) : undefined}
            />
          );
        })()}

      {tagTargets && (
        <BulkTagDialog
          photos={tagTargets}
          onClose={() => setTagTargets(null)}
          // Keep the selection after applying so the same photos can be tagged
          // again, but re-run the search so any that no longer match a
          // tag-based query drop out of the results.
          onApplied={() => {
            setTagTargets(null);
            setReloadNonce((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
