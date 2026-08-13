import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listFolders } from "@/lib/api";
import {
  DEFAULT_FOLDER_SORT_MODE,
  sortFolders,
  type FolderSortMode,
} from "@/lib/folder-sort";
import { ThumbnailImage } from "@/components/thumbnail";
import { ThumbnailFallback } from "@/components/thumbnail-fallback";
import { useUpload } from "@/hooks/use-upload";
import type { UploadSummary } from "@/lib/upload-progress";
import { useGridNavigation } from "@/hooks/use-grid-navigation";
import type { FolderCount } from "@/lib/types";

export function FolderList({
  /** The order to show the cards in; owned by the home page, which renders the
   * sort control next to the heading. */
  sort = DEFAULT_FOLDER_SORT_MODE,
  /** Reports the loaded folder names, which the header's New folder button
   * matches a typed name against. */
  onFoldersLoaded,
}: {
  sort?: FolderSortMode;
  onFoldersLoaded?: (names: string[]) => void;
} = {}) {
  const [loaded, setLoaded] = useState<FolderCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { isDragging, dropFolder, summarize, clearCompleted, onUploadComplete } =
    useUpload();
  const navigate = useNavigate();
  const gridRef = useRef<HTMLDivElement>(null);

  // The cards, in the chosen order — the keyboard cursor walks this same list,
  // so its index always names the card it lands on.
  const folders = useMemo(() => sortFolders(loaded, sort), [loaded, sort]);

  // Keyboard cursor over the folder cards: arrows/hjkl move DOM focus between
  // cards (highlight = their :focus-visible style, shared with Tab) and Enter
  // opens the focused folder. Folders have no selection, so there's no `x`.
  // Read folders through a ref to keep the id lookup stable across reloads.
  const foldersRef = useRef(folders);
  useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);
  const navGetId = useCallback(
    (i: number) => foldersRef.current[i]?.folder,
    []
  );
  useGridNavigation({
    count: folders.length,
    getId: navGetId,
    containerRef: gridRef,
    onOpen: (i) => {
      const folder = foldersRef.current[i];
      if (folder) navigate(`/folders/${encodeURIComponent(folder.folder)}`);
    },
  });

  const loadFolders = useCallback(() => {
    listFolders()
      .then((folders) => {
        setLoaded(folders);
        setError(null);
      })
      .catch(() => setError("Failed to load folders."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    onFoldersLoaded?.(loaded.map((f) => f.folder));
  }, [loaded, onFoldersLoaded]);

  // Once an import batch settles, pick up the new counts and drop the finished
  // upload tiles so the card returns to its resting photo count.
  useEffect(() => {
    return onUploadComplete(() => {
      loadFolders();
      clearCompleted();
    });
  }, [onUploadComplete, loadFolders, clearCompleted]);

  if (loading) {
    return <p className="text-sm text-foreground/60">Loading folders...</p>;
  }

  if (error) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  return (
    <>
      <div
        ref={gridRef}
        className="fade-in grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      >
        {folders.map((f) => (
          <FolderCard
            key={f.folder}
            folder={f}
            uploads={summarize(f.folder)}
            isDragging={isDragging}
            isDropTarget={dropFolder === f.folder}
          />
        ))}
      </div>
      {!folders.length && (
        <p className="mt-3 text-sm text-foreground/60">
          No folders yet. Create one, or upload some photos to get started.
        </p>
      )}
    </>
  );
}

function FolderCard({
  folder,
  uploads,
  isDragging,
  isDropTarget,
}: {
  folder: FolderCount;
  /** This folder's import batch, if one is running. */
  uploads: UploadSummary;
  isDragging: boolean;
  isDropTarget: boolean;
}) {
  const { total, completed, percent, failed } = uploads;

  // While a drag is in progress, every card advertises itself as droppable; the
  // one under the cursor lights up so the target is unmistakable.
  const border = isDropTarget
    ? "border-accent bg-accent/5"
    : isDragging
      ? "border-dashed border-foreground/30"
      : "border-border hover:border-foreground/35";

  return (
    <Link
      to={`/folders/${encodeURIComponent(folder.folder)}`}
      data-drop-folder={folder.folder}
      // Keyboard cursor is this card's focus; highlight in globals.css under
      // [data-nav-id]:focus-visible.
      data-nav-id={folder.folder}
      className={`relative flex flex-col overflow-hidden rounded-lg border transition-colors ${border}`}
    >
      {/* The folder's cover: its chosen photo, else its newest one. A folder
          with nothing displayable yet keeps the same frame with the standard
          placeholder in it, so the cards stay a uniform size. */}
      <div className="relative aspect-[3/2] w-full overflow-hidden bg-foreground/[0.04] dark:bg-foreground/5">
        {folder.coverKey ? (
          <ThumbnailImage
            s3Key={folder.coverKey}
            version={folder.coverVersion ?? ""}
            alt=""
          />
        ) : (
          <ThumbnailFallback />
        )}
      </div>
      <div className="flex flex-col gap-1 p-3">
        <span className="truncate text-sm font-medium text-foreground">
          {folder.folder}
        </span>
        {total > 0 ? (
          <span className="text-xs tabular-nums text-accent">
            Uploading {completed}/{total} image{total > 1 ? "s" : ""} · {percent}%
          </span>
        ) : failed > 0 ? (
          <span className="text-xs text-red-600 dark:text-red-400">
            {failed} image{failed > 1 ? "s" : ""} failed to upload
          </span>
        ) : (
          <span className="text-xs tabular-nums text-foreground/50">
            {folder.count} {folder.count === 1 ? "photo" : "photos"}
          </span>
        )}
      </div>

      {total > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-foreground/10">
          <div
            className="h-full bg-accent transition-[width] duration-200 ease-linear"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </Link>
  );
}
