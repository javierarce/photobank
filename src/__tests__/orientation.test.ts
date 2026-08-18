import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  classifyOrientation,
  isUnmeasurable,
  markUnmeasurable,
  matchesOrientation,
  orientationOf,
  recordOrientation,
  reloadOrientations,
  resetOrientations,
  useOrientations,
} from "@/lib/orientation";
import { makePhoto } from "./fixtures";

const STORAGE_KEY = "photobank:photo-orientation";

beforeEach(() => {
  resetOrientations();
});

describe("classifyOrientation", () => {
  it("reads a landscape and a portrait pair", () => {
    expect(classifyOrientation(1920, 1080)).toBe("landscape");
    expect(classifyOrientation(1080, 1920)).toBe("portrait");
  });

  it("counts a square as landscape so it can't fall between the filters", () => {
    expect(classifyOrientation(1000, 1000)).toBe("landscape");
  });

  it("has no answer without usable dimensions", () => {
    expect(classifyOrientation(null, null)).toBeNull();
    expect(classifyOrientation(1920, null)).toBeNull();
    // A picture that "loaded" but didn't decode reports 0×0.
    expect(classifyOrientation(0, 0)).toBeNull();
  });
});

describe("orientationOf", () => {
  it("uses the catalog row when it has dimensions", () => {
    expect(orientationOf(makePhoto({ width: 1080, height: 1920 }))).toBe(
      "portrait"
    );
  });

  it("is unknown for a row synced from the bucket listing", () => {
    expect(
      orientationOf(makePhoto({ id: "p1", width: null, height: null }))
    ).toBeNull();
  });

  it("falls back to a measurement taken off the thumbnail", () => {
    const photo = makePhoto({ id: "p1", width: null, height: null });
    recordOrientation("p1", 640, 960);

    expect(orientationOf(photo)).toBe("portrait");
  });

  it("prefers the row's own dimensions over a measurement", () => {
    // The row is authoritative; a measurement only stands in for a missing one.
    recordOrientation("p1", 640, 960);

    expect(orientationOf(makePhoto({ id: "p1", width: 1920, height: 1080 }))).toBe(
      "landscape"
    );
  });
});

describe("matchesOrientation", () => {
  const wide = makePhoto({ id: "w", width: 1920, height: 1080 });
  const tall = makePhoto({ id: "t", width: 1080, height: 1920 });
  const unknown = makePhoto({ id: "u", width: null, height: null });

  it("keeps everything under 'all', including unmeasured photos", () => {
    for (const photo of [wide, tall, unknown]) {
      expect(matchesOrientation(photo, "all")).toBe(true);
    }
  });

  it("holds back photos turned the other way", () => {
    expect(matchesOrientation(wide, "landscape")).toBe(true);
    expect(matchesOrientation(tall, "landscape")).toBe(false);
    expect(matchesOrientation(tall, "portrait")).toBe(true);
  });

  it("holds back a photo nobody has measured yet", () => {
    expect(matchesOrientation(unknown, "landscape")).toBe(false);
    expect(matchesOrientation(unknown, "portrait")).toBe(false);
  });
});

describe("measurements", () => {
  const unmeasuredRow = (id: string) =>
    makePhoto({ id, width: null, height: null });

  /** Wait out the batched localStorage write. */
  const persisted = () =>
    new Promise((resolve) => setTimeout(resolve, 600)).then(() =>
      localStorage.getItem(STORAGE_KEY)
    );

  it("writes one compact entry per photo", async () => {
    recordOrientation("p1", 640, 960);
    recordOrientation("p2", 960, 640);

    expect(await persisted()).toBe(JSON.stringify({ p1: "p", p2: "l" }));
  });

  it("comes back after a relaunch", async () => {
    recordOrientation("p1", 640, 960);
    await persisted();

    // Forget what's in memory but leave the stored copy — a fresh launch.
    reloadOrientations();

    expect(orientationOf(unmeasuredRow("p1"))).toBe("portrait");
  });

  it("starts over rather than throwing on a corrupt store", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    reloadOrientations();

    expect(orientationOf(unmeasuredRow("p1"))).toBeNull();
  });

  it("ignores entries it doesn't recognize", () => {
    // A code from some other version of this file, or a hand-edited store.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ p1: "sideways", p2: "l" }));
    reloadOrientations();

    expect(orientationOf(unmeasuredRow("p1"))).toBeNull();
    expect(orientationOf(unmeasuredRow("p2"))).toBe("landscape");
  });

  it("writes off a photo whose image decoded to nothing", () => {
    recordOrientation("p1", 0, 0);

    expect(isUnmeasurable("p1")).toBe(true);
    expect(orientationOf(makePhoto({ id: "p1", width: null, height: null }))).toBeNull();
  });

  it("remembers which photos are past probing", () => {
    expect(isUnmeasurable("p1")).toBe(false);
    markUnmeasurable("p1");
    expect(isUnmeasurable("p1")).toBe(true);
  });
});

describe("useOrientations", () => {
  afterEach(() => cleanup());

  it("reports a new version once a measurement lands", () => {
    const { result } = renderHook(() => useOrientations(true));
    const before = result.current;

    act(() => recordOrientation("p1", 960, 640));

    expect(result.current).not.toBe(before);
  });

  it("holds still when nothing on screen is reading it", () => {
    // Every tile that loads records a measurement, so a grid with the filter
    // off would otherwise re-render once per thumbnail — rebuilding its whole
    // tile list — for an answer it never asks for.
    const { result } = renderHook(() => useOrientations(false));

    act(() => recordOrientation("p1", 960, 640));
    act(() => markUnmeasurable("p2"));

    expect(result.current).toBe(0);
  });

  it("catches up when the filter is switched on", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useOrientations(enabled),
      { initialProps: { enabled: false } }
    );
    act(() => recordOrientation("p1", 960, 640));
    expect(result.current).toBe(0);

    rerender({ enabled: true });

    // The measurements taken while it wasn't listening still have to reach the
    // memos that read them.
    expect(result.current).not.toBe(0);
  });
});
