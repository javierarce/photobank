import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { FolderCoverButton } from "@/components/folder-cover-button";
import { clearFolderCover, getFolderCover, setFolderCover } from "@/lib/api";
import { makePhoto } from "@/__tests__/fixtures";

vi.mock("@/lib/api", () => ({
  getFolderCover: vi.fn(),
  setFolderCover: vi.fn(),
  clearFolderCover: vi.fn(),
}));

const mockGet = vi.mocked(getFolderCover);
const mockSet = vi.mocked(setFolderCover);
const mockClear = vi.mocked(clearFolderCover);

const photo = makePhoto({ id: "p1", folder: "trips", s3Key: "trips/a.jpg" });

beforeEach(() => {
  vi.clearAllMocks();
  mockSet.mockResolvedValue(undefined);
  mockClear.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

const button = () => screen.getByTestId("folder-cover");

describe("FolderCoverButton", () => {
  it("sets the photo as its folder's cover", async () => {
    mockGet.mockResolvedValue(null);

    render(<FolderCoverButton photo={photo} />);

    await waitFor(() => expect(button()).toBeEnabled());
    expect(button()).toHaveTextContent("Set as folder cover");

    fireEvent.click(button());

    await waitFor(() =>
      expect(mockSet).toHaveBeenCalledWith("trips", "p1")
    );
    // The label flips without a reload, so the same button undoes it.
    await waitFor(() =>
      expect(button()).toHaveTextContent("Remove folder cover")
    );
  });

  it("removes the pick when this photo is already the cover", async () => {
    mockGet.mockResolvedValue("p1");

    render(<FolderCoverButton photo={photo} />);

    await waitFor(() =>
      expect(button()).toHaveTextContent("Remove folder cover")
    );

    fireEvent.click(button());

    await waitFor(() => expect(mockClear).toHaveBeenCalledWith("trips"));
    expect(mockSet).not.toHaveBeenCalled();
    await waitFor(() => expect(button()).toHaveTextContent("Set as folder cover"));
  });

  it("offers to set the cover when another photo holds it", async () => {
    mockGet.mockResolvedValue("other");

    render(<FolderCoverButton photo={photo} />);

    await waitFor(() => expect(button()).toBeEnabled());
    expect(button()).toHaveTextContent("Set as folder cover");
  });

  it("waits for the current pick before offering an action", () => {
    mockGet.mockReturnValue(new Promise(() => {}));

    render(<FolderCoverButton photo={photo} />);

    // Otherwise a photo that IS the cover would briefly offer to set it again.
    expect(button()).toBeDisabled();
  });

  it("reports a rejected save without claiming the cover changed", async () => {
    mockGet.mockResolvedValue(null);
    mockSet.mockRejectedValue("That photo is not in this folder");

    render(<FolderCoverButton photo={photo} />);
    await waitFor(() => expect(button()).toBeEnabled());

    fireEvent.click(button());

    await waitFor(() =>
      expect(screen.getByTestId("folder-cover-error")).toHaveTextContent(
        "That photo is not in this folder"
      )
    );
    expect(button()).toHaveTextContent("Set as folder cover");
  });
});
