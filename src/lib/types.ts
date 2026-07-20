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

export type FolderCount = {
  folder: string;
  count: number;
};

/** Distinct EXIF values for search autocomplete (mirrors Rust `SearchFacets`). */
export type SearchFacets = {
  makes: string[];
  models: string[];
  lenses: string[];
};
