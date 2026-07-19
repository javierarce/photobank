import { useEffect, useState, type ReactNode } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { UpdateContext } from "@/lib/update-context";
import { checkForUpdate } from "@/lib/updater";

/**
 * Owns app-update state: the pending update and whether the install dialog is
 * open. An update reaches here two ways:
 *
 *  - On launch we check() in the background. Finding one does *not* open
 *    anything — it just surfaces the <UpdateBadge /> in the header, so the
 *    check never interrupts what the user is doing.
 *  - The Settings "Check for updates" button (and the command palette) run
 *    their own check and call presentUpdate(). That's a deliberate action, so
 *    the install dialog opens straight away.
 *
 * Either way the install/relaunch flow lives in one place — <UpdatePrompt />.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // Background check on launch — surfaces the badge, never auto-opens. Offline,
  // a draft release, or a transient fetch error must never block startup, so
  // failures are only logged.
  //
  // Gated to production builds so `tauri dev` doesn't offer to replace the
  // development binary with a real release; a manual check from Settings or the
  // command palette still works in dev.
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    let cancelled = false;
    checkForUpdate()
      .then((found) => {
        if (found && !cancelled) setUpdate(found);
      })
      .catch((err) => console.warn("Update check failed:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <UpdateContext.Provider
      value={{
        update,
        isDialogOpen,
        openDialog: () => setIsDialogOpen(true),
        closeDialog: () => setIsDialogOpen(false),
        presentUpdate: (found) => {
          setUpdate(found);
          setIsDialogOpen(true);
        },
      }}
    >
      {children}
    </UpdateContext.Provider>
  );
}
