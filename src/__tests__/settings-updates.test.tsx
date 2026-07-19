import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import type { Update } from "@tauri-apps/plugin-updater";
import SettingsPage from "@/routes/settings";
import { ThemeProvider } from "@/lib/theme";
import {
  UpdateContext,
  type UpdateContextValue,
} from "@/lib/update-context";
import { checkForUpdate } from "@/lib/updater";

vi.mock("@/lib/api", () => ({
  getSettings: vi.fn().mockResolvedValue({
    settings: { endpoint: null, region: "", bucket: "", accessKeyId: "" },
    hasSecret: false,
    configured: false,
  }),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  rebuildFromBucket: vi.fn(),
  refreshPendingCount: vi.fn().mockResolvedValue(0),
  refreshLibrary: vi.fn(),
  cancelRefresh: vi.fn(),
  REFRESH_PROGRESS_EVENT: "refresh://progress",
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

// Pretend we're in the desktop app so the Updates section renders, and stub
// the running-version lookup it reads on mount.
vi.mock("@/lib/updater", () => ({
  isTauri: () => true,
  checkForUpdate: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.1.0"),
}));

const mockCheck = vi.mocked(checkForUpdate);

function makeUpdate(): Update {
  return {
    version: "0.2.0",
    currentVersion: "0.1.0",
    body: "notes",
    downloadAndInstall: vi.fn(),
  } as unknown as Update;
}

function renderSettings(value: Partial<UpdateContextValue> = {}) {
  const ctx: UpdateContextValue = {
    update: null,
    isDialogOpen: false,
    openDialog: vi.fn(),
    closeDialog: vi.fn(),
    presentUpdate: vi.fn(),
    ...value,
  };
  render(
    <ThemeProvider>
      <UpdateContext.Provider value={ctx}>
        <SettingsPage />
      </UpdateContext.Provider>
    </ThemeProvider>
  );
  return ctx;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  mockCheck.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("Settings updates section", () => {
  it("shows the running version and a check button", async () => {
    renderSettings();
    await waitFor(() =>
      expect(screen.getByText("Photobank 0.1.0")).toBeInTheDocument()
    );
    expect(
      screen.getByRole("button", { name: /check for updates/i })
    ).toBeInTheDocument();
  });

  it("reports being up to date when no newer version exists", async () => {
    mockCheck.mockResolvedValue(null);
    renderSettings();
    await waitFor(() =>
      expect(screen.getByText("Photobank 0.1.0")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    await waitFor(() =>
      expect(screen.getByText(/up to date/i)).toBeInTheDocument()
    );
  });

  it("presents a found update to the provider", async () => {
    const update = makeUpdate();
    mockCheck.mockResolvedValue(update);
    const ctx = renderSettings();
    await waitFor(() =>
      expect(screen.getByText("Photobank 0.1.0")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    await waitFor(() => expect(ctx.presentUpdate).toHaveBeenCalledWith(update));
  });

  it("surfaces a check failure inline", async () => {
    mockCheck.mockRejectedValue(new Error("offline"));
    renderSettings();
    await waitFor(() =>
      expect(screen.getByText("Photobank 0.1.0")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    await waitFor(() =>
      expect(screen.getByText(/offline/)).toBeInTheDocument()
    );
  });

  it("offers to open the install dialog when an update is already pending", async () => {
    const ctx = renderSettings({ update: makeUpdate() });
    await waitFor(() =>
      expect(screen.getByText("Photobank 0.1.0")).toBeInTheDocument()
    );

    const button = screen.getByRole("button", { name: /update now/i });
    fireEvent.click(button);
    expect(ctx.openDialog).toHaveBeenCalledOnce();
    expect(mockCheck).not.toHaveBeenCalled();
  });
});
