import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import SettingsPage from "@/routes/settings";
import { ThemeProvider } from "@/lib/theme";
import {
  getSettings,
  rebuildFromBucket,
  refreshLibrary,
  refreshPendingCount,
  refreshStatus,
  cancelRefresh,
} from "@/lib/api";

vi.mock("@/lib/api", () => ({
  getSettings: vi.fn().mockResolvedValue({
    settings: { endpoint: null, region: "", bucket: "b", accessKeyId: "k" },
    hasSecret: true,
    configured: true,
    catalogBucket: "b",
    bucketMismatch: false,
  }),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  rebuildFromBucket: vi.fn(),
  refreshPendingCount: vi.fn(),
  refreshLibrary: vi.fn(),
  refreshStatus: vi.fn().mockResolvedValue(null),
  cancelRefresh: vi.fn().mockResolvedValue(undefined),
  REFRESH_PROGRESS_EVENT: "refresh://progress",
  REBUILD_PROGRESS_EVENT: "rebuild://progress",
}));

// Capture the event subscriptions (refresh + rebuild progress) by name so
// tests can emit events.
const hoisted = vi.hoisted(() => ({
  listeners: {} as Record<string, (event: { payload: unknown }) => void>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (event: { payload: unknown }) => void) => {
    hoisted.listeners[name] = cb;
    return Promise.resolve(() => {});
  },
}));

function emitRefresh(payload: Record<string, unknown>) {
  hoisted.listeners["refresh://progress"]?.({ payload });
}

const mockGetSettings = vi.mocked(getSettings);
const mockRebuild = vi.mocked(rebuildFromBucket);
const mockPendingCount = vi.mocked(refreshPendingCount);
const mockRefreshLibrary = vi.mocked(refreshLibrary);
const mockRefreshStatus = vi.mocked(refreshStatus);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  hoisted.listeners = {};
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
  await waitFor(() => expect(screen.getByText("Library")).toBeInTheDocument());
  return result;
}

describe("Settings library refresh", () => {
  it("offers a refresh when photos may be missing thumbnails", async () => {
    mockPendingCount.mockResolvedValue(3);
    await renderSettings();

    await screen.findByText(/3 photos need thumbnails/);
    expect(
      screen.getByRole("button", { name: /^generate$/i })
    ).toBeInTheDocument();
  });

  it("hides the refresh section when nothing needs it", async () => {
    mockPendingCount.mockResolvedValue(0);
    await renderSettings();

    await waitFor(() => expect(mockPendingCount).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /^generate$/i })
    ).not.toBeInTheDocument();
  });

  it("starts a refresh and tracks progress through its events", async () => {
    mockPendingCount.mockResolvedValue(2);
    // Resolution is driven by the final progress event, not this promise.
    mockRefreshLibrary.mockReturnValue(new Promise(() => {}));
    await renderSettings();

    fireEvent.click(
      await screen.findByRole("button", { name: /^generate$/i })
    );
    expect(mockRefreshLibrary).toHaveBeenCalled();

    // The card appears instantly at 0 of N — no interim "Refreshing…" text
    // floating under it while the first (possibly slow) event is in flight.
    expect(screen.getByRole("status")).toHaveTextContent("0 of 2");
    expect(screen.queryByText("Refreshing…")).not.toBeInTheDocument();

    await act(async () => {
      emitRefresh({
        total: 2,
        done: 1,
        failed: 0,
        status: "running",
        photoId: "p1",
        filename: "a.jpg",
        error: null,
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 of 2"
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    mockPendingCount.mockResolvedValue(0);
    await act(async () => {
      emitRefresh({
        total: 2,
        done: 2,
        failed: 0,
        status: "done",
        photoId: null,
        filename: null,
        error: null,
      });
    });
    expect(screen.getByText("Refreshed 2 photos.")).toBeInTheDocument();
    // The pending count is re-read so the section reflects the new state.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^generate$/i })
      ).not.toBeInTheDocument()
    );
  });

  it("asks the backend to cancel a running refresh", async () => {
    mockPendingCount.mockResolvedValue(5);
    await renderSettings();

    await act(async () => {
      emitRefresh({
        total: 5,
        done: 1,
        failed: 0,
        status: "running",
        photoId: "p1",
        filename: "a.jpg",
        error: null,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelRefresh).toHaveBeenCalled();
  });

  it("tucks per-photo failures behind a toggle inside the progress card", async () => {
    mockPendingCount.mockResolvedValue(3);
    await renderSettings();

    await act(async () => {
      emitRefresh({
        total: 3,
        done: 0,
        failed: 1,
        status: "running",
        photoId: "p1",
        filename: "drawing.png",
        error: "streaming error",
      });
    });

    // Collapsed by default: the count reads as part of the progress line.
    const toggle = screen.getByTestId("toggle-failures");
    expect(toggle).toHaveTextContent("1 failed");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("drawing.png")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("drawing.png")).toBeInTheDocument();
    expect(screen.getByText(/streaming error/)).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByText("drawing.png")).not.toBeInTheDocument();
  });

  it("names the photos that failed and offers a retry hint", async () => {
    mockPendingCount.mockResolvedValue(3);
    await renderSettings();

    await act(async () => {
      emitRefresh({
        total: 3,
        done: 1,
        failed: 0,
        status: "running",
        photoId: "p1",
        filename: "ok.jpg",
        error: null,
      });
      emitRefresh({
        total: 3,
        done: 1,
        failed: 1,
        status: "running",
        photoId: "p2",
        filename: "broken.heic",
        error: "could not decode image",
      });
      emitRefresh({
        total: 3,
        done: 2,
        failed: 1,
        status: "done",
        photoId: null,
        filename: null,
        error: null,
      });
    });

    // The summary becomes the pending card's caption; the names stay behind
    // the same toggle used during the run, and the action reads Retry.
    expect(screen.getByText("Last run: 2 of 3 done.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("broken.heic")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("toggle-failures"));
    expect(screen.getByText("broken.heic")).toBeInTheDocument();
    expect(screen.getByText(/could not decode image/)).toBeInTheDocument();
  });

  it("lists a repeated failure event only once", async () => {
    mockPendingCount.mockResolvedValue(2);
    await renderSettings();

    const failure = {
      total: 2,
      done: 1,
      failed: 1,
      status: "running",
      photoId: "p2",
      filename: "drawing.png",
      error: "streaming error",
    };
    await act(async () => {
      emitRefresh({ ...failure, done: 0 }); // first event of the run
      emitRefresh(failure); // duplicate delivery of the same failure
    });

    expect(screen.getByTestId("toggle-failures")).toHaveTextContent("1 failed");
    fireEvent.click(screen.getByTestId("toggle-failures"));
    expect(screen.getAllByText("drawing.png")).toHaveLength(1);
  });

  it("rejoins a refresh already running in the background on mount", async () => {
    // Navigating away and back must not present a running refresh as idle —
    // the page asks the backend for a snapshot instead of waiting for the
    // next per-photo event (which can be many seconds away mid-download).
    mockPendingCount.mockResolvedValue(140);
    mockRefreshStatus.mockResolvedValueOnce({
      total: 143,
      done: 2,
      failed: 1,
      status: "running",
      photoId: null,
      filename: null,
      error: null,
    });
    await renderSettings();

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "3 of 143"
      )
    );
    // The idle "may be missing" block (with its start button) stays hidden.
    expect(
      screen.queryByRole("button", { name: /^generate$/i })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("warns when the catalog was built from a different bucket", async () => {
    mockGetSettings.mockResolvedValueOnce({
      settings: { endpoint: null, region: "", bucket: "new", accessKeyId: "k" },
      hasSecret: true,
      configured: true,
      catalogBucket: "old-bucket",
      bucketMismatch: true,
    });
    await renderSettings();

    const banner = await screen.findByTestId("bucket-mismatch");
    expect(banner).toHaveTextContent("old-bucket");
    expect(banner).toHaveTextContent(/rebuild from bucket/i);
  });

  it("shows listing progress and hides the stale pending count while rebuilding", async () => {
    mockPendingCount.mockResolvedValue(2922);
    // Keep the rebuild in flight so the busy state stays observable.
    mockRebuild.mockReturnValue(new Promise(() => {}));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderSettings();
    await screen.findByText(/2922 photos need thumbnails/);

    fireEvent.click(screen.getByRole("button", { name: "Rebuild from bucket" }));

    // The old catalog's pending count would only mislead mid-rebuild.
    await waitFor(() =>
      expect(
        screen.queryByText(/2922 photos need thumbnails/)
      ).not.toBeInTheDocument()
    );

    await act(async () => {
      hoisted.listeners["rebuild://progress"]?.({ payload: { scanned: 12000 } });
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Scanning bucket… 12,000 objects"
    );
  });

  it("surfaces a cancelled run with its partial progress", async () => {
    mockPendingCount.mockResolvedValue(4);
    await renderSettings();

    await act(async () => {
      emitRefresh({
        total: 4,
        done: 2,
        failed: 0,
        status: "cancelled",
        photoId: null,
        filename: null,
        error: null,
      });
    });
    expect(screen.getByText("Cancelled — 2 of 4 done.")).toBeInTheDocument();
  });
});
