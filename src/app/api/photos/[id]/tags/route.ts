import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { tags, photoTags } from "@/db/schema";

type Context = { params: Promise<{ id: string }> };

// GET - list tags for a photo
export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params;

  const result = await db
    .select({ id: tags.id, name: tags.name })
    .from(photoTags)
    .innerJoin(tags, eq(photoTags.tagId, tags.id))
    .where(eq(photoTags.photoId, id));

  return NextResponse.json({ tags: result });
}

// POST - add a tag to a photo (creates tag if it doesn't exist)
export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const { name } = await request.json();

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  // Upsert the tag
  let [tag] = await db
    .insert(tags)
    .values({ name: name.trim() })
    .onConflictDoNothing()
    .returning();

  if (!tag) {
    [tag] = await db
      .select()
      .from(tags)
      .where(eq(tags.name, name.trim()));
  }

  // Link photo to tag
  await db
    .insert(photoTags)
    .values({ photoId: id, tagId: tag.id })
    .onConflictDoNothing();

  return NextResponse.json({ tag }, { status: 201 });
}

// DELETE - remove a tag from a photo
export async function DELETE(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const { tagId } = await request.json();

  await db
    .delete(photoTags)
    .where(and(eq(photoTags.photoId, id), eq(photoTags.tagId, tagId)));

  return NextResponse.json({ deleted: true });
}
