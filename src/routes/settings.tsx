import { useEffect, useState } from "react";
import {
  getSettings,
  rebuildFromBucket,
  saveSettings,
  testConnection,
  type S3Settings,
} from "@/lib/api";
import { useTheme, type Theme } from "@/lib/theme-context";

type Status = { kind: "idle" } | { kind: "ok" | "error" | "busy"; message: string };

const inputClass =
  "w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 outline-none focus:border-foreground/30";

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
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

  useEffect(() => {
    getSettings()
      .then((info) => {
        setSettings(info.settings);
        setHasSecret(info.hasSecret);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
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
      setRebuildStatus({
        kind: "ok",
        message:
          report.source === "manifest"
            ? `Rebuilt from the manifest: ${report.photos} photos, ${report.tags} tags.`
            : `Rebuilt by scanning the bucket: ${report.photos} photos (no manifest found — EXIF and tags will refill as you use the app).`,
      });
    } catch (err) {
      setRebuildStatus({ kind: "error", message: String(err) });
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
        </section>
      </main>
    </div>
  );
}
