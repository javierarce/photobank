import { useSyncExternalStore } from "react";
import type { Photo } from "@/lib/types";

/** Which way a photo is turned. Square photos count as landscape: a filter
 * that dropped them from BOTH sides would make them unreachable, and a square
 * is far closer to a landscape crop than to a portrait one. */
export type Orientation = "landscape" | "portrait";

/** The segmented control's choices — "all" is the unfiltered default. */
export type OrientationFilter = "all" | Orientation;

export const ORIENTATION_OPTIONS: readonly {
  value: OrientationFilter;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "landscape", label: "Landscape" },
  { value: "portrait", label: "Portrait" },
];

/** How many photos to probe at once (see OrientationProbe in photo-grid). */
export const PROBE_BATCH = 12;

// Measurements are persisted as one compact object of id -> "l" | "p". A whole
// library is a few thousand entries — tens of KB, well inside the localStorage
// budget — and the value never changes for a given photo, so this is written
// once and read forever.
const STORAGE_KEY = "photobank:photo-orientation";
const PERSIST_DELAY_MS = 500;

let measured: Map<string, Orientation> | null = null;
// Photos whose thumbnail AND original both failed to load. They're held out of
// the probe queue so it drains instead of retrying them forever — but only
// until a library refresh, which regenerates the very variants whose absence
// wrote them off (see retryUnmeasurable). Not persisted, for the same reason.
const unmeasurable = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function store(): Map<string, Orientation> {
  if (measured) return measured;
  measured = new Map();
  if (typeof localStorage === "undefined") return measured;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    for (const [id, code] of Object.entries(parsed)) {
      if (code === "l") measured.set(id, "landscape");
      else if (code === "p") measured.set(id, "portrait");
    }
  } catch {
    // Corrupt or unavailable storage: the photos simply get measured again.
  }
  return measured;
}

// Batched so a burst of thumbnails landing doesn't serialize the whole map once
// per image. A failed write (private mode, quota) is ignored — the
// measurements still hold for this session.
function schedulePersist() {
  if (persistTimer || typeof localStorage === "undefined") return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const out: Record<string, string> = {};
      for (const [id, orientation] of store()) {
        out[id] = orientation === "landscape" ? "l" : "p";
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch {
      // ignore
    }
  }, PERSIST_DELAY_MS);
}

function notify() {
  version++;
  for (const listener of listeners) listener();
}

/** Turn a pair of dimensions into an orientation; null when either is missing
 * or nonsensical (a decode that produced a 0×0 image). */
export function classifyOrientation(
  width: number | null | undefined,
  height: number | null | undefined
): Orientation | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  return width >= height ? "landscape" : "portrait";
}

/**
 * Which way a photo is turned, or null if nobody knows yet.
 *
 * Most catalog rows carry no dimensions: only a local import (or a "Load info"
 * / refresh that downloaded the original) fills width/height, and the bulk of a
 * library synced from the bucket listing has neither. So the row is consulted
 * first and the thumbnail measurements below stand in for the rest.
 */
export function orientationOf(photo: Photo): Orientation | null {
  return (
    classifyOrientation(photo.width, photo.height) ?? store().get(photo.id) ?? null
  );
}

export function matchesOrientation(
  photo: Photo,
  filter: OrientationFilter
): boolean {
  return filter === "all" || orientationOf(photo) === filter;
}

/** Remember a photo's orientation, read off a thumbnail that just loaded.
 * Dimensions the browser couldn't make sense of retire the photo from the
 * probe queue rather than being stored. */
export function recordOrientation(
  id: string,
  width: number,
  height: number
): void {
  const orientation = classifyOrientation(width, height);
  if (!orientation) {
    markUnmeasurable(id);
    return;
  }
  if (store().get(id) === orientation) return;
  store().set(id, orientation);
  schedulePersist();
  notify();
}

/** Give up on a photo for this session — its thumbnail and its original both
 * failed to load, so there's nothing left to measure. */
export function markUnmeasurable(id: string): void {
  if (unmeasurable.has(id)) return;
  unmeasurable.add(id);
  notify();
}

export function isUnmeasurable(id: string): boolean {
  return unmeasurable.has(id);
}

/** Put every photo we gave up on back in the probe queue. Called when a library
 * refresh settles: it regenerates exactly the variants whose absence wrote them
 * off, and a transient stall (a probe that timed out) deserves another go too.
 * Without this the advice the grid prints — "a library refresh regenerates
 * missing thumbnails" — would be a dead end until the app was relaunched. */
export function retryUnmeasurable(): void {
  if (!unmeasurable.size) return;
  unmeasurable.clear();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Module-level so its identity is stable across renders — a fresh function
// would have useSyncExternalStore tearing down and re-subscribing every time.
const ignore = () => () => {};

/**
 * Re-render when a measurement lands. Returns an opaque version number, which
 * is only useful as a memo dependency.
 *
 * `enabled` is load bearing: measurements are recorded constantly — every tile
 * that loads takes one — while almost nothing reads them. A grid with the
 * filter off would re-render once per thumbnail, rebuilding its whole tile list
 * each time, to answer a question nobody asked. Pass false there and the hook
 * holds still until the filter is actually switched on.
 */
export function useOrientations(enabled = true): number {
  return useSyncExternalStore(
    enabled ? subscribe : ignore,
    () => (enabled ? version : 0),
    () => (enabled ? version : 0)
  );
}

/** Drop everything that's been measured, stored copy included. For tests —
 * nothing in the app has a reason to forget. */
export function resetOrientations(): void {
  reloadOrientations();
  try {
    localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Forget what's in memory but leave the stored copy alone, so the next read
 * comes back off localStorage — what a relaunch does. For tests: it's the only
 * way to exercise the restore path. */
export function reloadOrientations(): void {
  measured = null;
  unmeasurable.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  notify();
}
