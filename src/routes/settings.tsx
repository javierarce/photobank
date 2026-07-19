import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelRefresh,
  getSettings,
  rebuildFromBucket,
  refreshLibrary,
  refreshPendingCount,
  REFRESH_PROGRESS_EVENT,
  saveSettings,
  testConnection,
  type RefreshProgress,
  type S3Settings,
} from "@/lib/api";
import { useTheme, type Theme } from "@/lib/theme-context";
import { useUpdate } from "@/lib/update-context";
import { checkForUpdate, isTauri } from "@/lib/updater";

type Status = { kind: "idle" } | { kind: "ok" | "error" | "busy"; message: string };

type UpdateCheck = "idle" | "checking" | "uptodate" | "error";

const inputClass =
  "w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 outline-none focus:border-foreground/30";

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { update, openDialog, presentUpdate } = useUpdate();
  const [appVersion, setAppVersion] = useState("");
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck>("idle");
  const [updateError, setUpdateError] = useState("");
  const [settings, setSettings] = useState<S3Settings>({
    endpoint: null,
    region: "",
    bucket: "",
    accessKeyId: "",
  });
  const [secret, setSecret] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [rebuildStatus, setRebuildStatus] = useState<Status>({ kind: "idle" });
  const [refreshStatus, setRefreshStatus] = useState<Status>({ kind: "idle" });
  /** Photos still missing thumbnails/metadata; null until first loaded. */
  const [refreshPending, setRefreshPending] = useState<number | null>(null);
  /** Live progress of a running refresh (manual or auto-started). */
  const [refreshProgress, setRefreshProgress] = useState<RefreshProgress | null>(
    null
  );
  /** Per-photo errors from the current/last run, so failures have names. */
  const [refreshFailures, setRefreshFailures] = useState<
    { filename: string; error: string }[]
  >([]);

  useEffect(() => {
    getSettings()
      .then((info) => {
        setSettings(info.settings);
        setHasSecret(info.hasSecret);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    refreshPendingCount().then(setRefreshPending).catch(() => {});
  }, []);

  // Show the running app version next to the update control (desktop only).
  useEffect(() => {
    if (!isTauri()) return;
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  // Progress events also arrive for refreshes this page didn't start (the
  // background run after a rebuild), so the section always reflects reality.
  useEffect(() => {
    const unlisten = listen<RefreshProgress>(REFRESH_PROGRESS_EVENT, (event) => {
      const p = event.payload;
      if (p.status === "running") {
        setRefreshProgress(p);
        const failure = p.error
          ? { filename: p.filename ?? "unknown file", error: p.error }
          : null;
        // Each event settles exactly one photo, so done+failed === 1 marks
        // the start of a run — reset the failure list from the previous one.
        if (p.done + p.failed === 1) {
          setRefreshFailures(failure ? [failure] : []);
        } else if (failure) {
          setRefreshFailures((prev) => [...prev, failure]);
        }
        return;
      }
      setRefreshProgress(null);
      setRefreshStatus({
        kind: p.failed > 0 || p.status === "cancelled" ? "error" : "ok",
        message:
          p.status === "cancelled"
            ? `Refresh cancelled — ${p.done} of ${p.total} photos done.`
            : p.failed > 0
              ? `Refreshed ${p.done} of ${p.total} photos; ${p.failed} failed — refresh again to retry them.`
              : `Refreshed ${p.done} photo${p.done === 1 ? "" : "s"}.`,
      });
      refreshPendingCount().then(setRefreshPending).catch(() => {});
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const set = (patch: Partial<S3Settings>) =>
    setSettings((prev) => ({ ...prev, ...patch }));

  const handleSave = async () => {
    setStatus({ kind: "busy", message: "Saving…" });
    try {
      const info = await saveSettings(settings, secret.trim() || null);
      setHasSecret(info.hasSecret);
      setSecret("");
      setStatus({
        kind: "ok",
        message: info.configured
          ? "Saved."
          : "Saved — fill in the remaining fields to connect.",
      });
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  };

  const handleTest = async () => {
    setStatus({ kind: "busy", message: "Testing connection…" });
    try {
      setStatus({ kind: "ok", message: await testConnection() });
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  };

  const handleRebuild = async () => {
    if (
      !confirm(
        "Replace the local catalog with the bucket's contents? Local-only rows will be lost."
      )
    ) {
      return;
    }
    setRebuildStatus({ kind: "busy", message: "Rebuilding from bucket…" });
    try {
      const report = await rebuildFromBucket();
      const refreshNote =
        report.needsRefresh > 0
          ? ` Regenerating thumbnails and metadata for ${report.needsRefresh} photos in the background…`
          : "";
      setRebuildStatus({
        kind: "ok",
        message:
          (report.source === "manifest"
            ? `Rebuilt from the manifest: ${report.photos} photos, ${report.tags} tags.`
            : `Rebuilt by scanning the bucket: ${report.photos} photos (no manifest found).`) +
          refreshNote,
      });
      refreshPendingCount().then(setRefreshPending).catch(() => {});
    } catch (err) {
      setRebuildStatus({ kind: "error", message: String(err) });
    }
  };

  const handleCheckUpdates = async () => {
    if (updateCheck === "checking") return;
    setUpdateCheck("checking");
    setUpdateError("");
    try {
      const found = await checkForUpdate();
      if (found) {
        // Hand it to the provider: the header badge appears and the install
        // dialog opens right away, since this was a deliberate check.
        presentUpdate(found);
        setUpdateCheck("idle");
      } else {
        setUpdateCheck("uptodate");
      }
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
      setUpdateCheck("error");
    }
  };

  const handleRefresh = async () => {
    setRefreshStatus({ kind: "busy", message: "Refreshing…" });
    try {
      // Progress events drive the UI; the resolved report is already
      // reflected by the final event, so only failures need handling here.
      await refreshLibrary();
    } catch (err) {
      setRefreshProgress(null);
      setRefreshStatus({ kind: "error", message: String(err) });
    }
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-8">
        <p className="text-sm text-foreground/60">Loading settings...</p>
      </main>
    );
  }

  return (
    <div className="min-h-screen font-sans">
      <main className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="text-xl font-semibold text-foreground">Settings</h1>

        <section className="mt-8">
          <h2 className="text-lg font-semibold text-foreground">Appearance</h2>
          <p className="mt-1 text-sm text-foreground/50">
            Use a light or dark theme, or follow your system.
          </p>
          <div
            role="radiogroup"
            aria-label="Theme"
            className="mt-4 inline-flex rounded-lg border border-border p-0.5"
          >
            {(["light", "dark", "system"] as Theme[]).map((option) => {
              const selected = theme === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setTheme(option)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition active:scale-[0.97] ${
                    selected
                      ? "bg-foreground text-background"
                      : "text-foreground/60 hover:text-foreground"
                  }`}
                >
                  {option}
                </button>
              );
            })}
          </div>
        </section>

        <section className="mt-12">
          <h2 className="text-lg font-semibold text-foreground">Storage</h2>
          <p className="mt-1 text-sm text-foreground/50">
            Photobank keeps your originals in an S3-compatible bucket and caches
            thumbnails locally. Your secret key never leaves this Mac.
          </p>
          <div className="mt-4 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Endpoint</span>
            <input
              type="url"
              value={settings.endpoint ?? ""}
              onChange={(e) => set({ endpoint: e.target.value || null })}
              placeholder="Leave empty for AWS S3, e.g. https://<account>.r2.cloudflarestorage.com"
              className={inputClass}
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">Region</span>
              <input
                type="text"
                value={settings.region}
                onChange={(e) => set({ region: e.target.value })}
                placeholder='"auto" for R2, e.g. eu-west-1 for AWS'
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">Bucket</span>
              <input
                type="text"
                value={settings.bucket}
                onChange={(e) => set({ bucket: e.target.value })}
                placeholder="photobank"
                className={inputClass}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">
              Access key ID
            </span>
            <input
              type="text"
              value={settings.accessKeyId}
              onChange={(e) => set({ accessKeyId: e.target.value })}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className={inputClass}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">
              Secret access key
            </span>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={hasSecret ? "••••••••" : ""}
              className={inputClass}
            />
          </label>
          </div>
        </section>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={status.kind === "busy"}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:bg-foreground/85 active:scale-[0.97] disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={status.kind === "busy"}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97] disabled:opacity-50"
          >
            Test connection
          </button>
          {status.kind !== "idle" && (
            <p
              className={`text-sm ${
                status.kind === "error"
                  ? "text-red-600 dark:text-red-400"
                  : status.kind === "ok"
                    ? "text-accent"
                    : "text-foreground/50"
              }`}
            >
              {status.message}
            </p>
          )}
        </div>

        <section className="mt-12">
          <h2 className="text-lg font-semibold text-foreground">Library</h2>
          <p className="mt-1 text-sm text-foreground/50">
            The catalog is continuously backed up to the bucket as{" "}
            <span className="font-mono">photobank-manifest.json</span>. On a
            fresh install (or after losing this Mac), rebuild it from there.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={handleRebuild}
              disabled={rebuildStatus.kind === "busy"}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97] disabled:opacity-50"
            >
              Rebuild from bucket
            </button>
            {rebuildStatus.kind !== "idle" && (
              <p
                className={`text-sm ${
                  rebuildStatus.kind === "error"
                    ? "text-red-600 dark:text-red-400"
                    : rebuildStatus.kind === "ok"
                      ? "text-accent"
                      : "text-foreground/50"
                }`}
              >
                {rebuildStatus.message}
              </p>
            )}
          </div>

          {refreshProgress ? (
            <div className="mt-6 flex items-center gap-3">
              <button
                type="button"
                onClick={() => cancelRefresh().catch(() => {})}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97]"
              >
                Cancel
              </button>
              <p className="text-sm text-foreground/50" role="status">
                Refreshing photos… {refreshProgress.done + refreshProgress.failed}{" "}
                of {refreshProgress.total}
                {refreshProgress.failed > 0 &&
                  ` (${refreshProgress.failed} failed)`}
              </p>
            </div>
          ) : (
            (refreshPending ?? 0) > 0 && (
              <div className="mt-6">
                <p className="text-sm text-foreground/50">
                  {refreshPending} photo{refreshPending === 1 ? "" : "s"} in the
                  catalog {refreshPending === 1 ? "is" : "are"} missing
                  thumbnails or metadata (added to the bucket outside this
                  app). Refreshing downloads each original, fills in EXIF and
                  dimensions, and regenerates missing thumbnails.
                </p>
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleRefresh}
                    disabled={refreshStatus.kind === "busy"}
                    className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97] disabled:opacity-50"
                  >
                    Refresh thumbnails &amp; metadata
                  </button>
                </div>
              </div>
            )
          )}
          {refreshStatus.kind !== "idle" && !refreshProgress && (
            <p
              className={`mt-3 text-sm ${
                refreshStatus.kind === "error"
                  ? "text-red-600 dark:text-red-400"
                  : refreshStatus.kind === "ok"
                    ? "text-accent"
                    : "text-foreground/50"
              }`}
            >
              {refreshStatus.message}
            </p>
          )}
          {refreshFailures.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-sm text-red-600 dark:text-red-400">
              {refreshFailures.slice(0, 5).map((failure) => (
                <li key={failure.filename} className="truncate">
                  <span className="font-mono">{failure.filename}</span> —{" "}
                  {failure.error}
                </li>
              ))}
              {refreshFailures.length > 5 && (
                <li>…and {refreshFailures.length - 5} more</li>
              )}
            </ul>
          )}
        </section>

        {isTauri() && (
          <section className="mt-12">
            <h2 className="text-lg font-semibold text-foreground">Updates</h2>
            <p className="mt-1 text-sm text-foreground/50">
              {appVersion ? `Photobank ${appVersion}` : "Photobank"}
              {updateCheck === "uptodate" && " — you’re up to date."}
              {updateCheck === "error" && ` — ${updateError}`}
            </p>
            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={update ? openDialog : handleCheckUpdates}
                disabled={updateCheck === "checking"}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97] disabled:opacity-50"
              >
                {update
                  ? "Update now"
                  : updateCheck === "checking"
                    ? "Checking…"
                    : "Check for updates"}
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
