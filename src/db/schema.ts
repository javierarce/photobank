import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  real,
  uniqueIndex,
  primaryKey,
  pgEnum,
} from "drizzle-orm/pg-core";

export const processingStatusEnum = pgEnum("processing_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const photos = pgTable(
  "photos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    filename: text("filename").notNull(),
    s3Key: text("s3_key").notNull(),
    folder: text("folder").notNull().default("inbox"),
    mimeType: text("mime_type"),
    fileSize: integer("file_size"),
    width: integer("width"),
    height: integer("height"),
    processingStatus: processingStatusEnum("processing_status")
      .notNull()
      .default("pending"),

    // EXIF metadata
    cameraMake: text("camera_make"),
    cameraModel: text("camera_model"),
    lens: text("lens"),
    focalLength: text("focal_length"),
    aperture: text("aperture"),
    shutterSpeed: text("shutter_speed"),
    iso: integer("iso"),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    gpsLatitude: real("gps_latitude"),
    gpsLongitude: real("gps_longitude"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("photos_folder_filename_idx").on(table.folder, table.filename),
  ]
);

export const tags = pgTable("tags", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const photoTags = pgTable(
  "photo_tags",
  {
    photoId: uuid("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.photoId, table.tagId] })]
);
