import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { listFolders } from "@/lib/api";
import { useTheme } from "@/lib/theme-context";
import type { FolderCount } from "@/lib/types";

// A lightweight command palette, in the spirit of ankitron's. Cmd/Ctrl+K opens
// it; type to filter actions and folders, arrow/Tab to move, Enter to go, Esc
// to close. Photobank has no icon dependency, so rows use small inline SVGs.

type IconProps = { className?: string };
type IconComponent = (props: IconProps) => React.ReactElement;

const HomeIcon: IconComponent = ({ className }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden
  >
    <path d="M2.5 7 8 2.5 13.5 7v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V7Z" />
    <path d="M6 14V9h4v5" />
  </svg>
);

const SearchIcon: IconComponent = ({ className }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden
  >
    <circle cx="7" cy="7" r="4.5" />
    <path d="m11 11 3 3" />
  </svg>
);

const GearIcon: IconComponent = ({ className }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden
  >
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.6 3.4l-1 1M4.4 11.6l-1 1M12.6 12.6l-1-1M4.4 4.4l-1-1" />
  </svg>
);

const FolderIcon: IconComponent = ({ className }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden
  >
    <path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z" />
  </svg>
);

const SunIcon: IconComponent = ({ className }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden
  >
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1M12.9 3.1l-1 1M4.1 11.9l-1 1M12.9 12.9l-1-1M4.1 4.1l-1-1" />
  </svg>
);

const MoonIcon: IconComponent = ({ className }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden
  >
    <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
  </svg>
);

const MonitorIcon: IconComponent = ({ className }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden
  >
    <rect x="1.5" y="2.5" width="13" height="9" rx="1" />
    <path d="M5.5 14h5M8 11.5V14" />
  </svg>
);

const ArrowUpIcon: IconComponent = ({ className }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </svg>
);

const ArrowDownIcon: IconComponent = ({ className }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M8 3v10M4 9l4 4 4-4" />
  </svg>
);

const EnterIcon: IconComponent = ({ className }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M13 4v3a2 2 0 0 1-2 2H3M6 6 3 9l3 3" />
  </svg>
);

type ActionId =
  | "home"
  | "search"
  | "settings"
  | "theme-toggle"
  | "theme-system";

type ActionDef = {
  id: ActionId;
  label: string;
  keywords: string;
  icon: IconComponent;
  // Right-aligned hint shown on the selected row.
  hint: string;
  // Actions with `always: true` stay listed even when they don't match the
  // query, so "Search for …" can carry whatever the user typed.
  always?: boolean;
};

type Item =
  | { kind: "action"; id: ActionId; label: string; icon: IconComponent; hint: string }
  | { kind: "folder"; label: string; folder: string; count: number };

/** Lowercase + strip diacritics so "cafe" matches "Café". */
function foldText(s: string) {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function CommandPalette() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [folders, setFolders] = useState<FolderCount[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setSelected(0);
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const mod = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Route the close path through close() so it resets query/selection
        // the same way Esc, backdrop click, and row activation do.
        if (open) close();
        else setOpen(true);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, close]);

  // Refresh the folder list each time the palette opens so newly-created
  // folders show up without reloading the app.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listFolders()
      .then((f) => {
        if (!cancelled) setFolders(f);
      })
      .catch(() => {
        if (!cancelled) setFolders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const q = foldText(query.trim());

  // Resolve the appearance actually on screen (the ThemeProvider keeps this
  // `dark` class in sync) so the toggle flips to the opposite even when the
  // theme is following the system.
  const isDark = document.documentElement.classList.contains("dark");

  const actions: ActionDef[] = [
    {
      id: "home",
      label: "Home",
      keywords: "home upload folders start",
      icon: HomeIcon,
      hint: "go",
    },
    {
      id: "search",
      label: query.trim() ? `Search for “${query.trim()}”` : "Search…",
      keywords: "search find filter photos tag camera",
      icon: SearchIcon,
      hint: "search",
      always: true,
    },
    {
      id: "settings",
      label: "Settings",
      keywords: "settings preferences s3 bucket account",
      icon: GearIcon,
      hint: "open",
    },
    {
      id: "theme-toggle",
      label: isDark ? "Switch to light theme" : "Switch to dark theme",
      keywords: "theme appearance dark light mode color toggle switch",
      icon: isDark ? SunIcon : MoonIcon,
      hint: "switch",
    },
    {
      id: "theme-system",
      label: "Use system theme",
      keywords: "theme appearance system auto mode color",
      icon: MonitorIcon,
      hint: theme === "system" ? "current" : "switch",
    },
  ];

  const filteredActions = actions.filter(
    (a) =>
      a.always ||
      q === "" ||
      foldText(a.label).includes(q) ||
      a.keywords.includes(q)
  );

  const filteredFolders = q
    ? folders.filter((f) => foldText(f.folder).includes(q))
    : folders;

  const items: Item[] = [
    ...filteredActions.map((a) => ({
      kind: "action" as const,
      id: a.id,
      label: a.label,
      icon: a.icon,
      hint: a.hint,
    })),
    ...filteredFolders.map((f) => ({
      kind: "folder" as const,
      label: f.folder,
      folder: f.folder,
      count: f.count,
    })),
  ];

  // Keep the highlighted row in view and never past the end of the list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${selected}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function activate(index: number) {
    const item = items[index];
    if (!item) return;
    if (item.kind === "action") {
      if (item.id === "home") navigate("/");
      else if (item.id === "settings") navigate("/settings");
      else if (item.id === "theme-toggle") setTheme(isDark ? "light" : "dark");
      else if (item.id === "theme-system") setTheme("system");
      else if (item.id === "search") {
        const term = query.trim();
        if (!term) return; // nothing to search yet — keep the palette open
        navigate(`/search?q=${encodeURIComponent(term)}`);
      }
      close();
      return;
    }
    navigate(`/folders/${encodeURIComponent(item.folder)}`);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Stop the event before it bubbles to the document-level keydown
      // listeners in photo-grid/search-results, whose Escape branch clears the
      // photo selection with no input-target guard. Dismissing the palette
      // shouldn't also wipe an underlying selection.
      e.stopPropagation();
      close();
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="mx-4 w-full max-w-xl overflow-hidden rounded-xl border border-border bg-background shadow-[0_20px_50px_rgba(0,0,0,0.25)]">
        <div className="flex items-center gap-2 border-b border-border px-4">
          <SearchIcon className="size-4 shrink-0 text-foreground/40" />
          <input
            ref={inputRef}
            type="text"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search folders or actions…"
            className="w-full bg-transparent py-3 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none"
          />
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {items.length === 0 ? (
            <div className="px-4 py-3 text-sm text-foreground/50">
              No results
            </div>
          ) : (
            items.map((item, i) => {
              const isSelected = i === selected;
              const RowIcon = item.kind === "action" ? item.icon : FolderIcon;
              return (
                <button
                  key={
                    item.kind === "action"
                      ? `action:${item.id}`
                      : `folder:${item.folder}`
                  }
                  type="button"
                  // Keep focus on the input so arrow keys always drive the
                  // `selected` highlight instead of stranding focus on a row.
                  tabIndex={-1}
                  data-index={i}
                  onClick={() => activate(i)}
                  onMouseMove={() => setSelected(i)}
                  className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${
                    isSelected ? "bg-foreground/5" : ""
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <RowIcon className="size-3.5 shrink-0 text-foreground/50" />
                    {item.kind === "action" ? (
                      <span className="truncate font-medium text-foreground">
                        {item.label}
                      </span>
                    ) : (
                      <FolderRow name={item.folder} query={q} />
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-3 pl-3">
                    {item.kind === "folder" && (
                      <span className="text-xs tabular-nums text-foreground/40">
                        {item.count}
                      </span>
                    )}
                    {isSelected && (
                      <span className="text-xs text-foreground/40">
                        {item.kind === "action" ? item.hint : "go"}
                      </span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-foreground/40">
          <span>Esc to close</span>
          <span className="flex items-center gap-1.5">
            <ArrowUpIcon className="size-3" />
            <ArrowDownIcon className="size-3" />
            <span>navigate</span>
            <span className="text-foreground/20">·</span>
            <EnterIcon className="size-3" />
            <span>select</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** A folder row with the matching substring emphasized. */
function FolderRow({ name, query }: { name: string; query: string }) {
  if (!query) return <span className="truncate text-foreground">{name}</span>;

  const folded = foldText(name);
  const idx = folded.indexOf(query);
  // Precomposed accents keep a 1:1 mapping, so offsets into `folded` are valid
  // in `name`. If folding changed the length, skip the highlight rather than
  // slice at the wrong boundary.
  if (idx === -1 || folded.length !== name.length) {
    return <span className="truncate text-foreground">{name}</span>;
  }
  return (
    <span className="truncate text-foreground/50">
      {name.slice(0, idx)}
      <span className="font-medium text-foreground">
        {name.slice(idx, idx + query.length)}
      </span>
      {name.slice(idx + query.length)}
    </span>
  );
}
