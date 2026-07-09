import { Queue } from "bullmq";
import { redisConnection } from "./redis";

export const imageQueue = new Queue("image-processing", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 500 },
  },
});
