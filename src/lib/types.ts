import type { InferSelectModel } from "drizzle-orm";
import type { photos } from "@/db/schema";

type PhotoRow = InferSelectModel<typeof photos>;

/** Date columns arrive as ISO strings once they cross the JSON boundary. */
type Serialized<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | null
      ? string | null
      : T[K];
};

export type Photo = Serialized<PhotoRow>;
