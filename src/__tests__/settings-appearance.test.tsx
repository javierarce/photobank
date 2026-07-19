import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import SettingsPage from "@/routes/settings";
import { ThemeProvider } from "@/lib/theme";

// The page loads S3 config on mount; stub the api so it resolves to an empty,
// unconfigured state and we can focus on the Appearance control.
vi.mock("@/lib/api", () => ({
  getSettings: vi.fn().mockResolvedValue({
    settings: { endpoint: null, region: "", bucket: "", accessKeyId: "" },
    hasSecret: false,
    configured: false,
    catalogBucket: null,
    bucketMismatch: false,
  }),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  rebuildFromBucket: vi.fn(),
  refreshPendingCount: vi.fn().mockResolvedValue(0),
  refreshLibrary: vi.fn(),
  refreshStatus: vi.fn().mockResolvedValue(null),
  cancelRefresh: vi.fn(),
  REFRESH_PROGRESS_EVENT: "refresh://progress",
  REBUILD_PROGRESS_EVENT: "rebuild://progress",
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
});

async function renderSettings() {
  const result = render(
    <ThemeProvider>
      <SettingsPage />
    </ThemeProvider>
  );
  // Wait past the initial "Loading settings..." state.
  await waitFor(() =>
    expect(screen.getByText("Appearance")).toBeInTheDocument()
  );
  return result;
}

describe("Settings appearance", () => {
  it("offers light, dark, and system options", async () => {
    await renderSettings();

    expect(screen.getByRole("radio", { name: /light/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /dark/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /system/i })).toBeInTheDocument();
  });

  it("marks the current theme as checked", async () => {
    localStorage.setItem("theme", "dark");
    await renderSettings();

    expect(screen.getByRole("radio", { name: /dark/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /light/i })).not.toBeChecked();
  });

  it("switches the theme when an option is chosen", async () => {
    await renderSettings();

    fireEvent.click(screen.getByRole("radio", { name: /dark/i }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");

    fireEvent.click(screen.getByRole("radio", { name: /light/i }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
  });
});
