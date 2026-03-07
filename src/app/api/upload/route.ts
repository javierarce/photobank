import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3, S3_BUCKET } from "@/lib/s3";
import { db } from "@/db";
import { photos } from "@/db/schema";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const files: { filename: string; contentType: string; size: number }[] =
      body.files;
    const folder: string = body.folder || "inbox";

    if (!files?.length) {
      return NextResponse.json(
        { error: "No files provided" },
        { status: 400 }
      );
    }

    console.log(`[upload] ${files.length} file(s) to folder "${folder}"`);

    const results = await Promise.all(
      files.map(async (file) => {
        const s3Key = `${folder}/${file.filename}`;

        const command = new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          ContentType: file.contentType,
        });

        console.log(`[upload] Generating presigned URL for ${s3Key}`);
        const presignedUrl = await getSignedUrl(s3, command, {
          expiresIn: 3600,
        });

        console.log(`[upload] Inserting DB record for ${file.filename}`);
        const [photo] = await db
          .insert(photos)
          .values({
            filename: file.filename,
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

        console.log(`[upload] Created photo ${photo.id}`);

        return {
          id: photo.id,
          filename: file.filename,
          presignedUrl,
        };
      })
    );

    return NextResponse.json({ uploads: results });
  } catch (error) {
    console.error("[upload] Error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
