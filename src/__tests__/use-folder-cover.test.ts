import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { useFolderCover } from "@/hooks/use-folder-cover";
import { clearFolderCover, getFolderCover, setFolderCover } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  getFolderCover: vi.fn(),
  setFolderCover: vi.fn(),
  clearFolderCover: vi.fn(),
}));

const mockGet = vi.mocked(getFolderCover);
const mockSet = vi.mocked(setFolderCover);
const mockClear = vi.mocked(clearFolderCover);

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(null);
  mockSet.mockResolvedValue(undefined);
  mockClear.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("useFolderCover", () => {
  it("reads the folder's current pick", async () => {
    mockGet.mockResolvedValue("p1");

    const { result } = renderHook(() => useFolderCover("trips"));

    // undefined until the read lands, which is what callers disable on.
    expect(result.current.coverId).toBeUndefined();
    await waitFor(() => expect(result.current.coverId).toBe("p1"));
  });

  it("falls back to no pick when the read fails", async () => {
    mockGet.mockRejectedValue("db locked");

    const { result } = renderHook(() => useFolderCover("trips"));

    // Setting a cover is idempotent, so "no pick" keeps the control usable.
    await waitFor(() => expect(result.current.coverId).toBeNull());
  });

  it("carries a change to everyone showing that folder", async () => {
    const a = renderHook(() => useFolderCover("trips"));
    const b = renderHook(() => useFolderCover("trips"));
    await waitFor(() => expect(b.result.current.coverId).toBeNull());

    await act(() => a.result.current.setCover("p1"));

    // The lightbox sidebar's toggle and the right-click menu's item can be up
    // at once; the one that didn't act must not still offer to set the cover.
    expect(mockSet).toHaveBeenCalledWith("trips", "p1");
    expect(b.result.current.coverId).toBe("p1");

    await act(() => a.result.current.clearCover());
    expect(b.result.current.coverId).toBeNull();
  });

  it("leaves other folders alone", async () => {
    const trips = renderHook(() => useFolderCover("trips"));
    const inbox = renderHook(() => useFolderCover("inbox"));
    await waitFor(() => expect(inbox.result.current.coverId).toBeNull());

    await act(() => trips.result.current.setCover("p1"));

    expect(inbox.result.current.coverId).toBeNull();
  });

  it("keeps a change that lands mid-read", async () => {
    // The reply to a read started before the change would otherwise arrive
    // afterwards and restore the pick it replaced.
    let reply: (id: string | null) => void = () => {};
    mockGet.mockReturnValue(new Promise((resolve) => (reply = resolve)));
    const reading = renderHook(() => useFolderCover("trips"));

    const other = renderHook(() => useFolderCover("trips"));
    await act(() => other.result.current.setCover("p1"));
    expect(reading.result.current.coverId).toBe("p1");

    await act(async () => reply(null));

    expect(reading.result.current.coverId).toBe("p1");
  });
});
