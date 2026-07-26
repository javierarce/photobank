import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VERSION_SITES,
  parseVersion,
  bumpVersion,
  isNewer,
  readVersionSites,
  applyVersion,
} from "../release-lib.mjs";

// Vitest runs from the project root, which is where the version files live.
const root = resolve(process.cwd());
const currentVersion: string = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
).version;

// The release script rewrites the version by regex. If a file moves, is
// reformatted, or drifts out of sync, the release would ship a half-bumped app
// — and nothing else in the build would notice.
describe("release version sites", () => {
  it("finds the current version in every file that carries it", () => {
    expect(() => readVersionSites(root, currentVersion)).not.toThrow();
  });

  it("rejects a file whose version drifted", () => {
    expect(() => readVersionSites(root, "9.9.9")).toThrow(/out of sync/);
  });

  it("rewrites every occurrence in a file, and nothing else", () => {
    const sites = readVersionSites(root, currentVersion);
    for (const { path, patterns, content } of sites) {
      const bumped = applyVersion(content, patterns, "9.9.9");
      expect(bumped, path).not.toBe(content);
      // Same file, only the version lines changed.
      const before = content.split("\n");
      const changed = bumped
        .split("\n")
        .filter((line: string, i: number) => line !== before[i]);
      expect(changed.length, path).toBe(patterns.length);
      for (const line of changed) expect(line, path).toContain("9.9.9");
    }
  });

  it("covers package.json, tauri.conf.json, and both Cargo files", () => {
    expect(VERSION_SITES.map((s) => s.path)).toEqual([
      "package.json",
      "src-tauri/tauri.conf.json",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
      "package-lock.json",
    ]);
  });
});

describe("version helpers", () => {
  it("parses only x.y.z", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("v1.2.3")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("1.2.3-beta")).toBeNull();
  });

  it("bumps each component and resets the ones below it", () => {
    expect(bumpVersion("0.4.2", "patch")).toBe("0.4.3");
    expect(bumpVersion("0.4.2", "minor")).toBe("0.5.0");
    expect(bumpVersion("0.4.2", "major")).toBe("1.0.0");
  });

  it("only accepts a strictly newer version", () => {
    expect(isNewer("0.4.1", "0.4.0")).toBe(true);
    expect(isNewer("0.5.0", "0.4.9")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.4.0", "0.4.0")).toBe(false);
    expect(isNewer("0.3.9", "0.4.0")).toBe(false);
    // A higher patch does not make an older minor newer.
    expect(isNewer("0.3.9", "0.4.1")).toBe(false);
  });
});
