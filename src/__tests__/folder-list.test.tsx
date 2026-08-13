import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import {
  MemoryRouter,
  Routes,
  Route,
  useLocation,
  useParams,
} from "react-router-dom";
import { FolderList } from "@/components/folder-list";
import { listFolders } from "@/lib/api";
import type { FolderSortMode } from "@/lib/folder-sort";
import { makeFolder } from "@/__tests__/fixtures";

vi.mock("@/lib/api", () => ({
  listFolders: vi.fn(),
}));

// FolderList reads live upload state from the provider; stub a quiet default so
// these tests exercise the plain folder listing.
vi.mock("@/hooks/use-upload", () => ({
  useUpload: () => ({
    files: [],
    isDragging: false,
    dropFolder: null,
    summarize: () => ({
      total: 0,
      completed: 0,
      active: 0,
      percent: 0,
      failed: 0,
    }),
    clearCompleted: () => {},
    onUploadComplete: () => () => {},
  }),
}));

const mockListFolders = vi.mocked(listFolders);

// react-router decodes the route param (see routes/folder.tsx), so this reports
// the folder name exactly as the folder page would receive it.
function FolderProbe() {
  return <div data-testid="folder-param">{useParams().folder}</div>;
}

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderFolderList(
  sort?: FolderSortMode,
  onFoldersLoaded?: (names: string[]) => void
) {
  return render(
    <MemoryRouter>
      <FolderList sort={sort} onFoldersLoaded={onFoldersLoaded} />
      {/* Stands in for the header's New folder field: typing in an input must
          not drive the grid cursor. */}
      <input data-testid="outside-input" />
      <Routes>
        <Route path="/folders/:folder" element={<FolderProbe />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
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
        screen.getByText(
          "No folders yet. Create one, or upload some photos to get started."
        )
      ).toBeInTheDocument();
    });
  });

  it("renders folders with counts", async () => {
    mockListFolders.mockResolvedValueOnce([
      makeFolder({ folder: "vacation", count: 12 }),
      makeFolder({ folder: "barcelona", count: 1 }),
    ]);

    renderFolderList();

    await waitFor(() => {
      expect(screen.getByText("vacation")).toBeInTheDocument();
    });
    expect(screen.getByText("12 photos")).toBeInTheDocument();
    expect(screen.getByText("barcelona")).toBeInTheDocument();
    expect(screen.getByText("1 photo")).toBeInTheDocument();
  });

  it("orders the cards by the sort it is given, whatever order they arrive in", async () => {
    const listed = [
      makeFolder({ folder: "vacation", lastAddedAt: "2026-05-01T00:00:00Z" }),
      makeFolder({ folder: "berlin", lastAddedAt: "2026-01-01T00:00:00Z" }),
    ];
    // Once per render below; a lingering implementation would leak into the
    // tests that follow.
    mockListFolders.mockResolvedValueOnce(listed).mockResolvedValueOnce(listed);

    const cardNames = () =>
      Array.from(document.querySelectorAll("[data-nav-id]")).map((el) =>
        el.getAttribute("data-nav-id")
      );

    renderFolderList("name-asc");
    await screen.findByText("vacation");
    expect(cardNames()).toEqual(["berlin", "vacation"]);

    cleanup();
    renderFolderList("updated-desc");
    await screen.findByText("vacation");
    expect(cardNames()).toEqual(["vacation", "berlin"]);
  });

  it("reports the loaded folder names to the header", async () => {
    mockListFolders.mockResolvedValueOnce([
      makeFolder({ folder: "vacation" }),
      makeFolder({ folder: "berlin" }),
    ]);
    const onFoldersLoaded = vi.fn();

    renderFolderList(undefined, onFoldersLoaded);

    await waitFor(() => {
      expect(onFoldersLoaded).toHaveBeenLastCalledWith(["vacation", "berlin"]);
    });
  });

  it("shows each folder's cover thumbnail", async () => {
    mockListFolders.mockResolvedValueOnce([
      makeFolder({
        folder: "vacation",
        count: 12,
        coverKey: "vacation/sunset.jpg",
        coverVersion: "2026-02-01T00:00:00Z",
      }),
    ]);

    renderFolderList();

    const card = await screen.findByText("vacation");
    const cover = card.closest("a")?.querySelector("img");
    // The 640px variant, cache-busted with the cover photo's updatedAt.
    expect(cover?.getAttribute("src")).toBe(
      "photo://localhost/vacation/sunset_640.webp?v=2026-02-01T00%3A00%3A00Z"
    );
    // The folder name right below is the label; the picture is decoration.
    expect(cover?.getAttribute("alt")).toBe("");
  });

  it("falls back to the placeholder for a folder with no cover", async () => {
    mockListFolders.mockResolvedValueOnce([
      makeFolder({ folder: "vacation", count: 12 }),
    ]);

    renderFolderList();

    await screen.findByText("vacation");
    expect(screen.getByTestId("thumbnail-fallback")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("links each folder to its page, encoding the name", async () => {
    mockListFolders.mockResolvedValueOnce([makeFolder({ folder: "my photos", count: 3 })]);

    renderFolderList();

    await waitFor(() => {
      expect(screen.getByText("my photos")).toBeInTheDocument();
    });
    expect(
      screen.getByText("my photos").closest("a")?.getAttribute("href")
    ).toBe("/folders/my%20photos");
  });

  describe("keyboard navigation", () => {
    const card = (folder: string) =>
      document.querySelector<HTMLElement>(`[data-nav-id="${folder}"]`);
    // The keyboard cursor is the card's own DOM focus (highlighted via
    // :focus-visible in globals.css).
    const isFocused = (folder: string) => document.activeElement === card(folder);

    // The cards render in the default (name) order, so the cursor walks
    // barcelona → berlin → vacation whatever order the backend listed them in.
    async function renderNavList() {
      mockListFolders.mockResolvedValueOnce([
        makeFolder({ folder: "vacation", count: 3 }),
        makeFolder({ folder: "barcelona", count: 1 }),
        makeFolder({ folder: "berlin", count: 8 }),
      ]);
      renderFolderList();
      await screen.findByText("vacation");
    }

    it("moves the focus cursor across folders with arrows and vim keys", async () => {
      await renderNavList();

      // First press seats the cursor on the first folder card.
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(isFocused("barcelona")).toBe(true);

      fireEvent.keyDown(document.body, { key: "l" }); // vim right
      expect(isFocused("barcelona")).toBe(false);
      expect(isFocused("berlin")).toBe(true);

      fireEvent.keyDown(document.body, { key: "h" }); // vim left
      expect(isFocused("barcelona")).toBe(true);
    });

    it("opens the focused folder with Enter", async () => {
      await renderNavList();

      fireEvent.keyDown(document.body, { key: "ArrowRight" }); // focus barcelona
      fireEvent.keyDown(document.body, { key: "ArrowRight" }); // focus berlin
      fireEvent.keyDown(document.body, { key: "Enter" });

      await waitFor(() => {
        expect(screen.getByTestId("folder-param")).toHaveTextContent("berlin");
      });
    });

    it("does not navigate on grid keys typed into an input", async () => {
      await renderNavList();

      // Typing a folder name (or a search) must not drive the grid cursor or
      // open a folder.
      fireEvent.keyDown(screen.getByTestId("outside-input"), { key: "l" });
      expect(isFocused("barcelona")).toBe(false);
    });
  });

  it("shows an error message when loading fails", async () => {
    mockListFolders.mockRejectedValueOnce("boom");

    renderFolderList();

    await waitFor(() => {
      expect(screen.getByText("Failed to load folders.")).toBeInTheDocument();
    });
  });
});
