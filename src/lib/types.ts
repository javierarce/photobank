export type Photo = {
  id: string;
  filename: string;
  s3Key: string;
  folder: string;
  width: number | null;
  height: number | null;
  processingStatus: string;
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
};
