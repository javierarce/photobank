// The version-carrying files and the semver helpers used by scripts/release.mjs.
// Split out of the script itself so the tests can check the patterns still
// match — a release that silently skips a file leaves the app reporting the
// wrong version, and nothing else in the build catches it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every file carrying the app version. Each pattern has three groups — prefix,
// version, suffix — so a replace only ever rewrites the version itself, and the
// old value can be checked against package.json first. The regexes are
// deliberately non-global: only the first (top-level) match.
export const VERSION_SITES = [
  {
    path: "package.json",
    // Top-level "version" key. It is the first one in the file — dependency
    // pins are "name": "^1.2.3", never a "version" key.
    patterns: [/("version": ")([^"]+)(")/],
  },
  { path: "src-tauri/tauri.conf.json", patterns: [/("version": ")([^"]+)(")/] },
  // Anchored to the package block so a dependency's version is never hit.
  {
    path: "src-tauri/Cargo.toml",
    patterns: [/(\[package\]\r?\nname = "photobank"\r?\nversion = ")([^"]+)(")/],
  },
  {
    path: "src-tauri/Cargo.lock",
    patterns: [
      /(\[\[package\]\]\r?\nname = "photobank"\r?\nversion = ")([^"]+)(")/,
    ],
  },
  {
    // npm writes the version twice: once at the root, once in packages[""].
    // Both are anchored to the name above them so no dependency entry matches.
    path: "package-lock.json",
    patterns: [
      /(^\{\r?\n\s*"name": "photobank",\r?\n\s*"version": ")([^"]+)(")/,
      /("": \{\r?\n\s*"name": "photobank",\r?\n\s*"version": ")([^"]+)(")/,
    ],
  },
];

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? m.slice(1, 4).map(Number) : null;
}

export function bumpVersion(v, kind) {
  const [major, minor, patch] = parseVersion(v);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export const isNewer = (next, current) => {
  const a = parseVersion(next);
  const b = parseVersion(current);
  return a.some((n, i) => n > b[i] && a.slice(0, i).every((x, j) => x === b[j]));
};

// Locate the version in every file, so a pattern that no longer matches (or a
// file left behind by a half-finished release) fails before anything is
// written. Throws on a miss or a mismatch; returns the sites with their file
// contents so the apply step does not have to read them again.
export function readVersionSites(root, expected) {
  return VERSION_SITES.map(({ path, patterns }) => {
    const content = readFileSync(join(root, path), "utf8");
    for (const pattern of patterns) {
      const match = pattern.exec(content);
      if (!match) throw new Error(`Could not find the version in ${path}.`);
      if (match[2] !== expected) {
        throw new Error(
          `${path} is at ${match[2]}, but package.json says ${expected}.\n` +
            `  Versions are out of sync — fix them by hand first.`,
        );
      }
    }
    return { path, patterns, content };
  });
}

export const applyVersion = (content, patterns, version) =>
  patterns.reduce((out, p) => out.replace(p, `$1${version}$3`), content);
