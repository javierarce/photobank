import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
  memo,
  type DragEvent,
  type MouseEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { imageUrl, previewUrl } from "@/lib/image-url";
import { message } from "@tauri-apps/plugin-dialog";
import {
  addPhotosToCollection,
  listCollections,
  listPhotos,
  searchPhotoIds,
  REFRESH_PROGRESS_EVENT,
  type RefreshProgress,
} from "@/lib/api";
import { usesMetadataFilter } from "@/lib/search-query";
import { PhotoLightbox } from "@/components/photo-lightbox";
import { BulkTagDialog } from "@/components/bulk-tag-dialog";
import { CollectionCard } from "@/components/collection-card";
import { CollectionDialog } from "@/components/collection-dialog";
import { SelectionCheck } from "@/components/selection-check";
import { PhotoContextMenu } from "@/components/photo-context-menu";
import { Thumbnail } from "@/components/thumbnail";
import { usePhotoActions } from "@/hooks/use-photo-actions";
import {
  useSelection,
  useThumbnailActivation,
  useThumbnailContextMenu,
} from "@/hooks/use-selection";
import { useGridNavigation } from "@/hooks/use-grid-navigation";
import { usePresence, type PresenceState } from "@/hooks/use-presence";
import {
  collectionCover,
  loosePhotos,
  membershipMap,
  photosInCollection,
} from "@/lib/collections";
import { sortPhotos, DEFAULT_SORT_MODE, type SortMode } from "@/lib/photo-sort";
import type { Collection, Photo } from "@/lib/types";
import type { DragTracker, UploadFile } from "@/hooks/use-upload";

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
  /** Show one collection's photos instead of the folder's own: the collection
   * page. Its card is not drawn (you're inside it) and nothing else in the
   * folder shows. */
  collectionId?: string;
  /** Opens a collection card. Omitted on the collection page, which draws no
   * cards. */
  onOpenCollection?: (collection: Collection) => void;
  /** Follows a drag of the tiles so they can be dropped on a collection card;
   * comes from the upload provider, which owns the native drag events (see
   * DragTracker). Without it the tiles simply aren't draggable. */
  registerDragTracker?: (tracker: DragTracker) => () => void;
  /** Fires whenever the grid reloads the folder's collections, so a page
   * showing one of them (the collection page) can pick up the change. Must be
   * stable across renders. */
  onCollectionsChange?: () => void;
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
    collectionId,
    onOpenCollection,
    registerDragTracker,
    onCollectionsChange,
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
  // Same, for the "add to collection" dialog.
  const [collectTargets, setCollectTargets] = useState<Photo[] | null>(null);
  // The folder's collections, newest first — each one draws a card ahead of
  // the folder's own photos, and holds its photos out of that grid.
  const [collections, setCollections] = useState<Collection[]>([]);

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
  const { menu, onContextMenu, closeMenu } = useThumbnailContextMenu();
  const gridRef = useRef<HTMLDivElement>(null);

  // Keep showing the local preview while the photo is pending/processing —
  // the real tile has nothing to render until the worker finishes. Hand off
  // only once the 640px variant has actually loaded (preloaded below), so the
  // preview is never replaced by a blank tile.
  const photoById = useMemo(
    () => new Map(photos.map((p) => [p.id, p])),
    [photos]
  );
  // An upload that has settled into `error` over a `failed` row hands its error
  // off to the photo tile (dismissed by the effect below). Any other upload
  // keeps its tile, whatever the row says: re-dropping a file that failed
  // retries it in place — the importer reuses that same failed row — and our
  // copy of the row keeps reading "failed" until the batch's refresh lands,
  // well after the retry has finalized it to `completed` and reported done.
  // Only the error path ever writes `failed` mid-session, so a live upload over
  // a failed row is always stale data, never news.
  const activeUploads = useMemo(
    () =>
      uploads.filter(
        (u) =>
          u.status !== "error" ||
          !u.id ||
          photoById.get(u.id)?.processingStatus !== "failed"
      ),
    [uploads, photoById]
  );
  const activeUploadIds = useMemo(
    () => new Set(activeUploads.map((u) => u.id)),
    [activeUploads]
  );
  // A retry only learns the reused row's id once the importer reserves it, so
  // match by name too — otherwise that row's stale "Failed" tile sits on screen
  // beside the upload tile that has taken over its slot.
  const coveredKeys = useMemo(
    () => new Set(activeUploads.map((u) => u.key)),
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
  const activeUploadKey = `${[...activeUploadIds].join(",")}|${[...coveredKeys].join(",")}`;
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

  const matchingPhotos = useMemo(
    () =>
      sortedPhotos.filter(
        (p) =>
          !activeUploadIds.has(p.id) &&
          !(
            p.processingStatus === "failed" &&
            coveredKeys.has(`${p.folder}/${p.filename}`)
          ) &&
          (!trimmedQuery || search === null || search.ids.has(p.id))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortedPhotos, activeUploadKey, trimmedQuery, search]
  );

  // A collection holds its photos the way a folder does: on the folder page
  // they're inside their card, not loose in the grid; on a collection page
  // they're all there is.
  const collection = collectionId
    ? collections.find((c) => c.id === collectionId)
    : undefined;
  const visiblePhotos = useMemo(() => {
    // Inside a collection, a search narrows what's in there.
    if (collectionId) {
      return collection ? photosInCollection(matchingPhotos, collection) : [];
    }
    // In the folder, a search reaches into its collections: holding their
    // photos back is right for browsing, but it would make a filed photo
    // unfindable — the backend matches it and the folder would drop it on the
    // floor. So a query flattens the view; the cards step aside with it (their
    // counts speak for the whole collection, not the search).
    if (trimmedQuery) return matchingPhotos;
    return loosePhotos(matchingPhotos, collections);
  }, [matchingPhotos, collections, collection, collectionId, trimmedQuery]);

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
    // The lightbox, the dialogs and an open context menu each own the
    // keyboard while they're up.
    enabled: !active && !tagTargets && !collectTargets && !menu,
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
      // Collections are folder-scoped, so only this grid offers the action;
      // the search results leave it unset and the toolbar hides the button.
      onCollect: (targets) => setCollectTargets(targets),
    });
    return () => setActions(null);
  }, [setActions, handleBulkDelete, handleBulkMove, clear]);

  // Publish the selectable pool in displayed order so "Select all" and
  // shift-click range selection span the tiles the user actually sees.
  useEffect(() => {
    setPool(visiblePhotos);
    return () => setPool([]);
  }, [visiblePhotos, setPool]);

  // Confine the selection to what's on screen: otherwise the toolbar would
  // count photos the user can't see and a bulk delete would destroy them. A
  // search hides tiles, and so does filing photos into a collection — they
  // move inside its card — so this guards both. While a search is catching up
  // with what's typed it holds off, so the in-flight window doesn't drop
  // photos the new query will keep.
  useEffect(() => {
    if (trimmedQuery && !searchSettled) return;
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
      // The lightbox, the dialogs and an open context menu own the keyboard
      // while they're up. The menu especially: Cmd+A underneath it would leave
      // it acting on one photo while the whole folder highlights, and T (or C)
      // would open an editor beneath a menu that's still on top.
      if (active || tagTargets || collectTargets || menu) return;
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
      // C files the selection into a collection — the keyboard twin of the
      // toolbar's Collect and of dragging the tiles onto a card.
      if (
        (e.key === "c" || e.key === "C") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        selected.length
      ) {
        if (inField) return;
        e.preventDefault();
        setCollectTargets(selected);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    selected,
    active,
    tagTargets,
    collectTargets,
    menu,
    clear,
    selectAll,
    visiblePhotos,
  ]);

  // Picks up a membership change on its own — filing photos moves them between
  // the cards and the grid without touching a photo row. Everything that
  // changes the ROWS (an import, a delete, a move out of the folder) goes
  // through loadPhotos below instead, which reloads both together. Failures
  // are quiet here for the same reason they are there.
  const loadCollections = useCallback(() => {
    return listCollections(folder)
      .then((loaded) => {
        setCollections(loaded);
        onCollectionsChange?.();
      })
      .catch(() => {});
  }, [folder, onCollectionsChange]);

  // Which photos are loose in the folder is a fact about the collections, so
  // the two are fetched together and applied in ONE update. Applying them as
  // they arrive would paint a frame with the photos but not the cards (they're
  // independent IPC calls, in no guaranteed order) — flashing a collection's
  // members loose in the folder grid, or "nothing in here yet" on a collection
  // page, before the other call corrected it.
  const loadPhotos = useCallback(() => {
    return Promise.all([
      // A collections failure is quiet: the photos are what the page is for,
      // and they have their own error state. null means "keep what we have".
      listCollections(folder).catch(() => null),
      listPhotos(folder),
    ])
      .then(([loaded, photos]) => {
        if (loaded) {
          setCollections(loaded);
          onCollectionsChange?.();
        }
        setPhotos(photos);
        setError(null);
      })
      .catch(() => setError("Failed to load photos."))
      .finally(() => setLoading(false));
  }, [folder, setPhotos, onCollectionsChange]);

  useEffect(() => {
    loadPhotos();
  }, [loadPhotos]);

  // --- Dragging photos onto a collection card ---
  //
  // The tiles start a normal HTML5 drag, but nothing downstream of that is
  // normal: wry claims every drag over the webview for Tauri and never lets
  // WebKit run its own dragover/drop, so the card under the cursor has to be
  // found by hit-testing the native positions the provider forwards here (see
  // DragTracker in use-upload). The dragged ids ride in a ref for the same
  // reason — there's no DOM drop event to read a payload from.
  const dragIdsRef = useRef<string[]>([]);
  const [dragging, setDragging] = useState(false);
  // The card under the cursor mid-drag.
  const [dropCollection, setDropCollection] = useState<string | null>(null);
  // Read through refs so the tile handlers below keep a stable identity (the
  // tiles are memoized on them) and the tracker sees fresh data without
  // re-registering mid-drag.
  const selectedRef = useRef(selected);
  const collectionsRef = useRef(collections);
  useEffect(() => {
    selectedRef.current = selected;
    collectionsRef.current = collections;
  }, [selected, collections]);

  const handleDragStart = useCallback((e: DragEvent, photo: Photo) => {
    // Dragging one of several selected photos takes the whole selection,
    // Finder-style; dragging an unselected tile takes just that photo and
    // leaves the selection alone (a drag fires no click).
    const current = selectedRef.current;
    const ids = current.some((p) => p.id === photo.id)
      ? current.map((p) => p.id)
      : [photo.id];
    dragIdsRef.current = ids;
    setDragging(true);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Nothing reads this back — it's here so the webview treats the gesture
      // as a real drag with a payload.
      e.dataTransfer.setData?.("text/plain", ids.join(","));
    }
  }, []);

  const handleDragEnd = useCallback(() => {
    dragIdsRef.current = [];
    setDragging(false);
    setDropCollection(null);
  }, []);

  /** File the dragged photos into `id`'s collection. A drop onto the
   * collection they're already in is skipped rather than round-tripped. */
  const fileIntoCollection = useCallback(
    (id: string) => {
      const ids = dragIdsRef.current;
      handleDragEnd();
      if (!ids.length) return;
      const membership = membershipMap(collectionsRef.current);
      if (ids.every((photoId) => membership.get(photoId)?.id === id)) return;

      void addPhotosToCollection(id, ids)
        .then(loadCollections)
        .catch(async (err) => {
          await loadCollections();
          // The webview has no working window.alert; the native dialog is how
          // the app reports a failure it can't show inline.
          await message(
            typeof err === "string" ? err : "Failed to move those photos",
            { title: "Collection", kind: "error" }
          );
        });
    },
    [loadCollections, handleDragEnd]
  );

  /** The collection card under a native cursor position, hit-tested through
   * the DOM exactly as the importer resolves a folder card (folderAtPoint). */
  const cardAtPoint = (position: { x: number; y: number } | null) => {
    if (!position) return null;
    const el = document.elementFromPoint(position.x, position.y);
    return (
      el?.closest<HTMLElement>("[data-drop-collection]")?.dataset
        .dropCollection ?? null
    );
  };

  useEffect(() => {
    if (!registerDragTracker) return;
    return registerDragTracker({
      onMove: (position) => setDropCollection(cardAtPoint(position)),
      onDrop: (position) => {
        const id = cardAtPoint(position);
        if (id) fileIntoCollection(id);
        else handleDragEnd();
      },
    });
  }, [registerDragTracker, fileIntoCollection, handleDragEnd]);

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

  // The cards drawn ahead of the tiles, each with the newest photo it can
  // show. Only on the folder page (inside a collection there's nothing left to
  // nest) and only while browsing — see visiblePhotos on why a search flattens
  // the view.
  const cards = collectionId || trimmedQuery ? [] : collections;

  // Failed processing hands off to the photo tile, which owns the error state.
  // Only when this upload is the one that failed, though: a retry reuses the
  // failed row, so dismissing on the row alone would drop a live import out of
  // the upload list entirely — no tile, no Cancel button — leaving the previous
  // attempt's "Failed" tile in its place until the refresh lands.
  useEffect(() => {
    if (!onDismissUpload) return;
    for (const u of uploads) {
      if (!u.id || u.status !== "error") continue;
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

  // Nothing in the folder at all — not even a collection to show a card for.
  if (!photos.length && !activeUploads.length && !cards.length) {
    return (
      <p className="text-sm text-foreground/60">No photos in this folder.</p>
    );
  }

  // The folder has photos; this collection just doesn't hold any yet.
  if (
    collectionId &&
    !trimmedQuery &&
    !visiblePhotos.length &&
    !activeUploads.length
  ) {
    return (
      <p className="text-sm text-foreground/60">
        No photos in this collection yet. Drag photos onto its card to add
        them.
      </p>
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
    !tagTargets &&
    !collectTargets
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
      {/* Collections lead the grid, the way folders sit above files in a file
          manager; the folder's own photos follow. Inside a collection there
          are no cards, so this is the plain grid it has always been. */}
      <div
        ref={gridRef}
        className="fade-in grid select-none gap-2 grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))]"
      >
        {cards.map((c) => (
          <CollectionCard
            key={c.id}
            collection={c}
            cover={collectionCover(c, photoById)}
            isDragging={dragging}
            isDropTarget={dropCollection === c.id}
            onOpen={(opened) => onOpenCollection?.(opened)}
          />
        ))}
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
            // Tiles are only draggable where there's a card to drop them on —
            // which rules out a folder with no collections, and a search,
            // whose flattened view draws no cards.
            draggable={!!registerDragTracker && !!cards.length}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
        ))}
      </div>

      {menu && (
        <PhotoContextMenu
          photos={menu.photos}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
        />
      )}

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

      {collectTargets && (
        <CollectionDialog
          photos={collectTargets}
          folder={folder}
          collections={collections}
          onClose={() => setCollectTargets(null)}
          // Unlike a tag edit, filing photos takes them off this grid — they
          // live inside the card now — so there's nothing left to keep
          // selected. (The retain effect above would prune them anyway once
          // the reload lands; clearing says so immediately.)
          onApplied={() => {
            setCollectTargets(null);
            clear();
            void loadCollections();
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
  draggable,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: {
  photo: Photo;
  presenceState: PresenceState;
  selected: boolean;
  /** Whether to show the corner check — only while several photos are
   * selected; a single selection is marked by the border alone. */
  showCheck: boolean;
  /** Whether the tile can be picked up (there's a collection to drop it on). */
  draggable: boolean;
  onClick: (e: MouseEvent, photo: Photo) => void;
  onDoubleClick: (photo: Photo) => void;
  onContextMenu: (e: MouseEvent, photo: Photo) => void;
  /** Picks the tile up to drop on a collection card. */
  onDragStart: (e: DragEvent, photo: Photo) => void;
  onDragEnd: () => void;
}) {
  return (
    <button
      // The keyboard cursor is this button's own focus; its highlight lives in
      // globals.css under [data-nav-id]:focus-visible.
      data-nav-id={photo.id}
      data-presence={presenceState}
      // Tiles are dragged onto a collection card to file them. Only the
      // gesture's start is a DOM event: the webview hands the rest to Tauri
      // (see the drag tracker in the grid above).
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, photo)}
      onDragEnd={onDragEnd}
      onClick={(e) => onClick(e, photo)}
      onDoubleClick={() => onDoubleClick(photo)}
      onContextMenu={(e) => onContextMenu(e, photo)}
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
