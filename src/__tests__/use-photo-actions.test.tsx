import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePhotoActions } from "@/hooks/use-photo-actions";
import { deletePhoto } from "@/lib/api";
import { makePhoto } from "./fixtures";

vi.mock("@/lib/api", () => ({
  deletePhoto: vi.fn(),
  updatePhoto: vi.fn(),
}));

const mockDeletePhoto = vi.mocked(deletePhoto);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
  vi.stubGlobal("alert", vi.fn());
});

describe("usePhotoActions delete errors", () => {
  it("surfaces the backend's message when delete rejects with a string", async () => {
    // Tauri commands reject with a plain message string (see src/lib/api.ts),
    // e.g. the catalog↔bucket guard's "Run “Rebuild from bucket”…" error
    const message =
      "This catalog was built from “test” but the app is now configured for “prod”.";
    mockDeletePhoto.mockRejectedValue(message);
    const { result } = renderHook(() => usePhotoActions());

    await act(() => result.current.handleDelete(makePhoto()));

    expect(alert).toHaveBeenCalledWith(message);
  });

  it("falls back to a generic message for non-string errors", async () => {
    mockDeletePhoto.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => usePhotoActions());

    await act(() => result.current.handleDelete(makePhoto()));

    expect(alert).toHaveBeenCalledWith("Failed to delete photo");
  });

  it("surfaces string errors from bulk delete", async () => {
    mockDeletePhoto.mockRejectedValue("bucket mismatch");
    const { result } = renderHook(() => usePhotoActions());

    let ran = true;
    await act(async () => {
      ran = await result.current.handleBulkDelete([
        makePhoto({ id: "1" }),
        makePhoto({ id: "2", filename: "other.jpg" }),
      ]);
    });

    expect(ran).toBe(false);
    expect(alert).toHaveBeenCalledWith("bucket mismatch");
  });
});
