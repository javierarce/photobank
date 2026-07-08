import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tags } from "@/db/schema";
import { upsertTag } from "@/lib/tags";

export async function GET() {
  const allTags = await db.select().from(tags).orderBy(tags.name);
  return NextResponse.json({ tags: allTags });
}

export async function POST(request: NextRequest) {
  const { name } = await request.json();

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const { tag, created } = await upsertTag(name.trim());
  return NextResponse.json({ tag }, { status: created ? 201 : 200 });
}
