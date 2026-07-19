import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { forwardRef } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import FolderPage from "@/routes/folder";
import { renameFolder } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  renameFolder: vi.fn(),
}));

vi.mock("@/components/photo-grid", () => ({
  PhotoGrid: forwardRef(function PhotoGrid() {
    return null;
  }),
}));

vi.mock("@/components/selection-toolbar", () => ({
  SelectionToolbar: () => null,
}));

// Mutable upload state so tests can simulate in-flight imports
const uploadState = vi.hoisted(() => ({
  files: [] as { folder: string; status: string }[],
}));

vi.mock("@/hooks/use-upload", () => ({
  useUpload: () => ({
    files: uploadState.files,
    dropFolder: null,
    openFilePicker: vi.fn(),
    removeUpload: vi.fn(),
    cancelUpload: vi.fn(),
    onUploadComplete: () => () => {},
  }),
}));

vi.mock("@/hooks/use-selection", () => ({
  useSelection: () => ({ selected: [] }),
  useBackgroundDeselect: () => () => {},
}));

const mockRenameFolder = vi.mocked(renameFolder);

function renderPage(folder = "trips") {
  return render(
    <MemoryRouter initialEntries={[`/folders/${encodeURIComponent(folder)}`]}>
      <Routes>
        <Route path="/folders/:folder" element={<FolderPage />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  uploadState.files = [];
});

describe("FolderPage — rename", () => {
  it("shows Rename next to Upload, but not for inbox", () => {
    renderPage("inbox");
    expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Rename" })
    ).not.toBeInTheDocument();

    cleanup();

    renderPage("trips");
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
  });

  it("disables Rename while an import into this folder is in flight", () => {
    uploadState.files = [
      { folder: "trips", status: "uploading", key: "trips/x.jpg" } as never,
    ];
    renderPage("trips");

    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    // Uploading more is fine — only the rename races the import
    expect(screen.getByRole("button", { name: /Upload$/ })).toBeEnabled();
  });

  it("ignores uploads into other folders", () => {
    uploadState.files = [
      { folder: "beach", status: "uploading", key: "beach/x.jpg" } as never,
    ];
    renderPage("trips");

    expect(screen.getByRole("button", { name: "Rename" })).toBeEnabled();
  });

  it("locks folder mutations while the rename is in flight", async () => {
    let resolveRename!: (moved: number) => void;
    mockRenameFolder.mockReturnValueOnce(
      new Promise((res) => {
        resolveRename = res;
      })
    );
    const { container } = renderPage("trips");

    expect(
      container.querySelector('[data-drop-folder="trips"]')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByTestId("folder-title-input");
    fireEvent.change(input, { target: { value: "voyages" } });
    fireEvent.blur(input);

    // In flight: Upload and Rename are disabled and the page stops being a
    // drop target, so nothing new can enter the folder mid-rename
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(container.querySelector("[data-drop-folder]")).toBeNull();

    resolveRename(2);

    // Landed on the renamed folder with everything unlocked again
    await waitFor(() => {
      expect(screen.getByTestId("folder-title")).toHaveTextContent("voyages");
    });
    expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Rename" })).toBeEnabled();
    expect(
      container.querySelector('[data-drop-folder="voyages"]')
    ).toBeInTheDocument();
  });
});
