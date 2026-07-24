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

function renderFolderList() {
  return render(
    <MemoryRouter>
      <FolderList />
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

  it("navigates to a newly named folder's page", async () => {
    mockListFolders.mockResolvedValueOnce([{ folder: "vacation", count: 3 }]);

    renderFolderList();

    fireEvent.click(await screen.findByTestId("new-folder-card"));
    const input = screen.getByTestId("new-folder-input");
    fireEvent.change(input, { target: { value: "  My Trip  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("folder-param")).toHaveTextContent("My Trip");
    });
  });

  it("opens the existing folder when the name matches (case-insensitively)", async () => {
    mockListFolders.mockResolvedValueOnce([{ folder: "Vacation", count: 3 }]);

    renderFolderList();

    fireEvent.click(await screen.findByTestId("new-folder-card"));
    const input = screen.getByTestId("new-folder-input");
    fireEvent.change(input, { target: { value: "vacation" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("folder-param")).toHaveTextContent("Vacation");
    });
  });

  it("dismisses the new-folder input on blur without navigating", async () => {
    mockListFolders.mockResolvedValueOnce([{ folder: "vacation", count: 3 }]);

    renderFolderList();

    fireEvent.click(await screen.findByTestId("new-folder-card"));
    const input = screen.getByTestId("new-folder-input");
    fireEvent.change(input, { target: { value: "scratch" } });
    fireEvent.blur(input);

    expect(screen.queryByTestId("new-folder-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    expect(screen.getByTestId("new-folder-card")).toBeInTheDocument();
  });

  it("cancels the new-folder input on Escape without navigating", async () => {
    mockListFolders.mockResolvedValueOnce([{ folder: "vacation", count: 3 }]);

    renderFolderList();

    fireEvent.click(await screen.findByTestId("new-folder-card"));
    const input = screen.getByTestId("new-folder-input");
    fireEvent.change(input, { target: { value: "scratch" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByTestId("new-folder-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    expect(screen.getByTestId("new-folder-card")).toBeInTheDocument();
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

  describe("keyboard navigation", () => {
    const card = (folder: string) =>
      document.querySelector<HTMLElement>(`[data-nav-id="${folder}"]`);
    // The keyboard cursor is the card's own DOM focus (highlighted via
    // :focus-visible in globals.css).
    const isFocused = (folder: string) => document.activeElement === card(folder);

    async function renderNavList() {
      mockListFolders.mockResolvedValueOnce([
        { folder: "vacation", count: 3 },
        { folder: "barcelona", count: 1 },
        { folder: "berlin", count: 8 },
      ]);
      renderFolderList();
      await screen.findByText("vacation");
    }

    it("moves the focus cursor across folders with arrows and vim keys", async () => {
      await renderNavList();

      // First press seats the cursor on the first folder card (the New folder
      // card is skipped — it isn't a nav target).
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(isFocused("vacation")).toBe(true);

      fireEvent.keyDown(document.body, { key: "l" }); // vim right
      expect(isFocused("vacation")).toBe(false);
      expect(isFocused("barcelona")).toBe(true);

      fireEvent.keyDown(document.body, { key: "h" }); // vim left
      expect(isFocused("vacation")).toBe(true);
    });

    it("opens the focused folder with Enter", async () => {
      await renderNavList();

      fireEvent.keyDown(document.body, { key: "ArrowRight" }); // focus vacation
      fireEvent.keyDown(document.body, { key: "ArrowRight" }); // focus barcelona
      fireEvent.keyDown(document.body, { key: "Enter" });

      await waitFor(() => {
        expect(screen.getByTestId("folder-param")).toHaveTextContent(
          "barcelona"
        );
      });
    });

    it("does not navigate on grid keys typed into an input", async () => {
      await renderNavList();

      // Start editing a new folder name; keystrokes there must not drive the
      // grid cursor or open a folder.
      fireEvent.click(screen.getByTestId("new-folder-card"));
      const input = screen.getByTestId("new-folder-input");
      fireEvent.keyDown(input, { key: "l" });
      expect(isFocused("vacation")).toBe(false);
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
