import { check } from "@tauri-apps/plugin-updater";
import { ask } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Check the GitHub release feed (latest.json) once, offer to install, and
 * relaunch. Never throws — an offline launch or a draft release must not
 * break the app.
 */
export async function checkForUpdates() {
  try {
    const update = await check();
    if (!update) return;

    const notes = update.body?.trim();
    const install = await ask(
      `Photobank ${update.version} is available.${notes ? `\n\n${notes}` : ""}`,
      {
        title: "Update available",
        kind: "info",
        okLabel: "Install and relaunch",
        cancelLabel: "Later",
      }
    );
    if (!install) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch {
    // Silent by design.
  }
}
