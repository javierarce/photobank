import { describe, it, expect, beforeEach } from "vitest";
import {
  sortPhotos,
  loadSortMode,
  saveSortMode,
  DEFAULT_SORT_MODE,
} from "@/lib/photo-sort";
import { makePhoto } from "./fixtures";

// Filenames carry the capture date the sort reads; createdAt is deliberately
// varied to prove it is NOT what the date modes sort by.
const p2025 = makePhoto({
  id: "2025",
  filename: "2025-04-12-Berlin-DSCF4162.jpg",
  createdAt: "2026-07-19T14:25:14Z",
});
const p2020 = makePhoto({
  id: "2020",
  filename: "2020_01_02_Berlin_00007.jpg",
  createdAt: "2026-07-19T14:25:14Z",
});
const p2017 = makePhoto({
  id: "2017",
  filename: "2017_09_02_Berlin_00003.jpg",
  createdAt: "2026-07-19T14:25:14Z",
});
// No leading date — an older, ad-hoc name.
const undated = makePhoto({
  id: "undated",
  filename: "R0004167_original.jpg",
  createdAt: "2026-07-19T14:25:14Z",
});

const ids = (photos: ReturnType<typeof makePhoto>[]) => photos.map((p) => p.id);

describe("sortPhotos — filename date", () => {
  it("puts the newest filename date first", () => {
    expect(ids(sortPhotos([p2017, p2025, p2020], "date-desc"))).toEqual([
      "2025",
      "2020",
      "2017",
    ]);
  });

  it("puts the oldest filename date first", () => {
    expect(ids(sortPhotos([p2020, p2025, p2017], "date-asc"))).toEqual([
      "2017",
      "2020",
      "2025",
    ]);
  });

  it("does not sort by import date (createdAt)", () => {
    // All four share createdAt; only the filename date decides the order.
    expect(ids(sortPhotos([p2017, p2025], "date-desc"))).toEqual(["2025", "2017"]);
  });

  it("sinks undated files to the bottom of a newest-first list", () => {
    const out = sortPhotos([undated, p2020, p2025], "date-desc");
    expect(ids(out)).toEqual(["2025", "2020", "undated"]);
  });

  it("raises undated files to the top of an oldest-first list", () => {
    const out = sortPhotos([p2025, undated, p2017], "date-asc");
    expect(out[0].id).toBe("undated");
  });

  it("parses both YYYY-MM-DD and YYYY_MM_DD separators", () => {
    const dash = makePhoto({ id: "dash", filename: "2019-06-15-x.jpg" });
    const underscore = makePhoto({ id: "under", filename: "2019_06_14_x.jpg" });
    expect(ids(sortPhotos([underscore, dash], "date-desc"))).toEqual([
      "dash",
      "under",
    ]);
  });

  it("breaks a same-day tie by filename in the sort direction", () => {
    // Same date; the sequence number is the only ordering signal.
    const s353 = makePhoto({ id: "353", filename: "2025-08-17-Berlin-R0014353_original.jpg" });
    const s360 = makePhoto({ id: "360", filename: "2025-08-17-Berlin-R0014360_original.jpg" });
    // Newest-first: the later shot (higher number) leads within the day.
    expect(ids(sortPhotos([s353, s360], "date-desc"))).toEqual(["360", "353"]);
    // Oldest-first: the earlier shot leads.
    expect(ids(sortPhotos([s360, s353], "date-asc"))).toEqual(["353", "360"]);
  });

  it("does not mutate the input array", () => {
    const input = [p2017, p2025, p2020];
    sortPhotos(input, "date-asc");
    expect(ids(input)).toEqual(["2017", "2025", "2020"]);
  });
});

describe("sortPhotos — name", () => {
  it("orders by filename naturally (IMG_2 before IMG_10)", () => {
    const two = makePhoto({ id: "2", filename: "IMG_2.jpg" });
    const ten = makePhoto({ id: "10", filename: "IMG_10.jpg" });
    expect(ids(sortPhotos([ten, two], "name-asc"))).toEqual(["2", "10"]);
    expect(ids(sortPhotos([two, ten], "name-desc"))).toEqual(["10", "2"]);
  });
});

describe("sort preference persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to the default when nothing is stored", () => {
    expect(loadSortMode()).toBe(DEFAULT_SORT_MODE);
  });

  it("round-trips a saved mode", () => {
    saveSortMode("name-asc");
    expect(loadSortMode()).toBe("name-asc");
  });

  it("ignores an unrecognized stored value", () => {
    localStorage.setItem("photobank:photo-sort", "created-desc");
    expect(loadSortMode()).toBe(DEFAULT_SORT_MODE);
  });
});
