import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CollectionPage from "@/routes/collection";
import { SelectionProvider } from "@/hooks/selection-provider";
import { useSelection } from "@/hooks/use-selection";
import { deleteCollection, listCollections, renameCollection } from "@/lib/api";
import { makeCollection, makePhoto } from "./fixtures";

vi.mock("@/lib/api", () => ({
  listCollections: vi.fn(),
  renameCollection: vi.fn(),
  deleteCollection: vi.fn(),
}));

// The grid has its own tests; here it only needs to report which collection it
// was pointed at, and to hand back a reloaded list on demand.
const handOver = vi.hoisted(() => ({
  fire: null as null | ((collections: unknown[]) => void),
}));

vi.mock("@/components/photo-grid", () => ({
  PhotoGrid: ({
    folder,
    collectionId,
    onCollectionsChange,
    orientation,
  }: {
    folder: string;
    collectionId?: string;
    onCollectionsChange?: (collections: unknown[]) => void;
    orientation?: string;
  }) => {
    handOver.fire = (collections) => onCollectionsChange?.(collections);
    return (
      <div data-testid="grid" data-orientation={orientation}>
        {`${folder}/${collectionId}`}
      </div>
    );
  },
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

/** Selects two photos from inside the provider, the way the grid would. */
function SelectionDriver() {
  const { toggle } = useSelection();
  return (
    <button
      type="button"
      data-testid="select-two"
      onClick={() => {
        toggle(makePhoto({ id: "a" }));
        toggle(makePhoto({ id: "b" }));
      }}
    />
  );
}

/** Render the page at its route, tracking where it navigates to. */
function renderPage() {
  return render(
    <SelectionProvider>
      <SelectionDriver />
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

  it("reads as one breadcrumb line: folder / collection", async () => {
    renderPage();

    const title = await screen.findByTestId("collection-title");
    const back = screen.getByTestId("collection-back");
    // One line, not a back link stacked above the title: both sit in the same
    // header row, joined by a slash and with no arrow. (The visual spacing
    // around the slash is flex gap, not whitespace.)
    const row = back.parentElement!;
    expect(row).toContainElement(title);
    expect(row).toHaveTextContent("vacation/Day one");
    expect(back).toHaveTextContent(/^vacation$/);
    expect(back).toHaveAttribute("href", "/folders/vacation");
  });

  it("keeps the way back while several photos are selected", async () => {
    renderPage();
    await screen.findByTestId("collection-title");

    fireEvent.click(screen.getByTestId("select-two"));

    // The selection toolbar takes over the rest of the row, so the folder
    // crumb has to outlive it: it's the only way back to the folder (the
    // header's Folders link goes to the root).
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.queryByTestId("collection-title")).toBeNull();
    expect(screen.getByTestId("collection-back")).toHaveAttribute(
      "href",
      "/folders/vacation"
    );
  });

  it("keeps the folder half of the breadcrumb while renaming", async () => {
    renderPage();

    fireEvent.click(await screen.findByTestId("collection-title"));

    expect(screen.getByTestId("collection-title-input")).toBeInTheDocument();
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

  it("takes the grid's collections instead of fetching them again", async () => {
    renderPage();
    await screen.findByTestId("collection-title");
    expect(listCollections).toHaveBeenCalledTimes(1);

    // The grid reloads the list for its own filtering (on every tick of the
    // import poll, among other things) and hands it over — the page reads it
    // rather than asking for the same rows a second time.
    act(() => {
      handOver.fire!([{ ...collection, title: "Day two" }]);
    });

    expect(screen.getByTestId("collection-title")).toHaveTextContent("Day two");
    expect(listCollections).toHaveBeenCalledTimes(1);
  });

  it("notices when the handed-over list no longer holds it", async () => {
    renderPage();
    await screen.findByTestId("collection-title");

    // Dissolved in another window: the grid's next reload simply doesn't
    // include it.
    act(() => {
      handOver.fire!([]);
    });

    expect(
      screen.getByText(/This collection no longer exists/)
    ).toBeInTheDocument();
  });

  it("says so when the collection is gone", async () => {
    vi.mocked(listCollections).mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByText(/This collection no longer exists/)
    ).toBeInTheDocument();
    expect(screen.queryByTestId("grid")).toBeNull();
  });

  it("filters the collection by orientation", async () => {
    renderPage();

    expect(await screen.findByTestId("grid")).toHaveAttribute(
      "data-orientation",
      "all"
    );

    fireEvent.click(screen.getByRole("radio", { name: "Landscape" }));

    expect(screen.getByTestId("grid")).toHaveAttribute(
      "data-orientation",
      "landscape"
    );
  });
});
