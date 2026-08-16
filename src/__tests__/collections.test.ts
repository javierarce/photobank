import { describe, it, expect } from "vitest";
import {
  collectionCover,
  loosePhotos,
  membershipMap,
  photosInCollection,
} from "@/lib/collections";
import type { Photo } from "@/lib/types";
import { makeCollection, makePhoto } from "./fixtures";

const photo = (id: string, overrides: Partial<Photo> = {}) =>
  makePhoto({ id, filename: `${id}.jpg`, ...overrides });

describe("loosePhotos", () => {
  it("leaves out the photos a collection has taken in", () => {
    const photos = [photo("a"), photo("b"), photo("c")];
    const collections = [
      makeCollection({ id: "c1", photoIds: ["a"] }),
      makeCollection({ id: "c2", photoIds: ["c"] }),
    ];

    // A collection holds its photos like a sub-folder: only what's left over
    // shows in the folder's own grid.
    expect(loosePhotos(photos, collections).map((p) => p.id)).toEqual(["b"]);
  });

  it("keeps a photo whose collection the grid hasn't caught up with", () => {
    // The collection was dissolved (or the photo moved) in another view —
    // better loose in the folder than missing from every view.
    const stale = makeCollection({ id: "c1", photoIds: [] });
    expect(loosePhotos([photo("a")], [stale]).map((p) => p.id)).toEqual(["a"]);
  });

  it("is every photo when there are no collections", () => {
    const photos = [photo("a"), photo("b")];
    expect(loosePhotos(photos, [])).toEqual(photos);
  });
});

describe("photosInCollection", () => {
  it("keeps the order the grid is already sorted in", () => {
    const photos = [photo("a"), photo("b"), photo("c")];
    // The collection lists its members newest-first; the grid's chosen sort
    // wins inside the collection, so "a" still precedes "c".
    const collection = makeCollection({ id: "c1", photoIds: ["c", "a"] });
    expect(photosInCollection(photos, collection).map((p) => p.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("only takes photos that are actually on hand", () => {
    const collection = makeCollection({ id: "c1", photoIds: ["a", "gone"] });
    expect(photosInCollection([photo("a")], collection).map((p) => p.id)).toEqual(
      ["a"]
    );
  });
});

describe("membershipMap", () => {
  it("maps each photo to the collection holding it", () => {
    const map = membershipMap([
      makeCollection({ id: "c1", photoIds: ["a"] }),
      makeCollection({ id: "c2", photoIds: ["b"] }),
    ]);
    expect(map.get("a")?.id).toBe("c1");
    expect(map.get("b")?.id).toBe("c2");
    expect(map.get("c")).toBeUndefined();
  });
});

describe("collectionCover", () => {
  const byId = (photos: Photo[]) => new Map(photos.map((p) => [p.id, p]));

  it("shows the newest member it can actually display", () => {
    const photos = [photo("new"), photo("old")];
    const collection = makeCollection({ photoIds: ["new", "old"] });
    expect(collectionCover(collection, byId(photos))?.id).toBe("new");
  });

  it("skips members whose thumbnails don't exist yet", () => {
    // Nothing here may pull a full original down to fill a card, so a photo
    // still awaiting its variants is passed over for one that has them.
    const photos = [
      photo("pending", { processingStatus: "pending" }),
      photo("nothumbs", { variantsOk: false }),
      photo("ready"),
    ];
    const collection = makeCollection({
      photoIds: ["pending", "nothumbs", "ready"],
    });
    expect(collectionCover(collection, byId(photos))?.id).toBe("ready");
  });

  it("has no cover when the collection is empty or unloaded", () => {
    expect(collectionCover(makeCollection({ photoIds: [] }), new Map())).toBeNull();
    expect(
      collectionCover(makeCollection({ photoIds: ["gone"] }), new Map())
    ).toBeNull();
  });
});
