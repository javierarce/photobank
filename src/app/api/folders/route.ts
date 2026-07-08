import { NextResponse } from "next/server";
import { db } from "@/db";
import { photos } from "@/db/schema";
import { sql } from "drizzle-orm";

export async function GET() {
  const folders = await db
    .select({
      folder: photos.folder,
      count: sql<number>`count(*)::int`,
    })
    .from(photos)
    .groupBy(photos.folder)
    .orderBy(photos.folder);

  return NextResponse.json({ folders });
}
