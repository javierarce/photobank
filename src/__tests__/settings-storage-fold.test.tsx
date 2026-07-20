import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import SettingsPage from "@/routes/settings";
import { ThemeProvider } from "@/lib/theme";
import { getSettings } from "@/lib/api";

// The Storage section is a long form; it should collapse by default once
// storage is configured, and open on demand (or on first run).
vi.mock("@/lib/api", () => ({
  getSettings: vi.fn().mockResolvedValue({
    settings: { endpoint: null, region: "auto", bucket: "my-bucket", accessKeyId: "AK" },
    hasSecret: true,
    configured: true,
    catalogBucket: "my-bucket",
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

const mockGetSettings = vi.mocked(getSettings);

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderSettings() {
  const result = render(
    <ThemeProvider>
      <SettingsPage />
    </ThemeProvider>
  );
  await waitFor(() =>
    expect(screen.getByText("Storage")).toBeInTheDocument()
  );
  return result;
}

describe("Settings storage fold", () => {
  it("collapses the storage form by default when configured", async () => {
    await renderSettings();

    // The Storage heading is always present, but its fields are hidden.
    const toggle = screen.getByRole("button", { name: /storage/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Endpoint")).not.toBeInTheDocument();
    // The configured bucket is shown as a hint next to the collapsed heading.
    expect(screen.getByText("my-bucket")).toBeInTheDocument();
  });

  it("reveals the form when the heading is clicked", async () => {
    await renderSettings();

    fireEvent.click(screen.getByRole("button", { name: /storage/i }));

    expect(screen.getByText("Endpoint")).toBeInTheDocument();
    expect(screen.getByText("Bucket")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Test connection" })
    ).toBeInTheDocument();
  });

  it("starts expanded on first run when nothing is configured", async () => {
    mockGetSettings.mockResolvedValueOnce({
      settings: { endpoint: null, region: "", bucket: "", accessKeyId: "" },
      hasSecret: false,
      configured: false,
      catalogBucket: null,
      bucketMismatch: false,
    });

    await renderSettings();

    expect(
      screen.getByRole("button", { name: /storage/i })
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Endpoint")).toBeInTheDocument();
  });
});
