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
  refreshLibrary,
  refreshPendingCount,
  cancelRefresh,
  type RefreshProgress,
} from "@/lib/api";

vi.mock("@/lib/api", () => ({
  getSettings: vi.fn().mockResolvedValue({
    settings: { endpoint: null, region: "", bucket: "b", accessKeyId: "k" },
    hasSecret: true,
    configured: true,
  }),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  rebuildFromBucket: vi.fn(),
  refreshPendingCount: vi.fn(),
  refreshLibrary: vi.fn(),
  cancelRefresh: vi.fn().mockResolvedValue(undefined),
  REFRESH_PROGRESS_EVENT: "refresh://progress",
}));

// Capture the refresh://progress subscription so tests can emit events.
const hoisted = vi.hoisted(() => ({
  refreshListener: null as
    | null
    | ((event: { payload: Partial<RefreshProgress> }) => void),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (
    _name: string,
    cb: (event: { payload: Partial<RefreshProgress> }) => void
  ) => {
    hoisted.refreshListener = cb;
    return Promise.resolve(() => {});
  },
}));

const mockPendingCount = vi.mocked(refreshPendingCount);
const mockRefreshLibrary = vi.mocked(refreshLibrary);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  hoisted.refreshListener = null;
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
  it("offers a refresh when photos are missing thumbnails or metadata", async () => {
    mockPendingCount.mockResolvedValue(3);
    await renderSettings();

    await screen.findByText(/3 photos in the catalog are missing/);
    expect(
      screen.getByRole("button", { name: /refresh thumbnails & metadata/i })
    ).toBeInTheDocument();
  });

  it("hides the refresh section when nothing needs it", async () => {
    mockPendingCount.mockResolvedValue(0);
    await renderSettings();

    await waitFor(() => expect(mockPendingCount).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /refresh thumbnails & metadata/i })
    ).not.toBeInTheDocument();
  });

  it("starts a refresh and tracks progress through its events", async () => {
    mockPendingCount.mockResolvedValue(2);
    // Resolution is driven by the final progress event, not this promise.
    mockRefreshLibrary.mockReturnValue(new Promise(() => {}));
    await renderSettings();

    fireEvent.click(
      await screen.findByRole("button", { name: /refresh thumbnails & metadata/i })
    );
    expect(mockRefreshLibrary).toHaveBeenCalled();

    await act(async () => {
      hoisted.refreshListener?.({
        payload: {
          total: 2,
          done: 1,
          failed: 0,
          status: "running",
          photoId: "p1",
          filename: "a.jpg",
          error: null,
        },
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Refreshing photos… 1 of 2"
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    mockPendingCount.mockResolvedValue(0);
    await act(async () => {
      hoisted.refreshListener?.({
        payload: {
          total: 2,
          done: 2,
          failed: 0,
          status: "done",
          photoId: null,
          filename: null,
          error: null,
        },
      });
    });
    expect(screen.getByText("Refreshed 2 photos.")).toBeInTheDocument();
    // The pending count is re-read so the section reflects the new state.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /refresh thumbnails & metadata/i })
      ).not.toBeInTheDocument()
    );
  });

  it("asks the backend to cancel a running refresh", async () => {
    mockPendingCount.mockResolvedValue(5);
    await renderSettings();

    await act(async () => {
      hoisted.refreshListener?.({
        payload: {
          total: 5,
          done: 1,
          failed: 0,
          status: "running",
          photoId: "p1",
          filename: "a.jpg",
          error: null,
        },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelRefresh).toHaveBeenCalled();
  });

  it("names the photos that failed and offers a retry hint", async () => {
    mockPendingCount.mockResolvedValue(3);
    await renderSettings();

    await act(async () => {
      hoisted.refreshListener?.({
        payload: {
          total: 3,
          done: 1,
          failed: 0,
          status: "running",
          photoId: "p1",
          filename: "ok.jpg",
          error: null,
        },
      });
      hoisted.refreshListener?.({
        payload: {
          total: 3,
          done: 1,
          failed: 1,
          status: "running",
          photoId: "p2",
          filename: "broken.heic",
          error: "could not decode image",
        },
      });
      hoisted.refreshListener?.({
        payload: {
          total: 3,
          done: 2,
          failed: 1,
          status: "done",
          photoId: null,
          filename: null,
          error: null,
        },
      });
    });

    expect(
      screen.getByText(/2 of 3 photos; 1 failed — refresh again to retry/)
    ).toBeInTheDocument();
    expect(screen.getByText("broken.heic")).toBeInTheDocument();
    expect(screen.getByText(/could not decode image/)).toBeInTheDocument();
  });

  it("surfaces a cancelled run with its partial progress", async () => {
    mockPendingCount.mockResolvedValue(4);
    await renderSettings();

    await act(async () => {
      hoisted.refreshListener?.({
        payload: {
          total: 4,
          done: 2,
          failed: 0,
          status: "cancelled",
          photoId: null,
          filename: null,
          error: null,
        },
      });
    });
    expect(
      screen.getByText("Refresh cancelled — 2 of 4 photos done.")
    ).toBeInTheDocument();
  });
});
