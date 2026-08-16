import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CollectionPage from "@/routes/collection";
import { SelectionProvider } from "@/hooks/selection-provider";
import { deleteCollection, listCollections, renameCollection } from "@/lib/api";
import { makeCollection } from "./fixtures";

vi.mock("@/lib/api", () => ({
  listCollections: vi.fn(),
  renameCollection: vi.fn(),
  deleteCollection: vi.fn(),
}));

// The grid has its own tests; here it only needs to report which collection it
// was pointed at.
vi.mock("@/components/photo-grid", () => ({
  PhotoGrid: ({
    folder,
    collectionId,
  }: {
    folder: string;
    collectionId?: string;
  }) => <div data-testid="grid">{`${folder}/${collectionId}`}</div>,
}));

// The search field talks to the backend for its autocomplete pools.
vi.mock("@/components/search-field", () => ({
  SearchField: () => <div data-testid="search-field" />,
}));

const collection = makeCollection({
  id: "c1",
  folder: "vacation",
  title: "Day one",
  photoIds: ["a", "b"],
});

/** Render the page at its route, tracking where it navigates to. */
function renderPage() {
  return render(
    <SelectionProvider>
      <MemoryRouter initialEntries={["/folders/vacation/collections/c1"]}>
        <Routes>
          <Route
            path="/folders/:folder/collections/:id"
            element={<CollectionPage />}
          />
          <Route
            path="/folders/:folder"
            element={<div data-testid="folder-page" />}
          />
        </Routes>
      </MemoryRouter>
    </SelectionProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listCollections).mockResolvedValue([collection]);
});

afterEach(() => cleanup());

describe("CollectionPage", () => {
  it("shows the collection, its photos, and the way back", async () => {
    renderPage();

    expect(await screen.findByTestId("collection-title")).toHaveTextContent(
      "Day one"
    );
    expect(screen.getByTestId("grid")).toHaveTextContent("vacation/c1");
    expect(screen.getByTestId("collection-back")).toHaveTextContent("vacation");
  });

  it("renames from the title", async () => {
    renderPage();
    vi.mocked(renameCollection).mockResolvedValue({
      ...collection,
      title: "Day two",
    });

    fireEvent.click(await screen.findByTestId("collection-title"));
    const input = screen.getByTestId("collection-title-input");
    fireEvent.change(input, { target: { value: "Day two" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(renameCollection).toHaveBeenCalledWith("c1", "Day two")
    );
    expect(await screen.findByTestId("collection-title")).toHaveTextContent(
      "Day two"
    );
  });

  it("keeps the old title and says why when the rename is refused", async () => {
    renderPage();
    vi.mocked(renameCollection).mockRejectedValue(
      "This folder already has a collection called “Day two”"
    );

    fireEvent.click(await screen.findByTestId("collection-title"));
    const input = screen.getByTestId("collection-title-input");
    fireEvent.change(input, { target: { value: "Day two" } });
    fireEvent.blur(input);

    expect(await screen.findByTestId("collection-error")).toHaveTextContent(
      "already has a collection called"
    );
    expect(screen.getByTestId("collection-title")).toHaveTextContent("Day one");
  });

  it("keeps Ungroup behind the ⋯ menu and returns to the folder after it", async () => {
    renderPage();
    vi.mocked(deleteCollection).mockResolvedValue(undefined);
    await screen.findByTestId("collection-title");

    // Not a button sitting next to the photos: dissolving takes a deliberate
    // trip through the menu, which says what survives it.
    expect(screen.queryByTestId("collection-ungroup")).toBeNull();
    fireEvent.click(screen.getByTestId("collection-menu"));
    expect(screen.getByText("Photos stay in the folder")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("collection-ungroup"));

    await waitFor(() => expect(deleteCollection).toHaveBeenCalledWith("c1"));
    // The page it was showing is gone, so it lands back on the folder.
    expect(await screen.findByTestId("folder-page")).toBeInTheDocument();
  });

  it("says so when the collection is gone", async () => {
    vi.mocked(listCollections).mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByText(/This collection no longer exists/)
    ).toBeInTheDocument();
    expect(screen.queryByTestId("grid")).toBeNull();
  });
});
