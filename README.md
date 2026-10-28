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
  original plus variants to your bucket. WebP variants preserve transparency;
  JPEG variants flatten transparent areas onto white.
- **Browse**: photo metadata lives in a local SQLite catalog
  (`~/Library/Application Support/com.photobank.app`); images are served
  through a `photo://` protocol that caches variants on disk
  (`~/Library/Caches/com.photobank.app`). 640px thumbnails are kept forever,
  larger sizes are evicted past a 2 GiB budget — so the grid renders
  instantly, offline included. Cached objects are isolated by bucket and
  rebuild, with case-sensitive object names preserved on macOS.
- **Durability**: after every change the catalog is exported to
  `photobank-manifest.json` in the bucket. A fresh install rebuilds from it
  (Settings → Rebuild from bucket); buckets written by the old web version
  rebuild from a listing instead. Pending backups survive restarts and retry
  after failures; Settings shows their status. Rebuild requires confirmation,
  saves a local SQLite recovery copy in `catalog-backups/`, and backs up pending
  edits before replacing a catalog from the same bucket.
- **Repair**: Settings checks all six variants and can retry failed imports.
  On upgrading, old thumbnail-health flags are rechecked when you next run
  Generate; complete sets only need metadata requests. No repair runs just
  because the database was upgraded.
- **Credentials**: endpoint/region/bucket/key-id in Settings; the secret key
  is stored in an owner-only (0600) file alongside the catalog. Works with AWS
  S3, Cloudflare R2, MinIO, and anything else S3-compatible.

## Search

The search box takes typed filters in the form `field:value`, alongside plain
free text. Multiple terms are ANDed together, so `folder:trips camera:fuji`
matches Fuji photos in the `trips` folder. Free text (e.g. `barcelona`) matches
filenames, folders, camera, lens, and tags at once.

| Filter | Matches | Example |
| --- | --- | --- |
| `tag:` | Has a tag (`tag:none` = untagged) | `tag:sunset` |
| `folder:` | In a folder | `folder:trips` |
| `filename:` / `name:` | Filename contains | `filename:beach` |
| `camera:` | Camera make or model | `camera:fuji` |
| `make:` | Camera manufacturer | `make:canon` |
| `model:` | Camera model | `model:x100v` |
| `lens:` | Lens | `lens:35mm` |
| `iso:` | ISO — exact, range, or `>=`/`<=` | `iso:>=800`, `iso:100-400` |
| `f:` / `aperture:` | Aperture | `f:1.8` |
| `shutter:` / `speed:` | Shutter speed | `shutter:1/250` |
| `focal:` | Focal length | `focal:50` |
| `date:` / `year:` | Date taken — year/month/day, or `A..B` range | `date:2024`, `date:2023..2024` |

- **Exclude** a term with a leading `-`, e.g. `-tag:draft`.
- **Quote** values that contain spaces: `make:"leica m"`.
- **Ranges** (`iso:100-400`, `date:2023..2024`) and comparisons (`iso:>=800`,
  `date:>=2024`) work for ISO and dates.
- Press **↓** in an empty search box to browse all available filters, and the
  box autocompletes tags, folders, and cameras as you type.

EXIF is loaded on demand, so metadata filters (camera, ISO, aperture, date, …)
only match photos whose info has been loaded — the results view flags this when
such a filter is active.

Results load in pages of 200. Use **Load more results** to continue; Select all
applies to the results currently loaded.

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

Debug builds use a separate `development/` subdirectory for the catalog,
settings, credentials, and cache. They start unconfigured and do not inherit
the installed app's bucket. Use a disposable test bucket for manual testing;
do not copy production credentials into development storage. Release builds
continue using the existing installed app's directories.

Automated tests use mocked frontend APIs, temporary files/databases, and a
loopback S3 fixture with dummy credentials. They do not require a real bucket
or launch the desktop app.

## Releasing

`npm run release` bumps the version, takes your release notes, and pushes the
tag that makes CI build, sign, notarize, and publish `Photobank.dmg` plus the
updater feed. See [RELEASING.md](RELEASING.md).

## License

[GNU General Public License v3.0](LICENSE).
