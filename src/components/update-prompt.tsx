import { useEffect, useState } from "react";
import { useUpdate } from "@/lib/update-context";

// available -> downloading -> installing -> restarting (or -> error at any step).
// A distinct `installing` phase (entered on the Finished event) is what lets the
// label say "Installing…" only once the download is genuinely done, rather than
// inferring it from progress hitting 1 (which a final chunk can do early).
type Phase = "available" | "downloading" | "installing" | "restarting" | "error";

/**
 * The install dialog for a pending update. It only renders once opened — from
 * the <UpdateBadge /> in the header, the Settings button, or the command
 * palette; the launch check never pops it up on its own. On confirm: download
 * + install, then relaunch into the new version.
 *
 * Deliberately a React modal rather than a native dialog: window.confirm() is
 * dead in the WKWebView, and the dialog plugin's ask() depends on a brittle
 * JS<->native label round-trip. A modal we render ourselves has unambiguous
 * buttons, a real progress bar, and can show install errors inline instead of
 * failing silently.
 */
export function UpdatePrompt() {
  const { update, isDialogOpen, closeDialog } = useUpdate();
  const [phase, setPhase] = useState<Phase>("available");
  const [errMsg, setErrMsg] = useState("");
  // Download progress as a 0–1 fraction, or null when the total size is unknown
  // (no Content-Length) — the bar then shows an indeterminate sweep. Only
  // meaningful while phase === "downloading".
  const [progress, setProgress] = useState<number | null>(0);

  const busy =
    phase === "downloading" || phase === "installing" || phase === "restarting";

  // Close and reset to the offer view, so a prior install error doesn't linger
  // when the badge is tapped to reopen the dialog.
  function dismiss() {
    closeDialog();
    setPhase("available");
  }

  // Esc closes the dialog — but not mid-install, where the buttons are disabled
  // too, since a download/relaunch can't be cancelled partway through.
  //
  // Registered in the CAPTURE phase: sibling views (photo-grid, search-results)
  // clear their selection on a document-level Escape, and in the bubble phase
  // document fires before window — so a window bubble listener's stopPropagation
  // would run too late to stop them. Capturing on window runs first, so
  // dismissing the dialog no longer also wipes the selection underneath.
  useEffect(() => {
    if (!isDialogOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Always swallow Escape while the dialog is open so it never reaches the
      // document-level selection-clear handlers behind the modal — including
      // mid-install, when the dialog stays up but must not be dismissed (a
      // download/relaunch can't be cancelled partway through).
      e.stopPropagation();
      if (!busy) dismiss();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dismiss is stable enough for a keydown listener
  }, [isDialogOpen, busy]);

  async function install() {
    if (!update) return;
    setPhase("downloading");
    setProgress(0);
    try {
      // Report download progress so the dialog doesn't look frozen during the
      // download. Tauri streams Started (with the total) -> Progress (per
      // chunk) -> Finished; after Finished the plugin extracts and swaps the
      // bundle, which has no progress, so we switch to the "installing" phase.
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            setProgress(total > 0 ? 0 : null);
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (total > 0) setProgress(Math.min(downloaded / total, 1));
            break;
          case "Finished":
            setPhase("installing");
            break;
        }
      });

      // Installed — relaunch into the new version.
      setPhase("restarting");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  if (!isDialogOpen || !update) return null;

  const indeterminate = phase === "downloading" && progress === null;
  const label =
    phase === "restarting"
      ? "Restarting…"
      : phase === "installing"
        ? "Installing…"
        : progress === null
          ? "Downloading…"
          : `Downloading… ${Math.round(progress * 100)}%`;

  return (
    <div
      className="backdrop-in fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) dismiss();
      }}
    >
      <div className="modal-in mx-4 w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-[0_20px_50px_rgba(0,0,0,0.25)]">
        {phase === "error" ? (
          <>
            <h3 className="mb-2 text-lg font-semibold text-foreground">
              Update failed
            </h3>
            <p className="mb-4 break-words text-sm text-red-600 dark:text-red-400">
              {errMsg}
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={dismiss}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97]"
              >
                Close
              </button>
            </div>
          </>
        ) : busy ? (
          <>
            <h3 className="mb-2 text-lg font-semibold text-foreground">
              Updating to {update.version}
            </h3>
            <p className="mb-4 text-sm text-foreground/60" role="status">
              {label}
            </p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
              {indeterminate ? (
                <div className="progress-indeterminate h-full w-1/3 rounded-full bg-foreground" />
              ) : (
                <div
                  className={
                    "h-full rounded-full bg-foreground transition-[width] duration-200" +
                    (phase === "installing" || phase === "restarting"
                      ? " animate-pulse"
                      : "")
                  }
                  style={{
                    width:
                      phase === "installing" || phase === "restarting"
                        ? "100%"
                        : `${Math.round((progress ?? 0) * 100)}%`,
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <>
            <h3 className="mb-2 text-lg font-semibold text-foreground">
              Update available
            </h3>
            <p className="mb-3 text-sm text-foreground/60">
              Photobank {update.version} is available (you have{" "}
              {update.currentVersion}).
            </p>
            {update.body ? (
              <div className="mb-4 max-h-48 overflow-auto overscroll-contain whitespace-pre-line rounded-lg border border-border bg-foreground/5 p-3 text-sm text-foreground/70">
                {update.body.trim()}
              </div>
            ) : null}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={dismiss}
                className="rounded-lg px-4 py-2 text-sm font-medium text-foreground/60 transition hover:text-foreground active:scale-[0.97]"
              >
                Later
              </button>
              <button
                type="button"
                onClick={install}
                className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:bg-foreground/85 active:scale-[0.97]"
              >
                Install and restart
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
