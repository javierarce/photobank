import { NextRequest, NextResponse } from "next/server";
import { imageQueue } from "@/lib/queue";
import { db } from "@/db";
import { photos } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const photoIds: string[] = body.photoIds;

  if (!photoIds?.length) {
    return NextResponse.json({ error: "No photoIds provided" }, { status: 400 });
  }

  const results = await Promise.all(
    photoIds.map(async (photoId) => {
      const [photo] = await db
        .select({ id: photos.id, s3Key: photos.s3Key })
        .from(photos)
        .where(eq(photos.id, photoId));

      if (!photo) return { photoId, queued: false };

      await imageQueue.add("process", {
        photoId: photo.id,
        s3Key: photo.s3Key,
      });

      return { photoId, queued: true };
    })
  );

  return NextResponse.json({ results });
}
