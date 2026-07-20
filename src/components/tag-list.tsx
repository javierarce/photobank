import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ask } from "@tauri-apps/plugin-dialog";
import { deleteTag, listTagCounts, renameTag } from "@/lib/api";
import { tagQuery } from "@/lib/search-query";
import type { TagCount } from "@/lib/types";

type SortMode = "name" | "count";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "count", label: "Photos" },
];

/** Close a popover on an outside click or Escape (capture phase, so Escape
 * dismisses only the popover and doesn't bubble to other handlers). */
function useDismiss(
  open: boolean,
  close: () => void,
  ref: React.RefObject<HTMLElement | null>
) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close, ref]);
}

/**
 * The Tags page: every tag with its photo count, filterable and sortable. A tag
 * name links to its photos (the search-by-tag view); a per-row menu renames
 * (renaming onto an existing tag merges them) or deletes it.
 */
export function TagList() {
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortMode>("name");

  const load = () => {
    return listTagCounts()
      .then((t) => {
        setTags(t);
        setError(null);
      })
      .catch(() => setError("Failed to load tags."))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const handleRename = async (tag: TagCount, name: string) => {
    const trimmed = name.trim();
    setEditingId(null);
    if (!trimmed || trimmed === tag.name) return;
    try {
      await renameTag(tag.id, trimmed);
      await load();
    } catch {
      // Rename failed; leave the list as it was.
    }
  };

  const handleDelete = async (tag: TagCount) => {
    const ok = await ask(
      `Delete the tag "${tag.name}"? It will be removed from ${tag.count} ${
        tag.count === 1 ? "photo" : "photos"
      }. The photos are kept.`,
      { title: "Delete tag", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" }
    );
    if (!ok) return;
    // Drop it immediately; the photos are untouched.
    setTags((prev) => prev.filter((t) => t.id !== tag.id));
    try {
      await deleteTag(tag.id);
    } catch {
      // Restore on failure by reloading the authoritative list.
      load();
    }
  };

  if (loading) {
    return <p className="text-sm text-foreground/60">Loading tags...</p>;
  }

  if (error) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  if (!tags.length) {
    return (
      <p className="text-sm text-foreground/60">
        No tags yet. Select photos and use Tag to create some.
      </p>
    );
  }

  const query = filter.trim().toLowerCase();
  const visible = tags
    .filter((t) => !query || t.name.toLowerCase().includes(query))
    .sort((a, b) =>
      sort === "count"
        ? b.count - a.count || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name)
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search tags..."
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 outline-none focus:border-foreground/30"
        />
        <SortDropdown value={sort} onChange={setSort} />
      </div>
      {visible.length === 0 ? (
        <p className="text-sm text-foreground/60">No tags match “{filter.trim()}”.</p>
      ) : (
        <ul className="fade-in divide-y divide-border overflow-hidden rounded-lg border border-border">
          {visible.map((tag) => (
            <li key={tag.id}>
              {editingId === tag.id ? (
                <TagRenameRow
                  tag={tag}
                  onCommit={(name) => handleRename(tag, name)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div className="flex items-center gap-3 px-3 py-2.5">
                  {/* Only tags actually on photos link to a (non-empty) result
                      set; an empty tag is plain text. */}
                  {tag.count > 0 ? (
                    <Link
                      to={`/search?q=${encodeURIComponent(tagQuery(tag.name))}`}
                      className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                    >
                      {tag.name}
                    </Link>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/50">
                      {tag.name}
                    </span>
                  )}
                  <span className="shrink-0 text-xs tabular-nums text-foreground/40">
                    {tag.count} {tag.count === 1 ? "photo" : "photos"}
                  </span>
                  <TagRowMenu
                    tag={tag}
                    onRename={() => setEditingId(tag.id)}
                    onDelete={() => handleDelete(tag)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Name/Photos sort selector, modeled on the folder SortDropdown. */
function SortDropdown({
  value,
  onChange,
}: {
  value: SortMode;
  onChange: (mode: SortMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  const current = SORT_OPTIONS.find((o) => o.value === value) ?? SORT_OPTIONS[0];

  return (
    <div ref={ref} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Sort tags"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground/70 transition-colors hover:border-foreground/35 hover:text-foreground"
      >
        <span>{current.label}</span>
        <svg
          className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 min-w-40 overflow-hidden rounded-md border border-border bg-background shadow-lg"
        >
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="menuitemradio"
              aria-checked={opt.value === value}
              onClick={() => {
                setOpen(false);
                onChange(opt.value);
              }}
              className="flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-sm transition-colors hover:bg-foreground/5"
            >
              <span>{opt.label}</span>
              {opt.value === value && (
                <svg
                  className="h-4 w-4 text-accent"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Per-row "⋯" menu holding the Rename and Delete actions. */
function TagRowMenu({
  tag,
  onRename,
  onDelete,
}: {
  tag: TagCount;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${tag.name}`}
        onClick={() => setOpen((v) => !v)}
        className="flex size-7 items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 min-w-36 overflow-hidden rounded-md border border-border bg-background shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
            className="block w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-foreground/5"
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="block w-full px-3 py-1.5 text-left text-sm text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function TagRenameRow({
  tag,
  onCommit,
  onCancel,
}: {
  tag: TagCount;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(tag.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(value);
          else if (e.key === "Escape") onCancel();
        }}
        // A click away cancels rather than committing, so an accidental blur
        // never renames (and possibly merges) a tag behind the user's back.
        onBlur={onCancel}
        aria-label={`Rename tag ${tag.name}`}
        className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-sm text-foreground outline-none focus:border-foreground/30"
      />
      <button
        type="button"
        // mousedown so it beats the input's blur-cancel and still commits.
        onMouseDown={(e) => {
          e.preventDefault();
          onCommit(value);
        }}
        className="shrink-0 rounded-md px-2 py-1 text-xs text-foreground/50 transition-colors hover:text-foreground"
      >
        Save
      </button>
    </div>
  );
}
