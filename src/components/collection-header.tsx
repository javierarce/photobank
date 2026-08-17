import { useEffect, useRef, useState } from "react";
import { deleteCollection, renameCollection } from "@/lib/api";
import type { Collection } from "@/lib/types";

/**
 * The second half of the collection page's breadcrumb (the page renders the
 * folder and the slash to its left): the collection's own name, which turns
 * into an inline rename on click — the same interaction as the folder title
 * and the lightbox's filename. The ⋯ menu holds Rename and Ungroup — that's
 * what keeps Ungroup out of harm's way, one deliberate trip through a menu
 * that says what it will do rather than a button sitting next to the photos.
 */
export function CollectionHeader({
  collection,
  onRenamed,
  onUngrouped,
}: {
  collection: Collection;
  /** The collection after a successful rename. */
  onRenamed: (collection: Collection) => void;
  /** Dissolved — the caller decides where to go (back to the folder). */
  onUngrouped: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(collection.title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Adjust-during-render (no extra effect pass) so a title changed elsewhere
  // starts the draft from the right text.
  const [prevTitle, setPrevTitle] = useState(collection.title);
  if (prevTitle !== collection.title) {
    setPrevTitle(collection.title);
    setValue(collection.title);
    setError(null);
  }

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = async () => {
    const trimmed = value.trim();
    setEditing(false);
    if (!trimmed || trimmed === collection.title) {
      setValue(collection.title);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      onRenamed(await renameCollection(collection.id, trimmed));
    } catch (err) {
      setValue(collection.title);
      // Tauri commands reject with a plain message string (see src/lib/api.ts)
      setError(typeof err === "string" ? err : "Failed to rename collection");
    } finally {
      setBusy(false);
    }
  };

  const ungroup = async () => {
    setError(null);
    setBusy(true);
    try {
      await deleteCollection(collection.id);
      onUngrouped();
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to ungroup");
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      {editing ? (
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              setValue(collection.title);
              setEditing(false);
            }
          }}
          onBlur={commit}
          aria-label="Collection title"
          className="min-w-0 flex-1 rounded border border-border bg-transparent px-1 py-0.5 text-xl font-semibold text-foreground outline-none focus:border-foreground/30"
          data-testid="collection-title-input"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Rename collection"
          className="min-w-0 truncate rounded text-left text-xl font-semibold text-foreground transition-colors hover:text-foreground/70"
          data-testid="collection-title"
        >
          {collection.title}
        </button>
      )}
      <CollectionMenu
        title={collection.title}
        busy={busy}
        onRename={() => setEditing(true)}
        onUngroup={ungroup}
      />
      {error && (
        <span
          className="truncate text-xs text-red-600 dark:text-red-400"
          data-testid="collection-error"
        >
          {error}
        </span>
      )}
    </div>
  );
}

/** The ⋯ menu. Modeled on ExportButton's popover: outside-click and a
 * capture-phase Escape close it, so Escape here doesn't also clear the
 * selection or close the lightbox. */
function CollectionMenu({
  title,
  busy,
  onRename,
  onUngroup,
}: {
  title: string;
  busy: boolean;
  onRename: () => void;
  onUngroup: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${title}`}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        className="rounded-md px-1.5 py-0.5 text-base leading-none text-foreground/50 transition-colors hover:text-foreground disabled:opacity-50"
        data-testid="collection-menu"
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-10 mt-1 min-w-48 overflow-hidden rounded-md border border-border bg-background shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onRename)}
            className="flex w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-foreground/5"
            data-testid="collection-rename"
          >
            Rename…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onUngroup)}
            // Spelled out rather than left as a bare verb: the one thing worth
            // knowing before ungrouping is that the photos survive it.
            className="flex w-full flex-col items-start px-3 py-1.5 text-left text-sm transition-colors hover:bg-foreground/5"
            data-testid="collection-ungroup"
          >
            <span>Ungroup</span>
            <span className="text-xs text-foreground/50">
              Photos stay in the folder
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
