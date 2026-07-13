import { describe, it, expect, afterEach } from "vitest";
import { renderHook, cleanup, waitFor } from "@testing-library/react";
import { reconcile, usePresence, type PresenceEntry } from "@/hooks/use-presence";

type Item = { id: string };
const keyOf = (i: Item) => i.id;
const items = (...ids: string[]): Item[] => ids.map((id) => ({ id }));

/** Compact "key:state" view of an entry list for readable assertions. */
function shape<T>(entries: PresenceEntry<T>[]): string[] {
  return entries.map((e) => `${e.key}:${e.state}`);
}

function fromShape(...specs: [string, PresenceEntry<Item>["state"]][]) {
  return specs.map(([id, state]) => ({ key: id, item: { id }, state }));
}

afterEach(() => {
  cleanup();
});

describe("reconcile", () => {
  it("marks every item present on the first (baseline) population", () => {
    expect(shape(reconcile([], items("a", "b"), keyOf))).toEqual([
      "a:present",
      "b:present",
    ]);
  });

  it("marks items added to a non-empty list as entering", () => {
    const prev = fromShape(["a", "present"]);
    expect(shape(reconcile(prev, items("a", "b"), keyOf))).toEqual([
      "a:present",
      "b:entering",
    ]);
  });

  it("keeps a removed item exiting, in its original position", () => {
    const prev = fromShape(["a", "present"], ["b", "present"], ["c", "present"]);
    expect(shape(reconcile(prev, items("a", "c"), keyOf))).toEqual([
      "a:present",
      "b:exiting",
      "c:present",
    ]);
  });

  it("anchors a removed first item at the front", () => {
    const prev = fromShape(["a", "present"], ["b", "present"]);
    expect(shape(reconcile(prev, items("b"), keyOf))).toEqual([
      "a:exiting",
      "b:present",
    ]);
  });

  it("keeps consecutive removals together and in order", () => {
    const prev = fromShape(
      ["a", "present"],
      ["b", "present"],
      ["c", "present"],
      ["d", "present"]
    );
    expect(shape(reconcile(prev, items("a", "d"), keyOf))).toEqual([
      "a:present",
      "b:exiting",
      "c:exiting",
      "d:present",
    ]);
  });

  it("revives an item that reappears while exiting, with no duplicate", () => {
    const prev = fromShape(["a", "exiting"], ["b", "present"]);
    expect(shape(reconcile(prev, items("a", "b"), keyOf))).toEqual([
      "a:present",
      "b:present",
    ]);
  });

  it("follows the incoming order when items are reordered", () => {
    const prev = fromShape(["a", "present"], ["b", "present"]);
    expect(shape(reconcile(prev, items("b", "a"), keyOf))).toEqual([
      "b:present",
      "a:present",
    ]);
  });

  it("adopts the new item object so content updates (e.g. rename)", () => {
    const prev = fromShape(["a", "present"]);
    const renamed = { id: "a", label: "new" };
    const [entry] = reconcile(prev, [renamed], (i) => i.id);
    expect(entry.item).toBe(renamed);
  });
});

describe("usePresence", () => {
  it("returns every item present on first render", () => {
    const { result } = renderHook(() => usePresence(items("a", "b"), keyOf));
    expect(shape(result.current)).toEqual(["a:present", "b:present"]);
  });

  it("holds a removed item as exiting, then drops it after exitMs", async () => {
    const { result, rerender } = renderHook(
      ({ list }) => usePresence(list, keyOf, { exitMs: 20 }),
      { initialProps: { list: items("a", "b") } }
    );

    rerender({ list: items("a") });
    // Still rendered (exiting) so it can fade in place rather than vanish.
    expect(shape(result.current)).toEqual(["a:present", "b:exiting"]);

    // Unmounted once the exit window elapses.
    await waitFor(() => {
      expect(shape(result.current)).toEqual(["a:present"]);
    });
  });

  it("cancels the removal when an item reappears before exitMs elapses", async () => {
    const { result, rerender } = renderHook(
      ({ list }) => usePresence(list, keyOf, { exitMs: 50 }),
      { initialProps: { list: items("a", "b") } }
    );

    rerender({ list: items("a") });
    expect(shape(result.current)).toContain("b:exiting");

    rerender({ list: items("a", "b") });
    expect(shape(result.current)).toEqual(["a:present", "b:present"]);

    // Give the (cancelled) timer a chance to fire — b must survive.
    await new Promise((r) => setTimeout(r, 80));
    expect(shape(result.current)).toEqual(["a:present", "b:present"]);
  });

  it("settles a newly added item to present", async () => {
    const { result, rerender } = renderHook(
      ({ list }) => usePresence(list, keyOf),
      { initialProps: { list: items("a") } }
    );

    rerender({ list: items("a", "b") });
    await waitFor(() => {
      expect(shape(result.current)).toEqual(["a:present", "b:present"]);
    });
  });
});
