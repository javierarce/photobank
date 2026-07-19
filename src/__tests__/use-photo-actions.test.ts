import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { usePhotoActions } from "@/hooks/use-photo-actions";
import { deletePhoto } from "@/lib/api";
import { ask, message } from "@tauri-apps/plugin-dialog";
import type { Photo } from "@/lib/types";
import { makePhoto } from "./fixtures";

vi.mock("@/lib/api", () => ({
  deletePhoto: vi.fn(),
  updatePhoto: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  message: vi.fn(),
}));

const mockDeletePhoto = vi.mocked(deletePhoto);
const mockAsk = vi.mocked(ask);
const mockMessage = vi.mocked(message);

// The grid is ordered newest-first; ids double as position markers here.
function seed(): Photo[] {
  return [
    makePhoto({ id: "a", filename: "a.jpg", s3Key: "f/a.jpg" }),
    makePhoto({ id: "b", filename: "b.jpg", s3Key: "f/b.jpg" }),
    makePhoto({ id: "c", filename: "c.jpg", s3Key: "f/c.jpg" }),
  ];
}

const ids = (photos: Photo[]) => photos.map((p) => p.id);

beforeEach(() => {
  // Default: the user confirms the delete.
  mockAsk.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("usePhotoActions — handleDelete (optimistic)", () => {
  it("removes the thumbnail once confirmed, before the backend responds", async () => {
    let resolveDelete: () => void = () => {};
    mockDeletePhoto.mockReturnValue(
      new Promise<void>((res) => {
        resolveDelete = () => res();
      })
    );

    const { result } = renderHook(() => usePhotoActions());
    const photos = seed();
    act(() => result.current.setPhotos(photos));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleDelete(photos[0]);
    });

    // Gone after the confirm resolves, while deletePhoto is still in flight.
    await waitFor(() => expect(ids(result.current.photos)).toEqual(["b", "c"]));
    expect(mockDeletePhoto).toHaveBeenCalledWith("a");

    await act(async () => {
      resolveDelete();
      await pending;
    });

    expect(ids(result.current.photos)).toEqual(["b", "c"]);
    expect(mockMessage).not.toHaveBeenCalled();
  });

  it("restores the photo at its original position when the delete fails", async () => {
    mockDeletePhoto.mockRejectedValue(new Error("s3 down"));

    const { result } = renderHook(() => usePhotoActions());
    const photos = seed();
    act(() => result.current.setPhotos(photos));

    await act(async () => {
      await result.current.handleDelete(photos[1]);
    });

    // Rolled back into its middle slot, not appended to the end.
    expect(ids(result.current.photos)).toEqual(["a", "b", "c"]);
    expect(mockMessage).toHaveBeenCalledWith(
      "Failed to delete photo",
      expect.objectContaining({ kind: "error" })
    );
  });

  it("surfaces the backend's message when the delete rejects with a string", async () => {
    // Tauri commands reject with a plain message string (see src/lib/api.ts),
    // e.g. the catalog↔bucket guard's "Run “Rebuild from bucket”…" error
    const reason =
      "This catalog was built from “test” but the app is now configured for “prod”.";
    mockDeletePhoto.mockRejectedValue(reason);

    const { result } = renderHook(() => usePhotoActions());
    const photos = seed();
    act(() => result.current.setPhotos(photos));

    await act(async () => {
      await result.current.handleDelete(photos[0]);
    });

    expect(mockMessage).toHaveBeenCalledWith(
      reason,
      expect.objectContaining({ kind: "error" })
    );
  });

  it("clears the active lightbox photo only when it was the one deleted", async () => {
    mockDeletePhoto.mockResolvedValue(undefined);

    const { result } = renderHook(() => usePhotoActions());
    const photos = seed();
    act(() => {
      result.current.setPhotos(photos);
      result.current.setActive(photos[0]);
    });

    await act(async () => {
      await result.current.handleDelete(photos[0]);
    });

    expect(result.current.active).toBeNull();
  });

  it("names the clean filename in the confirm dialog for a legacy photo", async () => {
    mockDeletePhoto.mockResolvedValue(undefined);

    const { result } = renderHook(() => usePhotoActions());
    const legacy = makePhoto({
      id: "a",
      filename: "R0012750_original.jpg",
      s3Key: "berlin/R0012750_original.jpg",
    });
    act(() => result.current.setPhotos([legacy]));

    await act(async () => {
      await result.current.handleDelete(legacy);
    });

    // The dialog must name what the user actually saw, not the raw stored key.
    expect(mockAsk).toHaveBeenCalledWith(
      expect.stringContaining("R0012750.jpg"),
      expect.anything()
    );
    expect(mockAsk).not.toHaveBeenCalledWith(
      expect.stringContaining("_original"),
      expect.anything()
    );
  });

  it("does nothing when the confirmation is dismissed", async () => {
    mockAsk.mockResolvedValue(false);

    const { result } = renderHook(() => usePhotoActions());
    const photos = seed();
    act(() => result.current.setPhotos(photos));

    await act(async () => {
      await result.current.handleDelete(photos[0]);
    });

    expect(mockDeletePhoto).not.toHaveBeenCalled();
    expect(ids(result.current.photos)).toEqual(["a", "b", "c"]);
  });
});

describe("usePhotoActions — handleBulkDelete (optimistic)", () => {
  it("commits before the bucket deletes finish, so the toolbar can clear immediately", async () => {
    // Hold every delete open so we can observe the return value while the
    // network is still in flight.
    let releaseDeletes: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseDeletes = () => res();
    });
    mockDeletePhoto.mockImplementation(() => gate.then(() => undefined));

    const { result } = renderHook(() => usePhotoActions());
    const photos = seed();
    act(() => result.current.setPhotos(photos));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.handleBulkDelete(photos);
    });

    // Returned (→ caller clears the selection) though the deletes are pending.
    expect(outcome).toBe(true);
    expect(ids(result.current.photos)).toEqual([]);

    await act(async () => {
      releaseDeletes();
      await gate;
    });
  });

  it("restores only the photos whose delete failed, in original order", async () => {
    // a and c fail, b succeeds.
    mockDeletePhoto.mockImplementation((id: string) =>
      id === "b" ? Promise.resolve() : Promise.reject(new Error("s3 down"))
    );

    const { result } = renderHook(() => usePhotoActions());
    const photos = seed();
    act(() => result.current.setPhotos(photos));

    await act(async () => {
      await result.current.handleBulkDelete(photos);
    });

    // b really deleted; a and c roll back into their original slots.
    await waitFor(() => expect(ids(result.current.photos)).toEqual(["a", "c"]));
    expect(mockMessage).toHaveBeenCalledWith(
      "Failed to delete 2 of 3 photos",
      expect.objectContaining({ kind: "error" })
    );
  });

  it("surfaces the backend's message when the deletes reject with a string", async () => {
    mockDeletePhoto.mockRejectedValue("bucket mismatch — rebuild first");

    const { result } = renderHook(() => usePhotoActions());
    const photos = seed();
    act(() => result.current.setPhotos(photos));

    await act(async () => {
      await result.current.handleBulkDelete(photos);
    });

    // Everything rolls back, and the dialog shows the backend's reason
    // instead of the generic count
    await waitFor(() => expect(ids(result.current.photos)).toEqual(["a", "b", "c"]));
    expect(mockMessage).toHaveBeenCalledWith(
      "bucket mismatch — rebuild first",
      expect.objectContaining({ kind: "error" })
    );
  });

  it("does nothing when the confirmation is dismissed", async () => {
    mockAsk.mockResolvedValue(false);

    const { result } = renderHook(() => usePhotoActions());
    const photos = seed();
    act(() => result.current.setPhotos(photos));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.handleBulkDelete(photos);
    });

    expect(outcome).toBe(false);
    expect(mockDeletePhoto).not.toHaveBeenCalled();
    expect(ids(result.current.photos)).toEqual(["a", "b", "c"]);
  });
});
