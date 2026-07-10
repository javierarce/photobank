# Contributing

## Getting started

Install dependencies:

```bash
npm install
```

You need the **Rust toolchain** (via [rustup](https://rustup.rs/)) and Xcode's
command-line tools (`xcode-select --install`) for the native build.

## Running the app

The normal way to launch Photobank while developing — this compiles the Rust
core (debug) and opens the native window, with the frontend hot-reloading:

```bash
npm run dev:tauri
```

That is the launch command. You don't build a bundle to run the app locally.

To iterate on just the UI in a browser tab (no native window, Tauri `invoke`
calls won't work), run the plain Vite dev server:

```bash
npm run dev        # http://localhost:5173
```

On first launch the app opens **Settings** and stays there until you point it
at an S3-compatible bucket (endpoint/region/bucket/key-id, and a secret access
key). The secret is written to an owner-only (0600) file next to the catalog in
`~/Library/Application Support/com.photobank.app/`; everything else lives in
`settings.json` in the same folder.

## Building a distributable bundle

```bash
npm run build:tauri
```

This produces `src-tauri/target/release/bundle/macos/Photobank.app` and a
`.dmg`. Launch the built app with:

```bash
open src-tauri/target/release/bundle/macos/Photobank.app
```

The locally built app is **ad-hoc signed** — fine on your own Mac, but not
Developer-ID signed or notarized, so it isn't meant for distribution. A local
`build:tauri` also ends with a harmless `no private key … TAURI_SIGNING_PRIVATE_KEY`
error from the updater-signing step; the `.app` and `.dmg` are still produced.
Real signing, notarization, and updater artifacts happen in CI when you push a
`v*` tag — see [RELEASING.md](RELEASING.md).

## Scripts

- `npm run dev:tauri` — run the native desktop app (this is how you launch it)
- `npm run dev` — Vite dev server only (browser UI)
- `npm run build` — production build of the web assets (Vite → `dist/`)
- `npm run build:tauri` — build and bundle the native app (`.app`/`.dmg`)
- `npm run preview` — preview the production web build
- `npm run lint` — run ESLint
- `npm test` — run the Vitest unit suite (`npm run test:watch` for watch mode)
- `npm run icons` — regenerate the app icon + dmg background from `build/*.svg`
- `(cd src-tauri && cargo test)` — run the Rust unit tests

## Tech stack

- [Tauri v2](https://tauri.app/) (Rust) for the native desktop shell + all
  storage/S3/image work
- [Vite](https://vite.dev/) + [React 19](https://react.dev/) +
  [React Router](https://reactrouter.com/)
- [Tailwind CSS 4](https://tailwindcss.com/)
- SQLite (rusqlite) catalog, `aws-sdk-s3` for the bucket, `image` +
  `fast_image_resize` + `webp` for the import pipeline

## Project structure

```
src/                  Frontend (Vite + React)
  main.tsx            App entry (router + global styles)
  App.tsx             Routes + first-run/update checks
  routes/             Route views (home, folder, search, settings)
  components/         UI (photo grid, lightbox, tags, search, header)
  hooks/              use-upload (native drag-drop), use-photo-actions
  lib/                api.ts (Tauri invoke wrapper), image-url.ts, keys.ts
src-tauri/            Native shell (Rust)
  src/main.rs         Tauri app, command registration, photo:// protocol
  src/commands.rs     Read commands (folders, photos, search, tags)
  src/db.rs           SQLite catalog schema + row mapping
  src/settings.rs     S3 config + secret-file storage + client
  src/pipeline.rs     Decode → EXIF → resize → jpg/webp variants
  src/import.rs       Import orchestration + progress events
  src/photos.rs       Move/rename, delete, export
  src/protocol.rs     photo:// disk cache with S3 fetch-through
  src/manifest.rs     Catalog backup + rebuild-from-bucket
build/                icon.svg, dmg-background.svg (sources)
scripts/generate-icon.mjs   Renders build/*.svg → PNGs
```

## Releasing

See [RELEASING.md](RELEASING.md).
