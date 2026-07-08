import "./env";
import { Worker, Job } from "bullmq";
import sharp from "sharp";
import exifReader from "exif-reader";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3, S3_BUCKET } from "../lib/s3";
import { redisConnection } from "../lib/redis";
import { VARIANT_WIDTHS, VARIANT_FORMATS, variantKey } from "../lib/keys";
import { formatShutterSpeed, gpsToDecimal } from "./exif";
import { db } from "../db";
import { photos } from "../db/schema";
import { eq } from "drizzle-orm";

const CONTENT_TYPES = { jpg: "image/jpeg", webp: "image/webp" } as const;

type JobData = {
  photoId: string;
  s3Key: string;
};

async function processImage(job: Job<JobData>) {
  const { photoId, s3Key } = job.data;

  await db
    .update(photos)
    .set({ processingStatus: "processing", updatedAt: new Date() })
    .where(eq(photos.id, photoId));

  // Download original from S3
  const response = await s3.send(
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key })
  );
  const originalBuffer = Buffer.from(
    await response.Body!.transformToByteArray()
  );

  // Extract metadata and EXIF
  const metadata = await sharp(originalBuffer).metadata();

  let exif: Record<string, unknown> = {};
  let gps: Record<string, unknown> = {};
  if (metadata.exif) {
    try {
      const parsed = exifReader(metadata.exif);
      exif = { ...parsed.Image, ...parsed.Photo };
      gps = { ...parsed.GPSInfo };
    } catch {
      // EXIF parsing failed, continue without it
    }
  }

  // Generate all variants. autoOrient() bakes the EXIF orientation into the
  // pixels (output formats strip EXIF, so without it portraits render
  // sideways); keepIccProfile() preserves color profiles like Display P3.
  const totalSteps = VARIANT_WIDTHS.length * VARIANT_FORMATS.length;
  let completed = 0;

  for (const width of VARIANT_WIDTHS) {
    const resized = sharp(originalBuffer)
      .autoOrient()
      .keepIccProfile()
      .resize(width, undefined, { withoutEnlargement: true });

    for (const format of VARIANT_FORMATS) {
      const buffer =
        format === "jpg"
          ? await resized.clone().jpeg({ quality: 85 }).toBuffer()
          : await resized.clone().webp({ quality: 85 }).toBuffer();

      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: variantKey(s3Key, width, format),
          Body: buffer,
          ContentType: CONTENT_TYPES[format],
          CacheControl: "public, max-age=31536000",
        })
      );

      completed++;
      await job.updateProgress(Math.round((completed / totalSteps) * 100));
    }
  }

  const takenAt =
    exif.DateTimeOriginal instanceof Date &&
    !Number.isNaN(exif.DateTimeOriginal.getTime())
      ? exif.DateTimeOriginal
      : null;

  // Update DB with metadata and EXIF (dimensions as displayed, i.e. after
  // EXIF orientation is applied)
  await db
    .update(photos)
    .set({
      width: metadata.autoOrient?.width ?? metadata.width,
      height: metadata.autoOrient?.height ?? metadata.height,
      processingStatus: "completed",
      cameraMake: (exif.Make as string) || null,
      cameraModel: (exif.Model as string) || null,
      lens: (exif.LensModel as string) || null,
      focalLength: exif.FocalLength ? `${exif.FocalLength}mm` : null,
      aperture: exif.FNumber ? `f/${exif.FNumber}` : null,
      shutterSpeed: exif.ExposureTime
        ? formatShutterSpeed(exif.ExposureTime as number)
        : null,
      iso: (exif.ISOSpeedRatings as number) || null,
      takenAt,
      gpsLatitude: gpsToDecimal(gps.GPSLatitude, gps.GPSLatitudeRef),
      gpsLongitude: gpsToDecimal(gps.GPSLongitude, gps.GPSLongitudeRef),
      updatedAt: new Date(),
    })
    .where(eq(photos.id, photoId));
}

const worker = new Worker<JobData>("image-processing", processImage, {
  connection: redisConnection,
  concurrency: 2,
});

worker.on("completed", (job) => {
  console.log(`Completed: ${job.data.s3Key}`);
});

worker.on("failed", async (job, err) => {
  console.error(`Failed: ${job?.data.s3Key}`, err.message);
  // Only mark the photo failed once BullMQ has exhausted all retry attempts
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await db
      .update(photos)
      .set({ processingStatus: "failed", updatedAt: new Date() })
      .where(eq(photos.id, job.data.photoId));
  }
});

console.log("Image processing worker started");
