import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tags } from "@/db/schema";

export async function GET() {
  const allTags = await db.select().from(tags).orderBy(tags.name);
  return NextResponse.json({ tags: allTags });
}

export async function POST(request: NextRequest) {
  const { name } = await request.json();

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const [tag] = await db
    .insert(tags)
    .values({ name: name.trim() })
    .onConflictDoNothing()
    .returning();

  if (!tag) {
    const [existing] = await db
      .select()
      .from(tags)
      .where(eq(tags.name, name.trim()));
    return NextResponse.json({ tag: existing });
  }

  return NextResponse.json({ tag }, { status: 201 });
}
