import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { forwardRef, useEffect } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import FolderPage from "@/routes/folder";
import { listFolderFacets, renameFolder } from "@/lib/api";
import { summarizeUploads } from "@/lib/upload-progress";
import type { UploadFile } from "@/hooks/use-upload";

vi.mock("@/lib/api", () => ({
  renameFolder: vi.fn(),
  // The in-folder SearchField loads its folder-scoped autocomplete pool on
  // mount (the global-pool loaders are unused in folder mode).
  listFolderFacets: vi.fn(() =>
    Promise.resolve({ tags: [], makes: [], models: [], lenses: [] })
  ),
  listTags: vi.fn(() => Promise.resolve([])),
  listFolders: vi.fn(() => Promise.resolve([])),
  listSearchFacets: vi.fn(() =>
    Promise.resolve({ makes: [], models: [], lenses: [] })
  ),
}));

// The real grid reports whether the folder has photos, which gates the search
// field. Report "has photos" so the field renders in these tests.
vi.mock("@/components/photo-grid", () => ({
  PhotoGrid: forwardRef(function PhotoGrid({
    onHasPhotosChange,
  }: {
    onHasPhotosChange?: (has: boolean) => void;
  }) {
    useEffect(() => {
      onHasPhotosChange?.(true);
    }, [onHasPhotosChange]);
    return null;
  }),
}));

vi.mock("@/components/selection-toolbar", () => ({
  SelectionToolbar: () => null,
}));

// Mutable upload state so tests can simulate in-flight imports. `retired`
// stands in for tiles the grid has already dismissed — the provider keeps them
// in the batch total.
const uploadState = vi.hoisted(() => ({
  files: [] as { folder: string; status: string }[],
  retired: 0,
  cancelUpload: vi.fn(),
}));

vi.mock("@/hooks/use-upload", () => ({
  useUpload: () => ({
    files: uploadState.files,
    dropFolder: null,
    // The real summary maths, over the mocked files — so the header assertions
    // below exercise what the provider would actually hand the page.
    summarize: (folder?: string) =>
      summarizeUploads(
        (uploadState.files as UploadFile[]).filter(
          (f) => folder === undefined || f.folder === folder
        ),
        uploadState.retired
      ),
    openFilePicker: vi.fn(),
    removeUpload: vi.fn(),
    cancelUpload: uploadState.cancelUpload,
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

// Navigating between two folders keeps FolderPage mounted (same route, new
// param), which is exactly the case the query reset has to handle.
function GoTo({ folder }: { folder: string }) {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate(`/folders/${folder}`)}>go-{folder}</button>
  );
}

function renderPageWithNav(folder = "trips", target = "beach") {
  return render(
    <MemoryRouter initialEntries={[`/folders/${encodeURIComponent(folder)}`]}>
      <GoTo folder={target} />
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
  uploadState.retired = 0;
});

describe("FolderPage — batch upload progress", () => {
  function upload(name: string, progress: number, status = "uploading") {
    return {
      folder: "trips",
      filename: name,
      key: `trips/${name}`,
      status,
      progress,
    } as never;
  }

  it("shows one percentage for the whole drop", () => {
    uploadState.files = [
      upload("a.jpg", 100, "done"),
      upload("b.jpg", 50),
      upload("c.jpg", 0),
    ];
    renderPage("trips");

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("1/3 · 50%")).toBeInTheDocument();
  });

  it("keeps dismissed uploads in the total so the percentage never drops", () => {
    // Two files landed and their tiles are already gone; one is half-way.
    uploadState.retired = 2;
    uploadState.files = [upload("c.jpg", 50)];
    renderPage("trips");

    expect(screen.getByText("2/3 · 83%")).toBeInTheDocument();
  });

  it("leaves failures out of the ratio and counts them separately", () => {
    uploadState.files = [
      upload("a.jpg", 100, "done"),
      upload("b.jpg", 40, "error"),
    ];
    renderPage("trips");

    expect(screen.getByText("1/1 · 100%")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
  });

  it("shows nothing when the folder has no imports running", () => {
    renderPage("trips");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("cancels the rest of the batch from the ✕ beside the bar", () => {
    uploadState.files = [
      upload("a.jpg", 100, "done"),
      upload("b.jpg", 50),
      upload("c.jpg", 0, "pending"),
    ];
    renderPage("trips");

    // Only b and c can still be stopped — a has already landed.
    fireEvent.click(screen.getByLabelText("Cancel 2 uploads"));

    expect(uploadState.cancelUpload).toHaveBeenCalledTimes(2);
    expect(uploadState.cancelUpload).toHaveBeenCalledWith("trips/b.jpg");
    expect(uploadState.cancelUpload).toHaveBeenCalledWith("trips/c.jpg");
  });

  it("hides the ✕ once nothing can be cancelled", () => {
    // The batch is fully uploaded; its tiles just haven't been dismissed yet.
    uploadState.files = [upload("a.jpg", 100, "done")];
    renderPage("trips");

    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Cancel/)).not.toBeInTheDocument();
  });

  it("ignores imports into other folders", () => {
    uploadState.files = [
      { folder: "beach", status: "uploading", key: "beach/x.jpg", progress: 10 } as never,
    ];
    renderPage("trips");

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
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

  it("offers a folder search field once the folder has photos", async () => {
    renderPage("trips");
    // The field appears after the grid reports the folder has photos.
    const search = await screen.findByRole("textbox", {
      name: "Search this folder",
    });
    expect(search).toBeInTheDocument();
    // The autocomplete pool is loaded scoped to this folder.
    expect(vi.mocked(listFolderFacets)).toHaveBeenCalledWith("trips");

    fireEvent.change(search, { target: { value: "tag:sunset" } });
    expect(search).toHaveValue("tag:sunset");
  });

  it("clears the search when navigating to another folder", async () => {
    renderPageWithNav("trips", "beach");

    const search = await screen.findByRole("textbox", {
      name: "Search this folder",
    });
    fireEvent.change(search, { target: { value: "tag:sunset" } });
    expect(search).toHaveValue("tag:sunset");

    // The page stays mounted across the param change, so a leftover query would
    // silently filter the new folder — and the field is briefly unmounted while
    // the new grid loads, hiding the fact that a filter is still applied.
    fireEvent.click(screen.getByText("go-beach"));

    await waitFor(() => {
      expect(screen.getByTestId("folder-title")).toHaveTextContent("beach");
    });
    const next = await screen.findByRole("textbox", {
      name: "Search this folder",
    });
    expect(next).toHaveValue("");
    // And the new folder's own autocomplete pool is loaded.
    expect(vi.mocked(listFolderFacets)).toHaveBeenCalledWith("beach");
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
