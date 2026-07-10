import { useEffect, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { Link } from "react-router-dom";
import { listFolders } from "@/lib/api";
import type { FolderCount } from "@/lib/types";

export type FolderListRef = {
  refresh: () => void;
};

export const FolderList = forwardRef<FolderListRef>(function FolderList(_, ref) {
  const [folders, setFolders] = useState<FolderCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  useImperativeHandle(ref, () => ({ refresh: loadFolders }));

  if (loading) {
    return <p className="text-sm text-foreground/60">Loading folders...</p>;
  }

  if (error) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  if (!folders.length) {
    return <p className="text-sm text-foreground/60">No folders yet. Upload some photos to get started.</p>;
  }

  return (
    <div className="fade-in grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {folders.map((f) => (
        <Link
          key={f.folder}
          to={`/folders/${encodeURIComponent(f.folder)}`}
          className="group flex flex-col gap-1 rounded-lg border border-border p-4 transition-colors hover:border-foreground/35"
        >
          <span className="text-sm font-medium text-foreground group-hover:underline">
            {f.folder}
          </span>
          <span className="text-xs tabular-nums text-foreground/50">
            {f.count} {f.count === 1 ? "photo" : "photos"}
          </span>
        </Link>
      ))}
    </div>
  );
});
