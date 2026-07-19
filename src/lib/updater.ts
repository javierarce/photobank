import type { Update } from "@tauri-apps/plugin-updater";

/**
 * True only inside the Tauri desktop shell. The updater/process plugins don't
 * exist in a plain browser (`npm run dev`) or under test, so anything touching
 * them must guard on this first.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Ask the GitHub release feed (latest.json) whether a newer version exists.
 * Resolves to the pending Update, or null when up to date or not running in
 * the desktop app.
 *
 * Deliberately does *not* swallow errors: a real fetch failure throws so each
 * caller can decide what to do — the launch check ignores it (never block
 * startup), while the Settings button surfaces it to the user.
 */
export async function checkForUpdate(): Promise<Update | null> {
  if (!isTauri()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  return (await check()) ?? null;
}
