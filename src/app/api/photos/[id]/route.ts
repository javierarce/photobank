import { NextRequest, NextResponse } from "next/server";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { s3, S3_BUCKET } from "@/lib/s3";
import { db } from "@/db";
import { photos } from "@/db/schema";
import { eq } from "drizzle-orm";

type Context = { params: Promise<{ id: string }> };

const SUFFIXES = [
  "_128.jpg",
  "_128.webp",
  "_640.jpg",
  "_640.webp",
  "_1280.jpg",
  "_1280.webp",
  "_2880.jpg",
  "_2880.webp",
];

// PATCH - move or rename a photo
export async function PATCH(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const body = await request.json();
  const { folder: newFolder, filename: newFilename } = body;

  const [photo] = await db
    .select()
    .from(photos)
    .where(eq(photos.id, id));

  if (!photo) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const folder = newFolder ?? photo.folder;
  const filename = newFilename ?? photo.filename;
  const newS3Key = `${folder}/${filename}`;

  if (newS3Key === photo.s3Key) {
    return NextResponse.json({ photo });
  }

  const oldBase = photo.s3Key.replace(/\.[^.]+$/, "");
  const newBase = newS3Key.replace(/\.[^.]+$/, "");

  // Copy original
  await s3.send(
    new CopyObjectCommand({
      Bucket: S3_BUCKET,
      CopySource: `${S3_BUCKET}/${photo.s3Key}`,
      Key: newS3Key,
    })
  );

  // Copy all variants
  for (const suffix of SUFFIXES) {
    try {
      await s3.send(
        new CopyObjectCommand({
          Bucket: S3_BUCKET,
          CopySource: `${S3_BUCKET}/${oldBase}${suffix}`,
          Key: `${newBase}${suffix}`,
        })
      );
    } catch {
      // Variant may not exist yet
    }
  }

  // Delete old files
  await s3.send(
    new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: photo.s3Key })
  );
  for (const suffix of SUFFIXES) {
    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: S3_BUCKET,
          Key: `${oldBase}${suffix}`,
        })
      );
    } catch {
      // Ignore missing variants
    }
  }

  // Update DB
  const [updated] = await db
    .update(photos)
    .set({ folder, filename, s3Key: newS3Key, updatedAt: new Date() })
    .where(eq(photos.id, id))
    .returning();

  return NextResponse.json({ photo: updated });
}

// DELETE - delete a photo and all its variants
export async function DELETE(_request: NextRequest, context: Context) {
  const { id } = await context.params;

  const [photo] = await db
    .select()
    .from(photos)
    .where(eq(photos.id, id));

  if (!photo) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const base = photo.s3Key.replace(/\.[^.]+$/, "");

  // Delete original + all variants from S3
  const keysToDelete = [photo.s3Key, ...SUFFIXES.map((s) => `${base}${s}`)];

  await Promise.all(
    keysToDelete.map((Key) =>
      s3
        .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key }))
        .catch(() => {})
    )
  );

  // Delete from DB (cascades to photo_tags)
  await db.delete(photos).where(eq(photos.id, id));

  return NextResponse.json({ deleted: true });
}
