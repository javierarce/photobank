# Photobank

Personal photo management: upload photos to S3, process them into web-ready
variants, organize them into folders, tag them, and search everything. Built
to manage blog images and double as a personal archive.

## Stack

- **Next.js** (App Router) — UI + API routes
- **Postgres + Drizzle** — photo metadata, folders, tags
- **Redis + BullMQ** — background image processing queue
- **sharp** — resizing, EXIF extraction, format conversion
- **S3** (or any S3-compatible store) — originals and variants

## How it works

1. The browser asks `/api/upload` for presigned URLs and PUTs files straight
   to S3 (the server never proxies image bytes).
2. `/api/upload/confirm` queues a processing job per photo.
3. The worker downloads the original, extracts EXIF (camera, lens, exposure,
   GPS, capture date), and generates variants: 640/1280/2880 px in JPEG and
   WebP, auto-oriented, with color profiles preserved.
4. Variants are served via `NEXT_PUBLIC_CDN_URL` when set, otherwise through
   `/api/images` presigned redirects.

S3 layout: `folder/name.jpg` (original) plus `folder/name_<width>.<ext>`
variants alongside it.

## Setup

Requirements: Node 20+, pnpm, Postgres, Redis, an S3 bucket.

```bash
pnpm install
cp .env.example .env.local   # fill in real values
createdb photobank
pnpm db:migrate
```

## Running

```bash
pnpm dev      # Next.js app on http://localhost:3000
pnpm worker   # image processing worker (separate terminal)
```

Both must be running; without the worker, uploads stay in "pending".

## Other commands

```bash
pnpm test             # run the test suite
pnpm db:generate      # generate a migration after editing src/db/schema.ts
pnpm db:studio        # browse the database
pnpm requeue          # re-queue photos stuck in pending/failed
pnpm requeue --all    # re-process every photo (after pipeline changes)
```

## Notes

- **Auth**: setting `AUTH_PASSWORD` protects the whole app (pages and API)
  with HTTP Basic auth (`AUTH_USERNAME`, default `admin`). When unset, the
  app is open — fine locally, not on a server. If you use a public CDN for
  images, those URLs remain public by design.
- Deleting or moving a photo cleans up all its S3 variants; moves refuse to
  overwrite an existing photo in the target folder.
