import { NextRequest } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import archiver from "archiver";
import { Readable, PassThrough } from "stream";
import { s3, S3_BUCKET } from "@/lib/s3";
import { db } from "@/db";
import { photos } from "@/db/schema";
import { inArray } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const { photoIds, resolution = "2880", format = "jpg" } = await request.json();

  if (!photoIds?.length) {
    return new Response("No photos selected", { status: 400 });
  }

  const selected = await db
    .select({ filename: photos.filename, s3Key: photos.s3Key })
    .from(photos)
    .where(inArray(photos.id, photoIds));

  if (!selected.length) {
    return new Response("No photos found", { status: 404 });
  }

  const passthrough = new PassThrough();
  const archive = archiver("zip", { zlib: { level: 1 } });

  archive.pipe(passthrough);

  for (const photo of selected) {
    const base = photo.s3Key.replace(/\.[^.]+$/, "");
    const ext = format === "webp" ? "webp" : "jpg";
    const key = `${base}_${resolution}.${ext}`;

    try {
      const response = await s3.send(
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: key })
      );
      const stream = response.Body as Readable;
      const name = photo.filename.replace(/\.[^.]+$/, `.${ext}`);
      archive.append(stream, { name });
    } catch {
      // Skip missing files
    }
  }

  archive.finalize();

  const webStream = Readable.toWeb(passthrough) as ReadableStream;

  return new Response(webStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="photos.zip"`,
    },
  });
}
