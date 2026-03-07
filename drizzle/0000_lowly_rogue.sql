CREATE TYPE "public"."processing_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "photo_tags" (
	"photo_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "photo_tags_photo_id_tag_id_pk" PRIMARY KEY("photo_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"s3_key" text NOT NULL,
	"folder" text DEFAULT 'inbox' NOT NULL,
	"mime_type" text,
	"file_size" integer,
	"width" integer,
	"height" integer,
	"processing_status" "processing_status" DEFAULT 'pending' NOT NULL,
	"camera_make" text,
	"camera_model" text,
	"lens" text,
	"focal_length" text,
	"aperture" text,
	"shutter_speed" text,
	"iso" integer,
	"taken_at" timestamp with time zone,
	"gps_latitude" real,
	"gps_longitude" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "photo_tags" ADD CONSTRAINT "photo_tags_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_tags" ADD CONSTRAINT "photo_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "photos_folder_filename_idx" ON "photos" USING btree ("folder","filename");