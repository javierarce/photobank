import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { FolderList } from "@/components/folder-list";
import { listFolders } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  listFolders: vi.fn(),
}));

const mockListFolders = vi.mocked(listFolders);

function renderFolderList() {
  return render(
    <MemoryRouter>
      <FolderList />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("FolderList", () => {
  it("shows loading state initially", () => {
    mockListFolders.mockReturnValueOnce(new Promise(() => {}));
    renderFolderList();

    expect(screen.getByText("Loading folders...")).toBeInTheDocument();
  });

  it("shows empty state when no folders exist", async () => {
    mockListFolders.mockResolvedValueOnce([]);

    renderFolderList();

    await waitFor(() => {
      expect(
        screen.getByText("No folders yet. Upload some photos to get started.")
      ).toBeInTheDocument();
    });
  });

  it("renders folders with counts", async () => {
    mockListFolders.mockResolvedValueOnce([
      { folder: "vacation", count: 12 },
      { folder: "barcelona", count: 1 },
    ]);

    renderFolderList();

    await waitFor(() => {
      expect(screen.getByText("vacation")).toBeInTheDocument();
    });
    expect(screen.getByText("12 photos")).toBeInTheDocument();
    expect(screen.getByText("barcelona")).toBeInTheDocument();
    expect(screen.getByText("1 photo")).toBeInTheDocument();
  });

  it("links each folder to its page, encoding the name", async () => {
    mockListFolders.mockResolvedValueOnce([{ folder: "my photos", count: 3 }]);

    renderFolderList();

    await waitFor(() => {
      expect(screen.getByText("my photos")).toBeInTheDocument();
    });
    expect(
      screen.getByText("my photos").closest("a")?.getAttribute("href")
    ).toBe("/folders/my%20photos");
  });

  it("shows an error message when loading fails", async () => {
    mockListFolders.mockRejectedValueOnce("boom");

    renderFolderList();

    await waitFor(() => {
      expect(screen.getByText("Failed to load folders.")).toBeInTheDocument();
    });
  });
});
