import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tags } from "@/db/schema";

/** Insert a tag by name, or fetch the existing one on conflict. */
export async function upsertTag(name: string) {
  const [inserted] = await db
    .insert(tags)
    .values({ name })
    .onConflictDoNothing()
    .returning();

  if (inserted) return { tag: inserted, created: true };

  const [existing] = await db.select().from(tags).where(eq(tags.name, name));
  return { tag: existing, created: false };
}
