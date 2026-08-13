import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
  memo,
  type MouseEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { imageUrl, previewUrl } from "@/lib/image-url";
import {
  listPhotos,
  searchPhotoIds,
  REFRESH_PROGRESS_EVENT,
  type RefreshProgress,
} from "@/lib/api";
import { usesMetadataFilter } from "@/lib/search-query";
import { PhotoLightbox } from "@/components/photo-lightbox";
import { BulkTagDialog } from "@/components/bulk-tag-dialog";
import { SelectionCheck } from "@/components/selection-check";
import { Thumbnail } from "@/components/thumbnail";
import { usePhotoActions } from "@/hooks/use-photo-actions";
import { useSelection, useThumbnailActivation } from "@/hooks/use-selection";
import { useGridNavigation } from "@/hooks/use-grid-navigation";
import { usePresence, type PresenceState } from "@/hooks/use-presence";
import { sortPhotos, DEFAULT_SORT_MODE, type SortMode } from "@/lib/photo-sort";
import type { Photo } from "@/lib/types";
import type { UploadFile } from "@/hooks/use-upload";

export type PhotoGridRef = {
  refresh: () => Promise<void>;
};

// Module-level so its identity is stable across renders (the presence hook
// keys off it).
const photoKey = (p: Photo) => p.id;

// A shared empty default so an omitted `uploads` prop keeps a stable identity
// across renders — a fresh `[]` each render would break the memo chain that
// keeps visiblePhotos stable and re-introduce the setPool render loop.
const NO_UPLOADS: UploadFile[] = [];

type Props = {
  folder: string;
  /** How to order the tiles; defaults to newest-first by filename date. */
  sortMode?: SortMode;
  /** Ankitron-style typed query (tag:, camera:, iso:>=800, …) run backend-side
   * by search_photo_ids scoped to this folder; empty shows every photo. */
  query?: string;
  /** Notifies the parent whether this folder has any photos (drives the
   * in-folder search field, which is pointless on an empty folder). */
  onHasPhotosChange?: (hasPhotos: boolean) => void;
  /** In-flight uploads, rendered as tiles with an inline progress bar. */
  uploads?: UploadFile[];
  onDismissUpload?: (key: string) => void;
  onCancelUpload?: (key: string) => void;
};

export const PhotoGrid = forwardRef<PhotoGridRef, Props>(function PhotoGrid(
  {
    folder,
    sortMode = DEFAULT_SORT_MODE,
    query = "",
    onHasPhotosChange,
    uploads = NO_UPLOADS,
    onDismissUpload,
    onCancelUpload,
  },
  ref
) {
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
    handleReplace,
    handleLoadInfo,
  } = usePhotoActions();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Photos being bulk-tagged, captured when the editor opens so it keeps
  // working on that set even if the selection later changes.
  const [tagTargets, setTagTargets] = useState<Photo[] | null>(null);

  const {
    selected,
    isSelected,
    toggle,
    extendTo,
    clear,
    retain,
    selectAll,
    setPool,
    setActions,
  } = useSelection();
  const { onClick, onDoubleClick } = useThumbnailActivation(setActive);
  const gridRef = useRef<HTMLDivElement>(null);

  // Keep showing the local preview while the photo is pending/processing —
  // the real tile has nothing to render until the worker finishes. Hand off
  // only once the 640px variant has actually loaded (preloaded below), so the
  // preview is never replaced by a blank tile.
  const photoById = useMemo(
    () => new Map(photos.map((p) => [p.id, p])),
    [photos]
  );
  const activeUploads = useMemo(
    () =>
      uploads.filter(
        (u) => !u.id || photoById.get(u.id)?.processingStatus !== "failed"
      ),
    [uploads, photoById]
  );
  const activeUploadIds = useMemo(
    () => new Set(activeUploads.map((u) => u.id)),
    [activeUploads]
  );
  // Order the tiles per the chosen sort; this also drives the selection pool,
  // Cmd+A, and lightbox prev/next below, so everything follows what's on
  // screen rather than the raw fetch order.
  const sortedPhotos = useMemo(
    () => sortPhotos(photos, sortMode),
    [photos, sortMode]
  );
  // visiblePhotos must keep a STABLE identity when nothing meaningful changed:
  // the pool effect below feeds setPool, which re-renders this component, and
  // `uploads` arrives as a fresh array each parent render — so a reference that
  // churned every render would re-fire the effect and loop. Depend on
  // sortedPhotos BY REFERENCE (it only changes when photos or the sort change,
  // carrying content updates like updated_at through) plus a value-key for the
  // active upload ids (whose Set identity churns with the uploads prop).
  const activeUploadKey = [...activeUploadIds].join(",");
  // The in-folder search reuses the global typed-query engine (tag:, camera:,
  // iso:>=800, …) by running search_photos scoped to this folder and keeping
  // the ids it matched. `matchIds` is null when no search is active; then every
  // photo shows. Kept across keystrokes so the grid holds the last result while
  // the next debounced search is in flight, rather than flashing the full set.
  const trimmedQuery = query.trim();
  // The last search's outcome, tagged with the query it belongs to. Carrying the
  // query means the filter can keep showing a previous (stale) result while the
  // next debounced search is in flight — deliberately, so refining a query
  // doesn't flash the full folder — while the empty state and the error message
  // below only speak for a result that actually corresponds to what's typed.
  const [search, setSearch] = useState<{
    query: string;
    ids: Set<string>;
    failed: boolean;
  } | null>(null);
  // Bumped after a tag edit (bulk editor or the lightbox's per-photo tags).
  // Tags live outside the `photos` rows, so unlike every other mutation they
  // don't move the fingerprint below and need an explicit signal.
  const [tagEditNonce, setTagEditNonce] = useState(0);

  // Any change to the folder's rows can change what the query matches: an import
  // landing, a library refresh or "Load info" filling EXIF, a rename. Folding a
  // digest of the rows into the search key re-runs the search for all of them,
  // instead of hand-wiring a callback per mutation and missing the ones nobody
  // thought of. A reload that returns identical rows leaves the digest
  // unchanged, so the 3s processing poll doesn't re-search on every tick.
  const photosFingerprint = useMemo(
    () => photos.map((p) => `${p.id}:${p.updatedAt}`).join(","),
    [photos]
  );

  useEffect(() => {
    if (!trimmedQuery) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchPhotoIds(trimmedQuery, folder)
        .then((ids) => {
          if (!cancelled)
            setSearch({ query: trimmedQuery, ids: new Set(ids), failed: false });
        })
        // Fail closed — filter to nothing rather than implying everything
        // matched — but record the failure so the UI can say so instead of
        // claiming the folder has no matches.
        .catch(() => {
          if (!cancelled)
            setSearch({ query: trimmedQuery, ids: new Set(), failed: true });
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmedQuery, folder, photosFingerprint, tagEditNonce]);

  const reloadSearch = useCallback(() => setTagEditNonce((n) => n + 1), []);

  // True once the in-flight search has caught up with what's typed; until then
  // the tiles shown belong to the previous query.
  const searchSettled = search?.query === trimmedQuery;

  const visiblePhotos = useMemo(
    () =>
      sortedPhotos.filter(
        (p) =>
          !activeUploadIds.has(p.id) &&
          (!trimmedQuery || search === null || search.ids.has(p.id))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortedPhotos, activeUploadKey, trimmedQuery, search]
  );

  // Keyboard cursor over the tiles: arrows/hjkl move DOM focus between tiles
  // (so the highlight is their own :focus-visible style, shared with Tab),
  // Enter opens the lightbox, `x` toggles selection, and Shift+move sweeps a
  // range. Read visiblePhotos through a ref so the id lookup stays stable. The
  // cursor yields while the lightbox or the bulk-tag editor owns the keyboard.
  const visibleRef = useRef(visiblePhotos);
  useEffect(() => {
    visibleRef.current = visiblePhotos;
  }, [visiblePhotos]);
  const navGetId = useCallback((i: number) => visibleRef.current[i]?.id, []);
  useGridNavigation({
    count: visiblePhotos.length,
    getId: navGetId,
    containerRef: gridRef,
    enabled: !active && !tagTargets,
    onOpen: (i) => {
      const photo = visiblePhotos[i];
      if (photo) setActive(photo);
    },
    onSelect: (i) => {
      const photo = visiblePhotos[i];
      if (photo) toggle(photo);
    },
    onMove: (next, { shift, prevIndex }) => {
      if (!shift) return;
      const target = visiblePhotos[next];
      if (!target) return;
      extendTo(target, visiblePhotos[prevIndex] ?? target);
    },
  });

  // Expose bulk actions to the toolbar while this grid is on screen; clear the
  // selection when they run so stale tiles don't linger.
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

  // Publish the selectable pool in displayed order so "Select all" and
  // shift-click range selection span the tiles the user actually sees.
  useEffect(() => {
    setPool(visiblePhotos);
    return () => setPool([]);
  }, [visiblePhotos, setPool]);

  // A search hides tiles, so confine the selection to what's still on screen:
  // otherwise the toolbar would count photos the user can't see and a bulk
  // delete would destroy them. Only prune once the search has caught up with
  // what's typed, so the in-flight window doesn't drop photos the new query
  // will keep.
  useEffect(() => {
    if (!trimmedQuery || !searchSettled) return;
    retain(new Set(visiblePhotos.map((p) => p.id)));
  }, [trimmedQuery, searchSettled, visiblePhotos, retain]);

  // Selection belongs to the current folder; drop it when the folder changes
  // or when leaving the grid entirely.
  useEffect(() => {
    return () => clear();
  }, [folder, clear]);

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
        if (!visiblePhotos.length) return;
        e.preventDefault();
        selectAll(visiblePhotos);
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
  }, [selected, active, tagTargets, clear, selectAll, visiblePhotos]);

  const loadPhotos = useCallback(() => {
    return listPhotos(folder)
      .then((photos) => {
        setPhotos(photos);
        setError(null);
      })
      .catch(() => setError("Failed to load photos."))
      .finally(() => setLoading(false));
  }, [folder, setPhotos]);

  useEffect(() => {
    loadPhotos();
  }, [loadPhotos]);

  // Poll while any photos are still processing
  useEffect(() => {
    const hasUnfinished = photos.some(
      (p) => p.processingStatus === "pending" || p.processingStatus === "processing"
    );
    if (!hasUnfinished) return;

    const interval = setInterval(loadPhotos, 3000);
    return () => clearInterval(interval);
  }, [photos, loadPhotos]);

  useImperativeHandle(ref, () => ({ refresh: loadPhotos }));

  // Tell the parent whether this folder has any photos so it can show/hide the
  // in-folder search field (searching an empty folder makes no sense).
  useEffect(() => {
    onHasPhotosChange?.(photos.length > 0);
  }, [photos.length, onHasPhotosChange]);

  // A library refresh (Settings, or auto-started after a rebuild) regenerates
  // missing variants; reload once it settles so tiles swap from their
  // original-image fallback to the real thumbnails.
  useEffect(() => {
    const unlisten = listen<RefreshProgress>(REFRESH_PROGRESS_EVENT, (event) => {
      if (event.payload.status !== "running") loadPhotos();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadPhotos]);

  // `status === "done"` is what says the backend has finished, and it is load
  // bearing: a REPLACE targets a row that is already "completed", so without
  // it the handoff fires the moment the tile learns its photo id — dismissing
  // the tile at 0% and hiding the progress entirely. An import can't hit that
  // (its row is "pending" until the end) which is why it went unnoticed.
  const uploadsAwaitingThumbnail = activeUploads.filter(
    (u) =>
      u.status === "done" &&
      u.id &&
      photoById.get(u.id)?.processingStatus === "completed"
  );

  // Animate tiles as they come and go: new photos fade in, deleted ones fade
  // out in place before neighbours settle. The grid is keyed by folder in the
  // route, so a folder switch remounts this component and re-baselines from
  // empty rather than cross-fading the old folder's tiles against the new
  // ones. Nav/selection still read the live `visiblePhotos` below.
  const tiles = usePresence(visiblePhotos, photoKey);

  // Failed processing hands off to the photo tile, which owns the error state.
  useEffect(() => {
    if (!onDismissUpload) return;
    for (const u of uploads) {
      if (!u.id) continue;
      const photo = photos.find((p) => p.id === u.id);
      if (photo?.processingStatus === "failed") onDismissUpload(u.key);
    }
  }, [uploads, photos, onDismissUpload]);

  if (loading && !activeUploads.length) {
    return <p className="text-sm text-foreground/60">Loading photos...</p>;
  }

  if (error && !activeUploads.length) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  if (!photos.length && !activeUploads.length) {
    return (
      <p className="text-sm text-foreground/60">No photos in this folder.</p>
    );
  }

  // The empty-results shortcut skips the whole main render, so it must not fire
  // while an overlay the user is interacting with is open: an edit made inside
  // one (removing the tag being searched) can empty the results mid-interaction,
  // and unmounting here would tear the overlay down without clearing `active` /
  // `tagTargets` — leaving the keyboard handler short-circuited and the overlay
  // primed to pop back open later. Falling through keeps them mounted over an
  // empty grid until the user closes them. It also waits for `searchSettled`,
  // so the message never speaks for a query that hasn't been run yet.
  if (
    trimmedQuery &&
    searchSettled &&
    !visiblePhotos.length &&
    !activeUploads.length &&
    !active &&
    !tagTargets
  ) {
    // A failed search filters everything out too, but saying "no matches" would
    // be a lie — report the failure instead, matching the global search page.
    if (search?.failed) {
      return (
        <p className="text-sm text-red-600 dark:text-red-400">Search failed.</p>
      );
    }
    return (
      <>
        {usesMetadataFilter(trimmedQuery) && (
          <p className="mb-3 text-xs text-foreground/40">
            Metadata filters only match photos whose info has been loaded.
          </p>
        )}
        <p className="text-sm text-foreground/60">
          No photos match “{trimmedQuery}”.
        </p>
      </>
    );
  }

  return (
    <>
      {onDismissUpload &&
        uploadsAwaitingThumbnail.map((upload) => (
          <img
            key={upload.key}
            // Version-stamped like every other thumbnail: after a replace the
            // key is unchanged, so without it this would hand off on the
            // previous image's cached bytes.
            src={imageUrl(
              photoById.get(upload.id!)!.s3Key,
              "640",
              "webp",
              photoById.get(upload.id!)!.updatedAt
            )}
            alt=""
            className="hidden"
            onLoad={() => onDismissUpload(upload.key)}
            onError={() => onDismissUpload(upload.key)}
          />
        ))}
      {trimmedQuery && usesMetadataFilter(trimmedQuery) && (
        <p className="mb-3 text-xs text-foreground/40">
          Metadata filters only match photos whose info has been loaded.
        </p>
      )}
      <div
        ref={gridRef}
        className="fade-in grid select-none gap-2 grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))]"
      >
        {activeUploads.map((upload) => (
          <UploadTile
            key={upload.key}
            upload={upload}
            onDismiss={onDismissUpload}
            onCancel={onCancelUpload}
          />
        ))}
        {tiles.map((entry) => (
          <PhotoTile
            key={entry.key}
            photo={entry.item}
            presenceState={entry.state}
            selected={isSelected(entry.item.id)}
            // The corner check is the multi-select cue; a lone selected photo
            // says so with its accent border alone (see PhotoTile).
            showCheck={isSelected(entry.item.id) && selected.length > 1}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
          />
        ))}
      </div>

      {active &&
        (() => {
          const index = visiblePhotos.findIndex((p) => p.id === active.id);
          const count = visiblePhotos.length;
          // Wrap around so the arrows cycle through the folder endlessly.
          const canNavigate = index >= 0 && count > 1;
          const prev = visiblePhotos[(index - 1 + count) % count];
          const next = visiblePhotos[(index + 1) % count];
          return (
            <PhotoLightbox
              photo={active}
              onClose={() => setActive(null)}
              onDelete={handleDelete}
              onMove={handleMove}
              onRename={handleRename}
              onReplace={handleReplace}
              onLoadInfo={handleLoadInfo}
              onTagsChange={reloadSearch}
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
          // again without re-selecting; re-run any active search so photos that
          // no longer match a tag: query drop out.
          onApplied={() => {
            setTagTargets(null);
            reloadSearch();
          }}
        />
      )}
    </>
  );
});

/** A single selectable grid tile. Memoized so a selection change only
 * re-renders the tiles whose `selected` flag actually flipped, not the whole
 * grid — with the click handlers kept stable (see selection-provider's
 * snapshot), toggling one photo reconciles one tile instead of N. `showCheck`
 * is passed pre-resolved (rather than the selection count) for the same reason:
 * when the selection grows past one, only the tiles whose badge appears
 * re-render. */
const PhotoTile = memo(function PhotoTile({
  photo,
  presenceState,
  selected,
  showCheck,
  onClick,
  onDoubleClick,
}: {
  photo: Photo;
  presenceState: PresenceState;
  selected: boolean;
  /** Whether to show the corner check — only while several photos are
   * selected; a single selection is marked by the border alone. */
  showCheck: boolean;
  onClick: (e: MouseEvent, photo: Photo) => void;
  onDoubleClick: (photo: Photo) => void;
}) {
  return (
    <button
      // The keyboard cursor is this button's own focus; its highlight lives in
      // globals.css under [data-nav-id]:focus-visible.
      data-nav-id={photo.id}
      data-presence={presenceState}
      onClick={(e) => onClick(e, photo)}
      onDoubleClick={() => onDoubleClick(photo)}
      className={`photo-tile group relative aspect-square overflow-hidden rounded-md border-2 bg-foreground/0 dark:bg-foreground/5 ${
        selected ? "border-accent" : "border-transparent"
      }`}
    >
      {photo.processingStatus === "completed" ? (
        <Thumbnail photo={photo} />
      ) : (
        <div className="flex h-full items-center justify-center">
          <span className="text-xs text-foreground/40">
            {photo.processingStatus === "pending" && "Pending..."}
            {photo.processingStatus === "processing" && "Processing..."}
            {photo.processingStatus === "failed" && "Failed"}
          </span>
        </div>
      )}
      {showCheck && <SelectionCheck />}
    </button>
  );
});

/** A grid tile for an in-flight import: a preview of the source image (read
 * from its local path via the `preview://` scheme) with inline progress on
 * top. The filename sits behind the preview and shows through until the pixels
 * load — or stays put if there's no path or the file can't be decoded. */
function UploadTile({
  upload,
  onDismiss,
  onCancel,
}: {
  upload: UploadFile;
  onDismiss?: (key: string) => void;
  onCancel?: (key: string) => void;
}) {
  const failed = upload.status === "error";
  const [previewLoaded, setPreviewLoaded] = useState(false);
  // A same-name re-drop replaces this entry in place (the tile is keyed by
  // upload.key), so re-gate on the source path: if the new file's preview
  // fails to load, previewLoaded must fall back to false rather than stay
  // stuck at true from the prior image and expose the broken-image glyph.
  const [prevPath, setPrevPath] = useState(upload.path);
  if (prevPath !== upload.path) {
    setPrevPath(upload.path);
    setPreviewLoaded(false);
  }

  return (
    <div className="fade-in relative aspect-square overflow-hidden rounded-md bg-foreground/5">
      <div className="absolute inset-0 flex items-center justify-center p-3">
        <span className="max-w-full truncate font-mono text-xs text-foreground/50">
          {upload.filename}
        </span>
      </div>
      {upload.path && (
        <img
          src={previewUrl(upload.path)}
          alt={upload.filename}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-150 ease-out ${
            previewLoaded ? "opacity-100" : "opacity-0"
          }`}
          draggable={false}
          decoding="async"
          onLoad={() => setPreviewLoaded(true)}
        />
      )}

      {failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-red-950/50">
          <span className="text-xs font-medium text-red-100">Failed</span>
          {onDismiss && (
            <button
              type="button"
              onClick={() => onDismiss(upload.key)}
              className="rounded-md bg-background/80 px-2 py-1 text-xs text-foreground/70 transition-colors hover:text-foreground"
            >
              Dismiss
            </button>
          )}
        </div>
      ) : upload.status === "cancelling" ? (
        <span className="absolute left-2 top-2 rounded bg-background/70 px-1.5 py-0.5 text-[11px] font-medium text-foreground/70">
          Cancelling…
        </span>
      ) : upload.status === "done" ? (
        <span className="absolute left-2 top-2 rounded bg-background/70 px-1.5 py-0.5 text-[11px] font-medium text-foreground/70">
          Processing…
        </span>
      ) : (
        <>
          <span className="absolute left-2 top-2 rounded bg-background/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-foreground/70">
            {upload.progress}%
          </span>
          {onCancel && (
            <button
              type="button"
              onClick={() => onCancel(upload.key)}
              className="absolute right-2 top-2 rounded bg-background/70 px-1.5 py-0.5 text-[11px] font-medium text-foreground/70 transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          )}
          <div className="absolute inset-x-0 bottom-0 h-1 bg-foreground/10">
            <div
              className="h-full bg-accent transition-[width] duration-200 ease-linear"
              style={{ width: `${upload.progress}%` }}
            />
          </div>
        </>
      )}
    </div>
  );
}
