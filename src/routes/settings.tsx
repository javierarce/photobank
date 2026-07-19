import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelRefresh,
  getSettings,
  rebuildFromBucket,
  REBUILD_PROGRESS_EVENT,
  refreshLibrary,
  refreshPendingCount,
  refreshStatus as fetchRefreshStatus,
  REFRESH_PROGRESS_EVENT,
  saveSettings,
  testConnection,
  type RebuildProgress,
  type RefreshProgress,
  type S3Settings,
  type SettingsInfo,
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
  /** Failure list disclosure inside the progress card. */
  const [showFailures, setShowFailures] = useState(false);
  /** Which bucket the on-disk catalog belongs to, vs. the configured one. */
  const [catalog, setCatalog] = useState<{
    catalogBucket: string | null;
    bucketMismatch: boolean;
  }>({ catalogBucket: null, bucketMismatch: false });
  /** Objects scanned by an in-flight rebuild's bucket listing. */
  const [rebuildScanned, setRebuildScanned] = useState<number | null>(null);

  const applyInfo = (info: SettingsInfo) => {
    setSettings(info.settings);
    setHasSecret(info.hasSecret);
    setCatalog({
      catalogBucket: info.catalogBucket,
      bucketMismatch: info.bucketMismatch,
    });
  };

  useEffect(() => {
    getSettings()
      .then(applyInfo)
      .catch(() => {})
      .finally(() => setLoading(false));
    refreshPendingCount().then(setRefreshPending).catch(() => {});
    // A refresh started elsewhere (or before navigating away) keeps running
    // in the backend; pick up its progress instead of looking idle.
    fetchRefreshStatus()
      .then((progress) => {
        if (progress) setRefreshProgress(progress);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unlisten = listen<RebuildProgress>(REBUILD_PROGRESS_EVENT, (event) => {
      setRebuildScanned(event.payload.scanned);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
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
          setShowFailures(false);
        } else if (failure) {
          // Idempotent append: duplicate event delivery (StrictMode double
          // subscriptions in dev) must not list the same failure twice.
          setRefreshFailures((prev) =>
            prev.some(
              (f) =>
                f.filename === failure.filename && f.error === failure.error
            )
              ? prev
              : [...prev, failure]
          );
        }
        return;
      }
      setRefreshProgress(null);
      // Short summaries: the failure count lives in the card's toggle and the
      // Retry button already says what to do about it.
      setRefreshStatus({
        kind: p.failed > 0 || p.status === "cancelled" ? "error" : "ok",
        message:
          p.status === "cancelled"
            ? `Cancelled — ${p.done} of ${p.total} done.`
            : p.failed > 0
              ? `Last run: ${p.done} of ${p.total} done.`
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
      applyInfo(info);
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
    setRebuildScanned(null);
    setRebuildStatus({ kind: "busy", message: "Rebuilding from bucket…" });
    try {
      const report = await rebuildFromBucket();
      // No note about the follow-up thumbnail run: its progress row appears
      // right below the moment it starts.
      setRebuildStatus({
        kind: "ok",
        message:
          report.source === "manifest"
            ? `Rebuilt from the manifest — ${report.photos.toLocaleString()} photos, ${report.tags} tags.`
            : `Rebuilt from a bucket scan — ${report.photos.toLocaleString()} photos (no manifest found).`,
      });
      refreshPendingCount().then(setRefreshPending).catch(() => {});
      // The catalog now belongs to the configured bucket — clear the banner.
      getSettings().then(applyInfo).catch(() => {});
    } catch (err) {
      setRebuildStatus({ kind: "error", message: String(err) });
    } finally {
      setRebuildScanned(null);
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
    setRefreshStatus({ kind: "idle" });
    setRefreshFailures([]);
    setShowFailures(false);
    // Show the progress card immediately at 0 of N — the first real event can
    // be seconds away, and a button that visibly does nothing feels broken.
    setRefreshProgress({
      total: refreshPending ?? 0,
      done: 0,
      failed: 0,
      status: "running",
      photoId: null,
      filename: null,
      error: null,
    });
    try {
      // Progress events drive the UI; the resolved report is already
      // reflected by the final event, so only failures need handling here.
      await refreshLibrary();
    } catch (err) {
      setRefreshProgress(null);
      setRefreshStatus({ kind: "error", message: String(err) });
    }
  };

  // Hidden while a rebuild runs: the pending count belongs to the catalog
  // being replaced and would only mislead.
  const showPendingCard =
    rebuildStatus.kind !== "busy" && (refreshPending ?? 0) > 0;

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

        {isTauri() && (
          <section className="mt-8">
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

        <section className="mt-12">
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

          {catalog.bucketMismatch && (
            <p
              className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
              data-testid="bucket-mismatch"
            >
              You&apos;re still viewing{" "}
              <span className="font-mono">“{catalog.catalogBucket}”</span>.
              Rebuild from bucket to load the new one.
            </p>
          )}

          {/* Catalog row: title + one dim caption, one action. The caption
              doubles as the live status while a rebuild scans the bucket. */}
          <div className="mt-4 rounded-lg border border-border p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Catalog</p>
                <p
                  className="mt-0.5 text-sm text-foreground/50"
                  role={rebuildStatus.kind === "busy" ? "status" : undefined}
                >
                  {rebuildStatus.kind === "busy"
                    ? rebuildScanned !== null
                      ? `Scanning bucket… ${rebuildScanned.toLocaleString()} objects`
                      : "Rebuilding from bucket…"
                    : "Backs up to your bucket automatically."}
                </p>
              </div>
              <button
                type="button"
                onClick={handleRebuild}
                disabled={rebuildStatus.kind === "busy"}
                className="shrink-0 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97] disabled:opacity-50"
              >
                Rebuild from bucket
              </button>
            </div>
            {(rebuildStatus.kind === "ok" || rebuildStatus.kind === "error") && (
              <p
                className={`mt-2 text-sm ${
                  rebuildStatus.kind === "error"
                    ? "text-red-600 dark:text-red-400"
                    : "text-accent"
                }`}
              >
                {rebuildStatus.message}
              </p>
            )}
          </div>

          {/* Thumbnails row: only exists when there is something to do. */}
          {refreshProgress ? (
            <div className="mt-3 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium text-foreground">
                  Generating thumbnails…
                </p>
                <button
                  type="button"
                  onClick={() => cancelRefresh().catch(() => {})}
                  className="shrink-0 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97]"
                >
                  Cancel
                </button>
              </div>
              <div className="mt-3 h-1 overflow-hidden rounded-full bg-foreground/10">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200 ease-linear"
                  style={{
                    width: `${Math.round(((refreshProgress.done + refreshProgress.failed) / Math.max(refreshProgress.total, 1)) * 100)}%`,
                  }}
                />
              </div>
              <div className="mt-2 flex items-baseline gap-2 text-sm text-foreground/50">
                <p role="status">
                  {refreshProgress.done + refreshProgress.failed} of{" "}
                  {refreshProgress.total}
                </p>
                {refreshProgress.failed > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowFailures((v) => !v)}
                    aria-expanded={showFailures}
                    data-testid="toggle-failures"
                    className="text-red-600 transition hover:underline dark:text-red-400"
                  >
                    {refreshProgress.failed} failed {showFailures ? "▴" : "▾"}
                  </button>
                )}
              </div>
              {showFailures && <FailureList failures={refreshFailures} />}
            </div>
          ) : showPendingCard ? (
            <div className="mt-3 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {refreshPending} photo{refreshPending === 1 ? "" : "s"}{" "}
                    {refreshPending === 1 ? "needs" : "need"} thumbnails
                  </p>
                  {/* After a run, the caption becomes its summary and the
                      failures tuck behind the same toggle as during the run. */}
                  <div className="mt-0.5 flex items-baseline gap-2 text-sm text-foreground/50">
                    <p>
                      {refreshStatus.kind === "ok" ||
                      refreshStatus.kind === "error"
                        ? refreshStatus.message
                        : "Only the missing ones are downloaded."}
                    </p>
                    {refreshFailures.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowFailures((v) => !v)}
                        aria-expanded={showFailures}
                        data-testid="toggle-failures"
                        className="text-red-600 transition hover:underline dark:text-red-400"
                      >
                        {refreshFailures.length} failed {showFailures ? "▴" : "▾"}
                      </button>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleRefresh}
                  className="shrink-0 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97]"
                >
                  {refreshFailures.length > 0 ? "Retry" : "Generate"}
                </button>
              </div>
              {showFailures && <FailureList failures={refreshFailures} />}
            </div>
          ) : (
            refreshStatus.kind !== "idle" && (
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
            )
          )}
        </section>
      </main>
    </div>
  );
}

/** Compact list of per-photo refresh failures, capped so a long run can't
 * flood the section. */
function FailureList({
  failures,
}: {
  failures: { filename: string; error: string }[];
}) {
  return (
    <ul className="mt-2 flex flex-col gap-1 text-sm text-red-600 dark:text-red-400">
      {failures.slice(0, 5).map((failure) => (
        <li key={`${failure.filename}: ${failure.error}`} className="truncate">
          <span className="font-mono">{failure.filename}</span> — {failure.error}
        </li>
      ))}
      {failures.length > 5 && <li>…and {failures.length - 5} more</li>}
    </ul>
  );
}
