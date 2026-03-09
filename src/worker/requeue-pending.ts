import "./env";
import { db } from "../db";
import { photos } from "../db/schema";
import { inArray } from "drizzle-orm";
import { imageQueue } from "../lib/queue";

async function main() {
  const pending = await db
    .select({ id: photos.id, s3Key: photos.s3Key })
    .from(photos)
    .where(inArray(photos.processingStatus, ["pending", "failed"]));

  console.log(`Found ${pending.length} photos to requeue`);

  for (const photo of pending) {
    await imageQueue.add("process", { photoId: photo.id, s3Key: photo.s3Key });
    console.log(`Queued: ${photo.s3Key}`);
  }

  console.log("Done");
  process.exit(0);
}

main();
