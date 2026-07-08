import "./env";
import { db } from "../db";
import { photos } from "../db/schema";
import { inArray } from "drizzle-orm";
import { imageQueue } from "../lib/queue";

// Usage:
//   pnpm requeue          re-queue photos stuck in pending/failed
//   pnpm requeue --all    re-process every photo (e.g. after pipeline changes)
async function main() {
  const all = process.argv.includes("--all");

  const query = db
    .select({ id: photos.id, s3Key: photos.s3Key })
    .from(photos);

  const rows = all
    ? await query
    : await query.where(inArray(photos.processingStatus, ["pending", "failed"]));

  console.log(`Found ${rows.length} photos to requeue${all ? " (all)" : ""}`);

  for (const photo of rows) {
    await imageQueue.add("process", { photoId: photo.id, s3Key: photo.s3Key });
    console.log(`Queued: ${photo.s3Key}`);
  }

  console.log("Done");
  process.exit(0);
}

main();
