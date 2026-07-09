import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { photos, tags, photoTags } from "@/db/schema";
import { sql, eq, ilike, or, and, inArray } from "drizzle-orm";

/** Escape LIKE wildcards so a query like "100%" matches literally. */
function likePattern(term: string) {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();
  const tag = request.nextUrl.searchParams.get("tag")?.trim();
  const camera = request.nextUrl.searchParams.get("camera")?.trim();

  if (!q && !tag && !camera) {
    return NextResponse.json({ photos: [] });
  }

  const conditions = [];

  if (q) {
    const pattern = likePattern(q);
    const taggedByQ = db
      .select({ photoId: photoTags.photoId })
      .from(photoTags)
      .innerJoin(tags, eq(photoTags.tagId, tags.id))
      .where(ilike(tags.name, pattern));

    conditions.push(
      or(
        ilike(photos.filename, pattern),
        ilike(photos.folder, pattern),
        ilike(photos.cameraMake, pattern),
        ilike(photos.cameraModel, pattern),
        ilike(photos.lens, pattern),
        inArray(photos.id, taggedByQ)
      )
    );
  }

  if (camera) {
    const pattern = likePattern(camera);
    conditions.push(
      or(
        ilike(photos.cameraMake, pattern),
        ilike(photos.cameraModel, pattern)
      )
    );
  }

  if (tag) {
    // Find photo IDs that have this tag
    const taggedPhotos = db
      .select({ photoId: photoTags.photoId })
      .from(photoTags)
      .innerJoin(tags, eq(photoTags.tagId, tags.id))
      .where(ilike(tags.name, likePattern(tag)));

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
