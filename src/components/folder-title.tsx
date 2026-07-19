import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { renameFolder } from "@/lib/api";

/**
 * The folder page's title, which turns into an inline rename input while
 * `editing` (same interaction as the lightbox's filename rename: focus +
 * select on entry, Enter commits, Escape cancels, blur commits). A successful
 * rename navigates to the folder's new URL; failures surface inline.
 */
export function FolderTitle({
  folder,
  editing,
  onEditingChange,
  onRenamingChange,
}: {
  folder: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** Fires with true while the backend rename is in flight, so the page can
   * lock out folder mutations (uploads, drops) that would race it. */
  onRenamingChange?: (renaming: boolean) => void;
}) {
  const [value, setValue] = useState(folder);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Reset the draft when navigation lands on a different folder (including
  // right after a successful rename) — the adjust-during-render pattern, so
  // no extra effect pass is needed.
  const [prevFolder, setPrevFolder] = useState(folder);
  if (prevFolder !== folder) {
    setPrevFolder(folder);
    setValue(folder);
    setError(null);
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = async () => {
    const trimmed = value.trim();
    onEditingChange(false);
    if (!trimmed || trimmed === folder) {
      setValue(folder);
      return;
    }

    setError(null);
    setRenaming(true);
    onRenamingChange?.(true);
    try {
      await renameFolder(folder, trimmed);
      // The folder name is the URL; replace so Back doesn't lead to the
      // now-empty old name
      navigate(`/folders/${encodeURIComponent(trimmed)}`, { replace: true });
    } catch (err) {
      setValue(folder);
      // Tauri commands reject with a plain message string (see src/lib/api.ts)
      setError(typeof err === "string" ? err : "Failed to rename folder");
    } finally {
      setRenaming(false);
      onRenamingChange?.(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setValue(folder);
            onEditingChange(false);
          }
        }}
        onBlur={commit}
        className="min-w-0 flex-1 rounded border border-border bg-transparent px-1 py-0.5 text-xl font-semibold text-foreground outline-none focus:border-foreground/30"
        data-testid="folder-title-input"
      />
    );
  }

  return (
    <div className="min-w-0">
      <h1
        className="truncate text-xl font-semibold text-foreground"
        data-testid="folder-title"
      >
        {folder}
        {renaming && (
          <span className="ml-2 text-sm font-normal text-foreground/50">
            Renaming…
          </span>
        )}
      </h1>
      {error && (
        <p
          className="mt-0.5 text-xs text-red-600 dark:text-red-400"
          data-testid="folder-rename-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}
