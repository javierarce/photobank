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
  takenAt: string | null;
};
