import type { FolderCount } from "@/lib/types";

// The ways the home page can order its folder cards. `updated-desc` reads
// lastAddedAt — when the folder's newest photo entered the catalog — so the
// folders you've been filling lead. Name order is the default, since a folder
// grid you navigate by sight should stay where you left it.
export type FolderSortMode =
  | "name-asc"
  | "name-desc"
  | "updated-desc"
  | "updated-asc";

export const FOLDER_SORT_OPTIONS: { value: FolderSortMode; label: string }[] = [
  { value: "name-asc", label: "Name (A–Z)" },
  { value: "name-desc", label: "Name (Z–A)" },
  { value: "updated-desc", label: "Recently updated" },
  { value: "updated-asc", label: "Least recent" },
];

export const DEFAULT_FOLDER_SORT_MODE: FolderSortMode = "name-asc";

const FOLDER_SORT_STORAGE_KEY = "photobank:folder-sort";

function isFolderSortMode(value: string | null): value is FolderSortMode {
  return FOLDER_SORT_OPTIONS.some((o) => o.value === value);
}

/** Read the persisted folder order, falling back to the default. */
export function loadFolderSortMode(): FolderSortMode {
  if (typeof localStorage === "undefined") return DEFAULT_FOLDER_SORT_MODE;
  const saved = localStorage.getItem(FOLDER_SORT_STORAGE_KEY);
  return isFolderSortMode(saved) ? saved : DEFAULT_FOLDER_SORT_MODE;
}

/** Persist the folder order; a failed write (private mode, quota) is ignored —
 * the order still applies for the session. */
export function saveFolderSortMode(mode: FolderSortMode): void {
  try {
    localStorage.setItem(FOLDER_SORT_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

// Natural, case-insensitive compare so "Trip 2" sorts before "Trip 10" and
// casing doesn't split the alphabet.
const byName = (a: FolderCount, b: FolderCount) =>
  a.folder.localeCompare(b.folder, undefined, {
    numeric: true,
    sensitivity: "base",
  });

// The folder's newest photo as milliseconds. A missing or unparseable stamp
// ranks as the oldest, so such a folder sinks to the bottom of a
// recently-updated list rather than jumping to the top.
function lastAdded(f: FolderCount): number {
  if (!f.lastAddedAt) return 0;
  const t = Date.parse(f.lastAddedAt);
  return Number.isNaN(t) ? 0 : t;
}

/** Return a new array ordered by `mode`; the input is left untouched. Folders
 * that tie on recency (same import batch) fall back to name order, so the grid
 * never shuffles between reloads. */
export function sortFolders(
  folders: FolderCount[],
  mode: FolderSortMode
): FolderCount[] {
  const sorted = [...folders];
  switch (mode) {
    case "name-asc":
      return sorted.sort(byName);
    case "name-desc":
      return sorted.sort((a, b) => byName(b, a));
    case "updated-desc":
      return sorted.sort((a, b) => lastAdded(b) - lastAdded(a) || byName(a, b));
    case "updated-asc":
      return sorted.sort((a, b) => lastAdded(a) - lastAdded(b) || byName(a, b));
  }
}
