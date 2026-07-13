import { useEffect, useRef, useState } from "react";

// A minimal enter/exit presence layer for keyed lists — enough to let grid
// tiles animate in when added and animate out *in place* when removed, without
// pulling in an animation library. Removed items are retained in the rendered
// list (marked `exiting`) at their original position until their exit
// transition finishes, so neighbours don't teleport the instant an item is
// deleted.

export type PresenceState = "entering" | "present" | "exiting";

export type PresenceEntry<T> = {
  key: string;
  item: T;
  state: PresenceState;
};

/**
 * Merge the live `items` into the previously-rendered `prev` entries.
 *
 * - Items new to a non-empty list start as `entering`; on the very first
 *   population (`prev` empty) they're `present`, so an initial load or a full
 *   folder swap doesn't animate every tile at once.
 * - Items missing from `items` become `exiting` and stay at their old position
 *   (anchored after their surviving predecessor) so they fade where they were.
 * - An item that reappears while exiting (e.g. a failed delete rolling back)
 *   snaps back to `present`.
 *
 * Pure and order-preserving so it can be reasoned about and tested directly.
 */
export function reconcile<T>(
  prev: PresenceEntry<T>[],
  items: T[],
  keyOf: (item: T) => string
): PresenceEntry<T>[] {
  const baseline = prev.length === 0;
  const itemKeys = new Set(items.map(keyOf));
  const prevByKey = new Map(prev.map((e) => [e.key, e]));

  // The living backbone, in the incoming order.
  const alive: PresenceEntry<T>[] = items.map((item) => {
    const key = keyOf(item);
    const existing = prevByKey.get(key);
    if (!existing) return { key, item, state: baseline ? "present" : "entering" };
    // A reappearing item cancels its exit; otherwise keep its enter/present.
    if (existing.state === "exiting") return { key, item, state: "present" };
    return { key, item, state: existing.state };
  });

  const result = [...alive];
  const placed = new Set(result.map((e) => e.key));

  // Weave the departing items back in, each just after the last entry that
  // preceded it in `prev` and still exists in the result (a surviving sibling,
  // or an already-reinserted exiting one so runs stay in order).
  let anchorKey: string | null = null;
  for (const entry of prev) {
    if (itemKeys.has(entry.key)) {
      anchorKey = entry.key;
      continue;
    }
    if (placed.has(entry.key)) continue; // defensive: no duplicates
    const exiting: PresenceEntry<T> = {
      key: entry.key,
      item: entry.item,
      state: "exiting",
    };
    const anchorIndex =
      anchorKey === null ? -1 : result.findIndex((e) => e.key === anchorKey);
    result.splice(anchorIndex + 1, 0, exiting);
    placed.add(entry.key);
    anchorKey = entry.key;
  }

  return result;
}

function sameEntries<T>(a: PresenceEntry<T>[], b: PresenceEntry<T>[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key) return false;
    if (a[i].state !== b[i].state) return false;
    if (a[i].item !== b[i].item) return false;
  }
  return true;
}

type Options = {
  /** How long the exit transition lasts before the tile is unmounted (ms). */
  exitMs?: number;
};

/**
 * Track enter/exit state for a keyed list. Returns the entries to render, each
 * carrying a `state` for the `data-presence` attribute the CSS animates.
 *
 * The list is expected to be stable across its lifetime (a wholesale swap —
 * e.g. changing folders — should remount the consumer so this hook re-baselines
 * from empty). Within that lifetime, added items enter and removed items exit.
 */
export function usePresence<T>(
  items: T[],
  keyOf: (item: T) => string,
  { exitMs = 150 }: Options = {}
): PresenceEntry<T>[] {
  const [entries, setEntries] = useState<PresenceEntry<T>[]>(() =>
    items.map((item) => ({ key: keyOf(item), item, state: "present" as const }))
  );
  const exitTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;

  // Reconcile whenever the live list changes. `items` is a fresh array each
  // render, so bail out via `sameEntries` when nothing actually moved to avoid a
  // self-perpetuating render loop.
  useEffect(() => {
    setEntries((prev) => {
      const next = reconcile(prev, items, keyRef.current);
      return sameEntries(prev, next) ? prev : next;
    });
  }, [items]);

  // Flip freshly-entered tiles to `present` on the next frame so the CSS
  // transition has an initial (hidden) frame to animate away from.
  useEffect(() => {
    if (!entries.some((e) => e.state === "entering")) return;
    const raf = requestAnimationFrame(() => {
      setEntries((prev) =>
        prev.map((e) => (e.state === "entering" ? { ...e, state: "present" } : e))
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [entries]);

  // Arm a removal timer for each exiting tile; cancel any timer for a tile that
  // came back to life.
  useEffect(() => {
    const timers = exitTimers.current;
    for (const e of entries) {
      if (e.state === "exiting" && !timers.has(e.key)) {
        const timer = setTimeout(() => {
          timers.delete(e.key);
          setEntries((prev) =>
            prev.filter((x) => !(x.key === e.key && x.state === "exiting"))
          );
        }, exitMs);
        timers.set(e.key, timer);
      } else if (e.state !== "exiting" && timers.has(e.key)) {
        clearTimeout(timers.get(e.key));
        timers.delete(e.key);
      }
    }
  }, [entries, exitMs]);

  useEffect(() => {
    const timers = exitTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  return entries;
}
