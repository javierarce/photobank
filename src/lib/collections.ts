// Collections behave like sub-folders inside a folder: a photo in one lives
// *inside* it rather than alongside the folder's loose photos. These helpers
// are the split — kept pure (no React, no DOM) so the rules can be tested on
// plain arrays.

import type { Collection, Photo } from "@/lib/types";

/** photo id → the collection holding it. Photos absent from the map are loose
 * in the folder. */
export function membershipMap(
  collections: Collection[]
): Map<string, Collection> {
  const map = new Map<string, Collection>();
  for (const collection of collections) {
    for (const id of collection.photoIds) map.set(id, collection);
  }
  return map;
}

/** The folder's own photos — the ones no collection has taken in. A photo
 * whose collection the grid hasn't heard of yet counts as loose rather than
 * vanishing from both views. */
export function loosePhotos(
  photos: Photo[],
  collections: Collection[]
): Photo[] {
  const membership = membershipMap(collections);
  return photos.filter((p) => !membership.has(p.id));
}

/** The photos inside one collection, in the order `photos` is already sorted
 * (so the folder's chosen sort carries into the collection). */
export function photosInCollection(
  photos: Photo[],
  collection: Collection
): Photo[] {
  const members = new Set(collection.photoIds);
  return photos.filter((p) => members.has(p.id));
}

/**
 * The photo a collection's card shows: its newest member that can actually be
 * displayed. Nothing here ever pulls an original down to fill a card — a
 * member still awaiting its thumbnails is skipped, exactly as folder covers do
 * (see folder_cover in commands.rs), and an empty collection shows the
 * standard placeholder instead.
 */
export function collectionCover(
  collection: Collection,
  photoById: Map<string, Photo>
): Photo | null {
  for (const id of collection.photoIds) {
    const photo = photoById.get(id);
    if (photo?.processingStatus === "completed" && photo.variantsOk) {
      return photo;
    }
  }
  return null;
}
