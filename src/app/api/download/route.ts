import { NextRequest } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import archiver from "archiver";
import { Readable, PassThrough } from "stream";
import { s3, S3_BUCKET } from "@/lib/s3";
import { baseKey } from "@/lib/keys";
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

  archive.on("error", (err) => {
    console.error("[download] archive error:", err);
    passthrough.destroy(err);
  });

  archive.pipe(passthrough);

  const ext = format === "webp" ? "webp" : "jpg";
  const usedNames = new Set<string>();

  for (const photo of selected) {
    const key = `${baseKey(photo.s3Key)}_${resolution}.${ext}`;

    try {
      const response = await s3.send(
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: key })
      );
      const stream = response.Body as Readable;

      // Avoid duplicate entry names when photos in different folders share a filename
      const base = photo.filename.replace(/\.[^.]+$/, "");
      let name = `${base}.${ext}`;
      for (let n = 1; usedNames.has(name); n++) {
        name = `${base} (${n}).${ext}`;
      }
      usedNames.add(name);

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
