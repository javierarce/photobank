import { useEffect, useState, useCallback, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listFolders } from "@/lib/api";
import { useUpload, type UploadFile } from "@/hooks/use-upload";
import type { FolderCount } from "@/lib/types";

export function FolderList() {
  const [folders, setFolders] = useState<FolderCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { files, isDragging, dropFolder, clearCompleted, onUploadComplete } =
    useUpload();

  const loadFolders = useCallback(() => {
    listFolders()
      .then((folders) => {
        setFolders(folders);
        setError(null);
      })
      .catch(() => setError("Failed to load folders."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

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
      <div className="fade-in grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <NewFolderCard existing={folders.map((f) => f.folder)} />
        {folders.map((f) => (
          <FolderCard
            key={f.folder}
            folder={f}
            uploads={files.filter((u) => u.folder === f.folder)}
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

// A folder is just the `folder` field on its photos — there's no empty-folder
// record to create. So "new folder" names a destination and drops the user on
// its (empty) page, where the first upload materializes it in the listing.
function NewFolderCard({ existing }: { existing: string[] }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const cancel = () => {
    setEditing(false);
    setValue("");
  };

  const commit = () => {
    // A slash would fracture the folder/filename key scheme, so fold it away.
    const name = value.trim().replace(/\/+/g, " ").replace(/\s+/g, " ").trim();
    if (!name) {
      cancel();
      return;
    }
    // Reuse the exact casing of an existing folder so we open it rather than
    // spawn a case-variant sibling.
    const match = existing.find((f) => f.toLowerCase() === name.toLowerCase());
    navigate(`/folders/${encodeURIComponent(match ?? name)}`);
  };

  if (editing) {
    return (
      <div className="flex flex-col justify-center rounded-lg border border-accent bg-accent/5 p-4">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
          }}
          // Navigating into a new folder is a heavier side effect than the
          // rename input's in-place commit, so a stray click-away just dismisses
          // the field — only Enter takes you there.
          onBlur={cancel}
          placeholder="Folder name"
          aria-label="New folder name"
          className="min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-sm font-medium text-foreground outline-none focus:border-foreground/30"
          data-testid="new-folder-input"
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border p-4 text-sm font-medium text-foreground/60 transition-colors hover:border-foreground/35 hover:text-foreground active:scale-[0.99]"
      data-testid="new-folder-card"
    >
      <span aria-hidden>+</span>
      New folder
    </button>
  );
}

function FolderCard({
  folder,
  uploads,
  isDragging,
  isDropTarget,
}: {
  folder: FolderCount;
  uploads: UploadFile[];
  isDragging: boolean;
  isDropTarget: boolean;
}) {
  const inFlight = uploads.filter((u) => u.status !== "error");
  const failed = uploads.length - inFlight.length;
  const progress = inFlight.length
    ? Math.round(inFlight.reduce((sum, u) => sum + u.progress, 0) / inFlight.length)
    : 0;

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
      className={`relative flex flex-col gap-1 overflow-hidden rounded-lg border p-4 transition-colors ${border}`}
    >
      <span className="text-sm font-medium text-foreground">
        {folder.folder}
      </span>
      {inFlight.length > 0 ? (
        <span className="text-xs tabular-nums text-accent">
          Uploading {inFlight.length} image{inFlight.length > 1 ? "s" : ""}…
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

      {inFlight.length > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-foreground/10">
          <div
            className="h-full bg-accent transition-[width] duration-200 ease-linear"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </Link>
  );
}
