# Releasing Photobank

Releases are cut by pushing a `v*` tag. That triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which builds
the universal macOS app, signs + notarizes it with the GitHub Secrets (no local
signing needed), and publishes `Photobank.dmg` plus `latest.json` (for the
in-app updater) to a GitHub release.

## Cut the release

```bash
npm run release
```

[`scripts/release.mjs`](scripts/release.mjs) drives the whole thing: it shows
what changed since the last release, asks for the new version, opens your
editor for the release notes (pre-filled with the commit subjects), runs lint +
typecheck + tests, then bumps, commits, tags, and pushes.

Pushing the tag is what ships. Before it gets there the script refuses to
continue if the working tree is dirty, if you are not on `main`, if `main` is
out of sync with `origin`, if the version files disagree with each other, if
the tag already exists, or if the notes come back empty.

| Flag | Effect |
| --- | --- |
| `--dry-run` | Show everything, write nothing |
| `--no-fetch` | Skip the `origin` sync check |
| `--any-branch` | Release from somewhere other than `main` |
| `--skip-checks` | Skip lint + typecheck + tests |

Flags go after `--`, e.g. `npm run release -- --dry-run`.

> [!NOTE]
> Keep the notes **plain text**. The in-app updater renders them as raw text,
> so Markdown like `**bold**` or `##` shows up literally. Use a plain headline
> line and `-` bullets. The first line is the release title; leave a blank line,
> then the bullets.

The notes you write are saved to a temp file and only deleted once the tag is
pushed — so if a run aborts, the next one re-opens what you wrote instead of a
blank template.

## Watch the build

```bash
gh run watch
```

The job builds, signs, notarizes, and staples the app and dmg. It publishes only
after notarization succeeds — until then the release stays a **draft**, so a
failed build never ships a broken release.

If it fails:

```bash
gh run view <run-id> --log-failed
```

- **"The timestamp service is not available"** → transient Apple outage. Just
  retry; it's always safe because a failed run never leaves a published release:
  ```bash
  gh run rerun <run-id>
  ```

## Verify the release

Confirm `latest.json` reports the version you just cut:

```bash
curl -sL https://github.com/javierarce/photobank/releases/latest/download/latest.json | jq -r .version
```

It should print `X.Y.Z`. If it prints the previous version, the tag was cut
before the bump commit — see the warning under [By hand](#by-hand).

To fix the GitHub release body afterwards (this does **not** touch
`latest.json`, so prefer getting the notes right up front):

```bash
gh release edit vX.Y.Z --notes "Photobank X.Y.Z — short title
- Did X
- Fixed Y"
```

## By hand

Only needed if the script cannot run.

> [!IMPORTANT]
> **The version bump must be committed _before_ you tag, and the tag must point
> at that bump commit.** `tauri-action` reads the version straight out of
> `tauri.conf.json` at the tagged commit and writes it into `latest.json`. If
> you tag first and bump afterwards, `latest.json` carries the old version, the
> updater thinks nothing changed, and everyone is stuck on the previous release.

1. `git checkout main && git pull` — everything for the release must be merged.
2. Bump the version everywhere it appears. All five must match:

   | File | Field |
   | --- | --- |
   | `package.json` | `"version"` |
   | `package-lock.json` | `"version"` (twice: root and `packages[""]`) |
   | `src-tauri/tauri.conf.json` | `"version"` |
   | `src-tauri/Cargo.toml` | `version` |
   | `src-tauri/Cargo.lock` | the `[[package]]` block for `name = "photobank"` |

   `(cd src-tauri && cargo check)` rewrites `Cargo.lock` to match `Cargo.toml`,
   so that one does not need editing by hand.

3. `git commit -am "vX.Y.Z" && git push origin main`
4. Tag the bump commit — annotated, with the notes in its message:

   ```bash
   git tag -a vX.Y.Z -m "Short title" -m "- Did X" -m "- Fixed Y"
   git push origin vX.Y.Z
   ```

   The tag message becomes both the release notes and the updater's "what's
   new" text. A lightweight tag (no message) falls back to commit subjects
   since the previous tag.

## One-time setup (already done, for reference)

- Updater keypair: `npx tauri signer generate -w ~/.tauri/photobank.key`
  (private key stays on this machine; **never** commit it). Its public key
  lives in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, and the
  private key + password are the `TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repo secrets.
- Apple signing/notarization secrets (`APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`,
  `APPLE_API_KEY_ID`, `APPLE_API_KEY`) are the same Developer ID identity used
  by ankitron — copy the values from that repo's secrets source.
