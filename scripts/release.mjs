#!/usr/bin/env node
// Cuts a release. Bumps the version in every file that carries it, opens an
// editor for the release notes, commits, tags, and pushes.
//
// Pushing the tag is what actually ships: .github/workflows/release.yml fires
// on any `v*` tag and builds, signs, notarizes, and publishes the app. It reads
// the release notes from the *annotated* tag's message (subject + body) and
// copies them into both the GitHub release body and latest.json's `notes`,
// which is what the in-app updater shows. That's why the tag here is always
// annotated (`-a`) with hand-written notes — a lightweight tag would silently
// fall back to raw commit subjects.
//
//   npm run release             # interactive
//   npm run release -- --dry-run   # show everything, write nothing
//
// Flags: --dry-run, --no-fetch (skip the origin sync check),
//        --any-branch (release from somewhere other than main),
//        --skip-checks (skip lint + typecheck + tests).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSION_SITES,
  parseVersion,
  bumpVersion,
  isNewer,
  readVersionSites,
  applyVersion,
} from "./release-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const noFetch = args.has("--no-fetch");
const anyBranch = args.has("--any-branch");
const skipChecks = args.has("--skip-checks");

const RELEASE_BRANCH = "main";
const REMOTE = "origin";

const NOTES_TEMPLATE_HELP = `
# Write the release notes above.
#
# The first line is the release title (a short summary of the release, no
# version number — the version is already the tag name). Leave a blank line,
# then describe the changes as bullets, in prose, for people who do not read
# commit logs.
#
# The commit subjects since the last release are pre-filled as a starting
# point. Rewrite them — these notes are what users see in the GitHub release
# and in the in-app updater.
#
# Lines starting with # are ignored. An empty message aborts the release.
`.trimStart();

const bail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

function git(gitArgs, { allowFailure = false } = {}) {
  const r = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) {
    if (allowFailure) return null;
    bail(`git ${gitArgs.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function run(cmd, cmdArgs) {
  return spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit" }).status === 0;
}

// Prompts read through readline's async iterator rather than question(), which
// races on non-TTY input: piped lines are all emitted at once, so any line
// arriving between two question() calls is dropped and the next await never
// settles. The iterator queues them. EOF is a hard error — never a silent exit.
let rl = null;
let lines = null;
const ask = async (q) => {
  rl ??= createInterface({ input: process.stdin });
  lines ??= rl[Symbol.asyncIterator]();
  process.stdout.write(q);
  const { value, done } = await lines.next();
  if (done) bail("Input ended (EOF) while waiting for an answer.");
  return value.trim();
};
const closePrompt = () => {
  rl?.close();
  rl = null;
  lines = null;
};

// Before spawning the editor, release stdin so readline does not compete with
// it for input — but only on a TTY. With piped input there is no terminal to
// hand over, and closing would discard the lines readline has already buffered
// from the pipe, i.e. the answers to the prompts after the editor.
const releaseStdinForEditor = () => {
  if (process.stdin.isTTY) closePrompt();
};

// ---------------------------------------------------------------- preflight

if (git(["status", "--porcelain"])) {
  bail("Working tree is not clean. Commit or stash first.");
}

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== RELEASE_BRANCH && !anyBranch) {
  bail(
    `On "${branch}", but releases are cut from "${RELEASE_BRANCH}".\n` +
      `  Switch branches, or pass --any-branch if this is deliberate.`,
  );
}

if (!noFetch) {
  console.log(`Fetching ${REMOTE}…`);
  git(["fetch", REMOTE, branch, "--tags"], { allowFailure: true });
  const remoteHead = git(["rev-parse", `${REMOTE}/${branch}`], {
    allowFailure: true,
  });
  const localHead = git(["rev-parse", "HEAD"]);
  if (remoteHead && remoteHead !== localHead) {
    // Ahead means unpushed work that CI has never seen; behind or diverged
    // means the release would omit merged PRs. Neither is safe to ship.
    const ahead = git(["rev-list", "--count", `${REMOTE}/${branch}..HEAD`]);
    const behind = git(["rev-list", "--count", `HEAD..${REMOTE}/${branch}`]);
    bail(
      `Local ${branch} is out of sync with ${REMOTE}/${branch} ` +
        `(${ahead} ahead, ${behind} behind).\n` +
        `  Push or pull first, or pass --no-fetch to skip this check.`,
    );
  }
}

// ------------------------------------------------------- version + changes

const pkgPath = join(root, "package.json");
const currentVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;
if (!parseVersion(currentVersion)) {
  bail(
    `Could not read a valid version from package.json (got "${currentVersion}").`,
  );
}

// Fails here rather than halfway through the apply — and --dry-run covers it.
let sites;
try {
  sites = readVersionSites(root, currentVersion);
} catch (err) {
  bail(err.message);
}

const BUMP_SUBJECT = /^(Release )?v?\d+\.\d+\.\d+$/;

const tagExists = (tag) =>
  git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], {
    allowFailure: true,
  }) !== null;

// Where the last release ended, as far as HEAD is concerned. Normally the
// v<currentVersion> tag — but every tag through v0.4.0 was cut on a side commit
// that never landed on main (the bump was squash-merged separately), so those
// tags are not ancestors of HEAD and a `tag..HEAD` range spans the whole
// history. When that happens, fall back to the newest bump commit on HEAD.
// Releases cut by this script tag the commit they push, so this self-heals.
function previousRelease() {
  const currentTag = `v${currentVersion}`;
  const isAncestor = (ref) =>
    spawnSync("git", ["merge-base", "--is-ancestor", ref, "HEAD"], {
      cwd: root,
    }).status === 0;

  if (tagExists(currentTag) && isAncestor(currentTag)) return currentTag;

  const bump = git([
    "log",
    "--pretty=format:%H %s",
    "--extended-regexp",
    "--grep",
    "^(Release )?v?[0-9]+\\.[0-9]+\\.[0-9]+$",
    "-n",
    "1",
    "HEAD",
  ]);
  if (bump) {
    const [sha, ...subject] = bump.split(" ");
    console.log(
      `\n! Tag ${currentTag} is not on this branch. Listing changes since ` +
        `the last bump commit instead ("${subject.join(" ")}").`,
    );
    return sha.slice(0, 9);
  }

  const described = git(["describe", "--tags", "--abbrev=0"], {
    allowFailure: true,
  });
  return described || null;
}

const prevTag = previousRelease();

// Commit subjects since then, minus the version-bump commits themselves (they
// are titled "v0.4.0" and carry no user-visible meaning).
const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
const changes = git(["log", "--no-merges", "--pretty=format:%s", range])
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s && !BUMP_SUBJECT.test(s));

console.log(`\nCurrent version: ${currentVersion}`);
console.log(`Changes since ${prevTag ?? "the beginning"}:\n`);
if (changes.length === 0) {
  console.log("  (none)\n");
  const go = await ask(
    "No changes since the last release. Continue anyway? [y/N] ",
  );
  if (!/^y(es)?$/i.test(go)) bail("Aborted.");
} else {
  for (const c of changes) console.log(`  · ${c}`);
  console.log();
}

const choices = {
  1: ["patch", bumpVersion(currentVersion, "patch")],
  2: ["minor", bumpVersion(currentVersion, "minor")],
  3: ["major", bumpVersion(currentVersion, "major")],
};
for (const [key, [kind, v]] of Object.entries(choices)) {
  console.log(
    `  ${key}) ${kind.padEnd(5)} ${v}${kind === "minor" ? "   (default)" : ""}`,
  );
}
console.log("  4) custom");

let nextVersion;
while (!nextVersion) {
  const answer = (await ask("\nNew version? [2] ")) || "2";
  const picked = choices[answer];
  const candidate = picked
    ? picked[1]
    : answer === "4"
      ? await ask("Version (x.y.z): ")
      : answer;

  if (!parseVersion(candidate)) {
    console.log(`  "${candidate}" is not a valid x.y.z version.`);
  } else if (!isNewer(candidate, currentVersion)) {
    console.log(`  ${candidate} is not newer than ${currentVersion}.`);
  } else if (
    git(["rev-parse", "--verify", "--quiet", `refs/tags/v${candidate}`], {
      allowFailure: true,
    }) !== null
  ) {
    console.log(`  Tag v${candidate} already exists.`);
  } else {
    nextVersion = candidate;
  }
}
const nextTag = `v${nextVersion}`;

// ------------------------------------------------------------ release notes

// The notes file is deleted only once the release is actually pushed, so an
// aborted or failed run leaves what you wrote on disk and a retry for the same
// version re-opens it instead of a blank template. Writing release notes is the
// one genuinely unrecoverable part of this script.
const notesFile = join(tmpdir(), `photobank-release-${nextVersion}.md`);
if (existsSync(notesFile)) {
  console.log(`\nReusing the notes from your previous attempt.`);
} else {
  const prefill = changes
    .map((c) => `- ${c.replace(/\s*\(#\d+\)$/, "")}`)
    .join("\n\n");
  writeFileSync(notesFile, `\n\n${prefill}\n\n${NOTES_TEMPLATE_HELP}`);
}

const editor =
  process.env.GIT_EDITOR ||
  git(["config", "--get", "core.editor"], { allowFailure: true }) ||
  process.env.VISUAL ||
  process.env.EDITOR ||
  "vi";

console.log(`\nOpening ${editor} for the release notes…`);
releaseStdinForEditor();
// Via the shell: core.editor may carry flags (e.g. "code --wait").
spawnSync(`${editor} "${notesFile}"`, {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

const notes = readFileSync(notesFile, "utf8")
  .split("\n")
  .filter((line) => !line.startsWith("#"))
  .join("\n")
  .trim();

if (!notes) bail("Empty release notes — aborted.");

// ------------------------------------------------------------------ confirm

console.log(`\n${"─".repeat(60)}`);
console.log(`${currentVersion}  →  ${nextVersion}`);
console.log(`${"─".repeat(60)}\n${notes}\n${"─".repeat(60)}\n`);

// The tag's first line is its subject, which the updater shows as the release
// headline. A bullet there means the title line was left unwritten.
if (notes.split("\n")[0].startsWith("-")) {
  console.log(
    "! The notes start with a bullet, so this release has no title line.\n",
  );
}
console.log("Will:");
console.log(`  · bump ${VERSION_SITES.length} files to ${nextVersion}`);
console.log(`  · commit "${nextTag}"`);
console.log(`  · create annotated tag ${nextTag} with the notes above`);
console.log(
  `  · push ${branch} and ${nextTag} to ${REMOTE}  ← starts the release build`,
);

if (dryRun) {
  console.log("\n--dry-run: nothing was written.");
  console.log(
    `Your notes are kept at ${notesFile} and will be reused next run.\n`,
  );
  closePrompt();
  process.exit(0);
}

if (!skipChecks) {
  console.log("\nRunning lint, typecheck, and tests…\n");
  // release.yml never runs these — it only builds and signs. A break here would
  // otherwise surface as a failed build after the tag has already gone out.
  if (!run("npm", ["run", "lint"])) bail("Lint failed. Fix it, or pass --skip-checks.");
  if (!run("npm", ["run", "typecheck"]))
    bail("Typecheck failed. Fix it, or pass --skip-checks.");
  if (!run("npm", ["test"])) bail("Tests failed. Fix them, or pass --skip-checks.");
}

// Loop until the answer is explicit. Lint plus the test suite is a ~30s window
// with the terminal apparently idle, and anything typed into it lands in the
// buffer and answers this prompt the instant it appears. Treating that as "no"
// silently threw away a release the user had already written the notes for.
let approved = null;
while (approved === null) {
  const answer = (await ask(`\nRelease ${nextTag}? [y/n] `)).toLowerCase();
  if (/^(y|yes)$/.test(answer)) approved = true;
  else if (/^(n|no)$/.test(answer)) approved = false;
  else console.log("  Please answer y or n.");
}
closePrompt();

if (!approved) {
  // Choosing not to release is not a failure — exit 0 so npm does not stack an
  // "ELIFECYCLE Command failed" on top of a deliberate answer.
  console.log("\nCancelled. Nothing was written.");
  console.log(
    `Your notes are kept at ${notesFile} and will be reused next run.\n`,
  );
  process.exit(0);
}

// -------------------------------------------------------------------- apply

for (const { path, patterns, content } of sites) {
  writeFileSync(join(root, path), applyVersion(content, patterns, nextVersion));
  console.log(`  bumped ${path}`);
}

git(["add", ...sites.map((s) => s.path)]);
git(["commit", "-m", nextTag]);
console.log(`  committed ${nextTag}`);

// allowFailure + null check, not try/catch: git() reports failure through
// bail(), which exits rather than throwing. A signing failure (tag.gpgSign with
// no usable key) would otherwise leave an untagged bump commit and no hint.
if (git(["tag", "-a", nextTag, "-m", notes], { allowFailure: true }) === null) {
  bail(
    `Tagging ${nextTag} failed, but the bump commit was already made.\n` +
      `  Undo it with:  git reset --hard HEAD~1`,
  );
}
console.log(`  tagged ${nextTag}`);

// Always push explicit refspecs, never a bare `git push`: a global
// push.default=matching would otherwise push every same-named local branch.
console.log(`\nPushing to ${REMOTE}…`);
const pushedBranch = git(
  ["push", REMOTE, `refs/heads/${branch}:refs/heads/${branch}`],
  { allowFailure: true },
);
if (pushedBranch === null) {
  bail(
    `Pushing ${branch} failed. The commit and tag exist locally. Retry with:\n` +
      `    git push ${REMOTE} refs/heads/${branch}:refs/heads/${branch}\n` +
      `    git push ${REMOTE} refs/tags/${nextTag}\n` +
      `  Or undo with:  git tag -d ${nextTag} && git reset --hard HEAD~1`,
  );
}
// Past the branch push there is no undo: the bump commit is on ${REMOTE} and
// resetting it locally would only diverge. The tag is what starts the build, so
// a failure here means the release is half-shipped — say so, and give the one
// command that finishes it.
const pushedTag = git(["push", REMOTE, `refs/tags/${nextTag}`], {
  allowFailure: true,
});
if (pushedTag === null) {
  bail(
    `The bump commit is on ${REMOTE}/${branch}, but pushing ${nextTag} failed —\n` +
      `  and the tag is what starts the release build. Finish with:\n` +
      `    git push ${REMOTE} refs/tags/${nextTag}\n` +
      `  Do not reset the bump commit, and do not re-run this script: it would\n` +
      `  read the already-bumped version and offer the one after ${nextVersion}.\n` +
      `  Your notes are kept in the local tag and at ${notesFile}.`,
  );
}

// Shipped — the notes are now in the tag, so the working copy can go.
unlinkSync(notesFile);

const repo = (git(["remote", "get-url", REMOTE]) ?? "")
  .replace(/^git@github\.com:/, "https://github.com/")
  .replace(/\.git$/, "");
console.log(`\n✓ Released ${nextTag}`);
console.log(`  Build:   ${repo}/actions`);
console.log(`  Release: ${repo}/releases/tag/${nextTag}\n`);
