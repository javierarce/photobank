export type ProcessingStatus = "pending" | "processing" | "completed" | "failed";

/** Mirrors the Rust `Photo` struct (serde camelCase). Dates are ISO strings. */
export type Photo = {
  id: string;
  filename: string;
  s3Key: string;
  folder: string;
  mimeType: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  processingStatus: ProcessingStatus;

  // EXIF metadata
  cameraMake: string | null;
  cameraModel: string | null;
  lens: string | null;
  focalLength: string | null;
  aperture: string | null;
  shutterSpeed: string | null;
  iso: number | null;
  takenAt: string | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;

  /** The photo's derivative set (640/1280/2880) exists in the bucket. */
  variantsOk: boolean;

  createdAt: string;
  updatedAt: string;
};

export type Tag = {
  id: string;
  name: string;
};

/** A titled group of photos inside one folder (mirrors Rust `Collection`).
 * Membership is exclusive: a photo is in at most one collection, which the
 * folder grid shows as a card the way a file manager shows a sub-folder. */
export type Collection = {
  id: string;
  folder: string;
  title: string;
  /** The photos in it, newest first. Always photos of `folder` — a move out
   * drops the membership. */
  photoIds: string[];
  createdAt: string;
  updatedAt: string;
};

/** A collection anywhere in the catalog, plus how many photos are in it —
 * enough to list and open one without its photo ids (mirrors Rust
 * `CollectionCount`). `folder` disambiguates the title, which is only unique
 * within a folder, and is half of the collection's route. */
export type CollectionCount = {
  id: string;
  folder: string;
  title: string;
  count: number;
};

/** A tag plus how many photos carry it — drives the Tags management page. */
export type TagCount = {
  id: string;
  name: string;
  count: number;
};

export type FolderCount = {
  folder: string;
  count: number;
  /** Key of the photo representing the folder on the home page — the user's
   * pick when they set one, otherwise its newest displayable photo. */
  coverKey: string | null;
  /** The cover photo's `updatedAt`, the cache-buster its URL carries. */
  coverVersion: string | null;
  /** When the folder's newest photo entered the catalog — its recency for the
   * home page's sort. */
  lastAddedAt: string | null;
};

/** Distinct EXIF values for search autocomplete (mirrors Rust `SearchFacets`). */
export type SearchFacets = {
  makes: string[];
  models: string[];
  lenses: string[];
};

/** Autocomplete pools scoped to one folder (mirrors Rust `FolderFacets`). */
export type FolderFacets = {
  tags: string[];
  makes: string[];
  models: string[];
  lenses: string[];
};
