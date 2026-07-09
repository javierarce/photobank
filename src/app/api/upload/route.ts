import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3, S3_BUCKET } from "@/lib/s3";
import { sanitizeFilename, sanitizeFolder } from "@/lib/keys";
import { db } from "@/db";
import { photos } from "@/db/schema";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const files: { filename: string; contentType: string; size: number }[] =
      body.files;

    if (!files?.length) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    const folder = sanitizeFolder(body.folder ?? "inbox");
    if (!folder) {
      return NextResponse.json({ error: "Invalid folder" }, { status: 400 });
    }

    const sanitized = files.map((file) => ({
      ...file,
      filename: sanitizeFilename(file.filename),
    }));

    const invalid = sanitized.find((f) => !f.filename);
    if (invalid) {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }

    const results = await Promise.all(
      sanitized.map(async (file) => {
        const filename = file.filename!;
        const s3Key = `${folder}/${filename}`;

        const presignedUrl = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: s3Key,
            ContentType: file.contentType,
          }),
          { expiresIn: 3600 }
        );

        const [photo] = await db
          .insert(photos)
          .values({
            filename,
            s3Key,
            folder,
            mimeType: file.contentType,
            fileSize: file.size,
          })
          .onConflictDoUpdate({
            target: [photos.folder, photos.filename],
            set: {
              mimeType: file.contentType,
              fileSize: file.size,
              processingStatus: "pending",
              updatedAt: new Date(),
            },
          })
          .returning({ id: photos.id });

        return {
          id: photo.id,
          filename,
          presignedUrl,
        };
      })
    );

    return NextResponse.json({ uploads: results });
  } catch (error) {
    console.error("[upload] Error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
