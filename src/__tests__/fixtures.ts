import type { Photo } from "@/lib/types";

export function makePhoto(overrides: Partial<Photo> = {}): Photo {
  return {
    id: "1",
    filename: "photo.jpg",
    s3Key: "inbox/photo.jpg",
    folder: "inbox",
    mimeType: "image/jpeg",
    fileSize: 1024,
    width: 1920,
    height: 1080,
    processingStatus: "completed",
    cameraMake: null,
    cameraModel: null,
    lens: null,
    focalLength: null,
    aperture: null,
    shutterSpeed: null,
    iso: null,
    takenAt: null,
    gpsLatitude: null,
    gpsLongitude: null,
    variantsOk: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
