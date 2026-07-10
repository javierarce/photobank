# Photobank

A macOS app for a personal photo archive: originals live in an S3-compatible
bucket, browsing is instant thanks to a local catalog and thumbnail cache.
Drop photos in, organize them into folders, tag them, and search everything.

Built with Tauri 2 (Rust core) + React. No server to run — the app talks to
your bucket directly.

## How it works

- **Import**: drop images anywhere (or use the picker). Rust extracts EXIF
  (camera, lens, exposure, GPS), bakes in the orientation, generates
  640/1280/2880 jpg+webp variants preserving the ICC profile, and uploads the
  original plus variants to your bucket.
- **Browse**: photo metadata lives in a local SQLite catalog
  (`~/Library/Application Support/com.photobank.app`); images are served
  through a `photo://` protocol that caches variants on disk
  (`~/Library/Caches/com.photobank.app`). 640px thumbnails are kept forever,
  larger sizes are evicted past a 2 GiB budget — so the grid renders
  instantly, offline included.
- **Durability**: after every change the catalog is exported to
  `photobank-manifest.json` in the bucket. A fresh install rebuilds from it
  (Settings → Rebuild from bucket); buckets written by the old web version
  rebuild from a listing instead.
- **Credentials**: endpoint/region/bucket/key-id in Settings; the secret key
  is stored in an owner-only (0600) file alongside the catalog. Works with AWS
  S3, Cloudflare R2, MinIO, and anything else S3-compatible.

## Development

```bash
npm install
npm run dev:tauri   # compiles the Rust core and launches the app
npm test            # frontend tests (Vitest)
(cd src-tauri && cargo test)  # Rust tests
```

`npm run dev:tauri` is how you launch the app. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow (building a bundle,
scripts, project layout).

## Releasing

Push a `v*` tag — CI builds, signs, notarizes, and publishes `Photobank.dmg`
and the updater feed. See [RELEASING.md](RELEASING.md).
