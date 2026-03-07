import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { photos, tags, photoTags } from "@/db/schema";
import { sql, eq, ilike, or, and, inArray } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();
  const tag = request.nextUrl.searchParams.get("tag")?.trim();
  const camera = request.nextUrl.searchParams.get("camera")?.trim();

  if (!q && !tag && !camera) {
    return NextResponse.json({ photos: [] });
  }

  const conditions = [];

  if (q) {
    const taggedByQ = db
      .select({ photoId: photoTags.photoId })
      .from(photoTags)
      .innerJoin(tags, eq(photoTags.tagId, tags.id))
      .where(ilike(tags.name, `%${q}%`));

    conditions.push(
      or(
        ilike(photos.filename, `%${q}%`),
        ilike(photos.folder, `%${q}%`),
        ilike(photos.cameraMake, `%${q}%`),
        ilike(photos.cameraModel, `%${q}%`),
        ilike(photos.lens, `%${q}%`),
        inArray(photos.id, taggedByQ)
      )
    );
  }

  if (camera) {
    conditions.push(
      or(
        ilike(photos.cameraMake, `%${camera}%`),
        ilike(photos.cameraModel, `%${camera}%`)
      )
    );
  }

  if (tag) {
    // Find photo IDs that have this tag
    const taggedPhotos = db
      .select({ photoId: photoTags.photoId })
      .from(photoTags)
      .innerJoin(tags, eq(photoTags.tagId, tags.id))
      .where(ilike(tags.name, `%${tag}%`));

    conditions.push(inArray(photos.id, taggedPhotos));
  }

  const results = await db
    .select()
    .from(photos)
    .where(and(...conditions))
    .orderBy(sql`${photos.createdAt} desc`)
    .limit(200);

  return NextResponse.json({ photos: results });
}
