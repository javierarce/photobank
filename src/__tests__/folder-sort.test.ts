import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_FOLDER_SORT_MODE,
  loadFolderSortMode,
  saveFolderSortMode,
  sortFolders,
} from "@/lib/folder-sort";
import { makeFolder } from "@/__tests__/fixtures";

const names = (folders: ReturnType<typeof makeFolder>[]) =>
  folders.map((f) => f.folder);

const berlin = makeFolder({ folder: "berlin", lastAddedAt: "2026-03-01T00:00:00Z" });
const atlanta = makeFolder({ folder: "Atlanta", lastAddedAt: "2026-01-01T00:00:00Z" });
const trip10 = makeFolder({ folder: "trip 10", lastAddedAt: "2026-02-01T00:00:00Z" });
const trip2 = makeFolder({ folder: "trip 2", lastAddedAt: "2026-02-01T00:00:00Z" });

const all = [berlin, atlanta, trip10, trip2];

describe("sortFolders", () => {
  it("orders by name, case-insensitively and numerically", () => {
    expect(names(sortFolders(all, "name-asc"))).toEqual([
      "Atlanta",
      "berlin",
      "trip 2",
      "trip 10",
    ]);
    expect(names(sortFolders(all, "name-desc"))).toEqual([
      "trip 10",
      "trip 2",
      "berlin",
      "Atlanta",
    ]);
  });

  it("orders by when the folder last received a photo", () => {
    expect(names(sortFolders(all, "updated-desc"))).toEqual([
      "berlin",
      "trip 2",
      "trip 10",
      "Atlanta",
    ]);
    expect(names(sortFolders(all, "updated-asc"))).toEqual([
      "Atlanta",
      "trip 2",
      "trip 10",
      "berlin",
    ]);
  });

  it("sinks folders with no recorded time to the bottom of a recent-first list", () => {
    const unknown = makeFolder({ folder: "mystery", lastAddedAt: null });
    const broken = makeFolder({ folder: "broken", lastAddedAt: "not a date" });
    expect(names(sortFolders([unknown, broken, berlin], "updated-desc"))).toEqual([
      "berlin",
      "broken",
      "mystery",
    ]);
  });

  it("leaves the input array untouched", () => {
    const input = [berlin, atlanta];
    sortFolders(input, "name-asc");
    expect(names(input)).toEqual(["berlin", "Atlanta"]);
  });
});

describe("folder sort preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to name order and round-trips a saved choice", () => {
    expect(loadFolderSortMode()).toBe(DEFAULT_FOLDER_SORT_MODE);
    saveFolderSortMode("updated-desc");
    expect(loadFolderSortMode()).toBe("updated-desc");
  });

  it("ignores a stored value that is no longer a sort mode", () => {
    localStorage.setItem("photobank:folder-sort", "by-vibes");
    expect(loadFolderSortMode()).toBe(DEFAULT_FOLDER_SORT_MODE);
  });
});
