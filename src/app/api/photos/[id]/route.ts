import { NextRequest, NextResponse } from "next/server";
import { CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { s3, S3_BUCKET } from "@/lib/s3";
import {
  VARIANT_SUFFIXES,
  baseKey,
  encodeKey,
  sanitizeFilename,
  sanitizeFolder,
} from "@/lib/keys";
import { db } from "@/db";
import { photos } from "@/db/schema";
import { eq, and } from "drizzle-orm";

type Context = { params: Promise<{ id: string }> };

function copySource(key: string) {
  return `${S3_BUCKET}/${encodeKey(key)}`;
}

// PATCH - move or rename a photo
export async function PATCH(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const body = await request.json();

  const folder =
    body.folder !== undefined ? sanitizeFolder(body.folder) : undefined;
  if (folder === null) {
    return NextResponse.json({ error: "Invalid folder" }, { status: 400 });
  }
  const filename =
    body.filename !== undefined ? sanitizeFilename(body.filename) : undefined;
  if (filename === null) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const [photo] = await db.select().from(photos).where(eq(photos.id, id));

  if (!photo) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const newFolder = folder ?? photo.folder;
  const newFilename = filename ?? photo.filename;
  const newS3Key = `${newFolder}/${newFilename}`;

  if (newS3Key === photo.s3Key) {
    return NextResponse.json({ photo });
  }

  // Refuse to move onto another photo — the copy would overwrite its S3
  // objects before the DB unique constraint had a chance to complain.
  const [occupant] = await db
    .select({ id: photos.id })
    .from(photos)
    .where(and(eq(photos.folder, newFolder), eq(photos.filename, newFilename)));

  if (occupant && occupant.id !== id) {
    return NextResponse.json(
      { error: "A photo with that name already exists in the target folder" },
      { status: 409 }
    );
  }

  const oldBase = baseKey(photo.s3Key);
  const newBase = baseKey(newS3Key);

  // Copy original; if this fails nothing has been touched yet
  await s3.send(
    new CopyObjectCommand({
      Bucket: S3_BUCKET,
      CopySource: copySource(photo.s3Key),
      Key: newS3Key,
    })
  );

  // Copy variants, remembering which ones made it (a variant may not exist
  // yet if the photo is still processing)
  const copiedSuffixes = (
    await Promise.all(
      VARIANT_SUFFIXES.map(async (suffix) => {
        try {
          await s3.send(
            new CopyObjectCommand({
              Bucket: S3_BUCKET,
              CopySource: copySource(`${oldBase}${suffix}`),
              Key: `${newBase}${suffix}`,
            })
          );
          return suffix;
        } catch {
          return null;
        }
      })
    )
  ).filter((s): s is string => s !== null);

  // Point the DB at the new location before deleting anything, so a failure
  // here leaves the photo intact at its old key
  const [updated] = await db
    .update(photos)
    .set({
      folder: newFolder,
      filename: newFilename,
      s3Key: newS3Key,
      updatedAt: new Date(),
    })
    .where(eq(photos.id, id))
    .returning();

  // Delete the old original and only the variants we actually copied
  const oldKeys = [
    photo.s3Key,
    ...copiedSuffixes.map((suffix) => `${oldBase}${suffix}`),
  ];
  await Promise.all(
    oldKeys.map((Key) =>
      s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key })).catch(() => {})
    )
  );

  return NextResponse.json({ photo: updated });
}

// DELETE - delete a photo and all its variants
export async function DELETE(_request: NextRequest, context: Context) {
  const { id } = await context.params;

  const [photo] = await db.select().from(photos).where(eq(photos.id, id));

  if (!photo) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const base = baseKey(photo.s3Key);
  const keysToDelete = [
    photo.s3Key,
    ...VARIANT_SUFFIXES.map((suffix) => `${base}${suffix}`),
  ];

  await Promise.all(
    keysToDelete.map((Key) =>
      s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key })).catch(() => {})
    )
  );

  // Delete from DB (cascades to photo_tags)
  await db.delete(photos).where(eq(photos.id, id));

  return NextResponse.json({ deleted: true });
}
