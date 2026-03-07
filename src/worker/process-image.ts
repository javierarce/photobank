import "dotenv/config";
import { Worker, Job } from "bullmq";
import sharp from "sharp";
import exifReader from "exif-reader";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3, S3_BUCKET } from "../lib/s3";
import { db } from "../db";
import { photos } from "../db/schema";
import { eq } from "drizzle-orm";

const VARIANTS = [
  { width: 128, suffix: "128" },
  { width: 640, suffix: "640" },
  { width: 1280, suffix: "1280" },
  { width: 2880, suffix: "2880" },
] as const;

const FORMATS = ["jpeg", "webp"] as const;

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
  const getCommand = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
  });
  const response = await s3.send(getCommand);
  const originalBuffer = Buffer.from(
    await response.Body!.transformToByteArray()
  );

  // Extract metadata and EXIF
  const image = sharp(originalBuffer);
  const metadata = await image.metadata();

  let exifData: Record<string, unknown> = {};
  if (metadata.exif) {
    try {
      const parsed = exifReader(metadata.exif);
      exifData = {
        ...parsed.Image,
        ...parsed.Photo,
        ...parsed.GPSInfo,
      };
    } catch {
      // EXIF parsing failed, continue without it
    }
  }

  // Generate all variants
  const baseName = s3Key.replace(/\.[^.]+$/, "");
  const totalSteps = VARIANTS.length * FORMATS.length;
  let completed = 0;

  for (const variant of VARIANTS) {
    const resized = sharp(originalBuffer).resize(variant.width, undefined, {
      withoutEnlargement: true,
    });

    for (const format of FORMATS) {
      const ext = format === "jpeg" ? "jpg" : "webp";
      const key = `${baseName}_${variant.suffix}.${ext}`;

      const buffer =
        format === "jpeg"
          ? await resized.clone().jpeg({ quality: 85 }).toBuffer()
          : await resized.clone().webp({ quality: 85 }).toBuffer();

      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: buffer,
          ContentType: format === "jpeg" ? "image/jpeg" : "image/webp",
        })
      );

      completed++;
      await job.updateProgress(Math.round((completed / totalSteps) * 100));
    }
  }

  // Update DB with metadata and EXIF
  await db
    .update(photos)
    .set({
      width: metadata.width,
      height: metadata.height,
      processingStatus: "completed",
      cameraMake: (exifData.Make as string) || null,
      cameraModel: (exifData.Model as string) || null,
      lens: (exifData.LensModel as string) || null,
      focalLength: exifData.FocalLength
        ? `${exifData.FocalLength}mm`
        : null,
      aperture: exifData.FNumber ? `f/${exifData.FNumber}` : null,
      shutterSpeed: exifData.ExposureTime
        ? `${exifData.ExposureTime}s`
        : null,
      iso: (exifData.ISOSpeedRatings as number) || null,
      takenAt: exifData.DateTimeOriginal
        ? new Date(exifData.DateTimeOriginal as string)
        : null,
      gpsLatitude: (exifData.GPSLatitude as number) || null,
      gpsLongitude: (exifData.GPSLongitude as number) || null,
      updatedAt: new Date(),
    })
    .where(eq(photos.id, photoId));
}

const connection = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
};

const worker = new Worker<JobData>("image-processing", processImage, {
  connection,
  concurrency: 2,
});

worker.on("completed", (job) => {
  console.log(`Completed: ${job.data.s3Key}`);
});

worker.on("failed", async (job, err) => {
  console.error(`Failed: ${job?.data.s3Key}`, err.message);
  if (job) {
    await db
      .update(photos)
      .set({ processingStatus: "failed", updatedAt: new Date() })
      .where(eq(photos.id, job.data.photoId));
  }
});

console.log("Image processing worker started");
