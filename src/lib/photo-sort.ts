import type { Photo } from "@/lib/types";

// The ways a folder's photos can be ordered. The date modes read the capture
// date from the filename (see fileDate); `date-desc` is the default so the
// newest shots lead.
export type SortMode = "date-desc" | "date-asc" | "name-asc" | "name-desc";

export const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "date-desc", label: "Newest first" },
  { value: "date-asc", label: "Oldest first" },
  { value: "name-asc", label: "Name (A–Z)" },
  { value: "name-desc", label: "Name (Z–A)" },
];

export const DEFAULT_SORT_MODE: SortMode = "date-desc";

const SORT_STORAGE_KEY = "photobank:photo-sort";

function isSortMode(value: string | null): value is SortMode {
  return SORT_OPTIONS.some((o) => o.value === value);
}

/** Read the persisted sort choice, falling back to the default. */
export function loadSortMode(): SortMode {
  if (typeof localStorage === "undefined") return DEFAULT_SORT_MODE;
  const saved = localStorage.getItem(SORT_STORAGE_KEY);
  return isSortMode(saved) ? saved : DEFAULT_SORT_MODE;
}

/** Persist the sort choice; a failed write (private mode, quota) is ignored —
 * the order still applies for the session. */
export function saveSortMode(mode: SortMode): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

// Files are named with a leading capture date — "2025-04-12-Berlin-DSCF4162"
// or "2017_09_02_Berlin_00003" (either separator). The real capture date
// (EXIF taken_at) is loaded lazily and null for most photos, so the filename
// is the only chronology we can sort a whole folder by.
const FILENAME_DATE = /^(\d{4})[-_](\d{2})[-_](\d{2})/;

// A sortable YYYYMMDD number, or 0 when the filename has no leading date.
// Undated files (older, ad-hoc names) thus rank as the oldest and sink to the
// bottom of a newest-first list — the user's convention.
function fileDate(p: Photo): number {
  const m = FILENAME_DATE.exec(p.filename);
  if (!m) return 0;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

// Natural, case-insensitive compare so IMG_2 sorts before IMG_10.
const byName = (a: Photo, b: Photo) =>
  a.filename.localeCompare(b.filename, undefined, {
    numeric: true,
    sensitivity: "base",
  });

/** Return a new array ordered by `mode`; the input is left untouched. The
 * filename date has only day granularity, so photos shot the same day tie on
 * it; we break that tie by filename in the same direction, so a camera's
 * incrementing sequence number (R0014360 after R0014353) keeps the newest
 * shot leading within the day. */
export function sortPhotos(photos: Photo[], mode: SortMode): Photo[] {
  const sorted = [...photos];
  switch (mode) {
    case "date-asc":
      return sorted.sort((a, b) => fileDate(a) - fileDate(b) || byName(a, b));
    case "date-desc":
      return sorted.sort((a, b) => fileDate(b) - fileDate(a) || byName(b, a));
    case "name-asc":
      return sorted.sort(byName);
    case "name-desc":
      return sorted.sort((a, b) => byName(b, a));
  }
}
