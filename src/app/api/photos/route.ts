import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { photos } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const folder = request.nextUrl.searchParams.get("folder");

  if (!folder) {
    return NextResponse.json({ error: "folder is required" }, { status: 400 });
  }

  const results = await db
    .select()
    .from(photos)
    .where(eq(photos.folder, folder))
    .orderBy(desc(photos.createdAt));

  return NextResponse.json({ photos: results });
}
