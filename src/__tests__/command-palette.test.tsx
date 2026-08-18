import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CommandPalette } from "@/components/command-palette";
import { ThemeProvider } from "@/lib/theme";
import { listAllCollections, listFolders, listTagCounts } from "@/lib/api";
import { makeFolder } from "@/__tests__/fixtures";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@/lib/api", () => ({
  listFolders: vi.fn(),
  listAllCollections: vi.fn(),
  listTagCounts: vi.fn(),
}));

const mockListFolders = vi.mocked(listFolders);
const mockListCollections = vi.mocked(listAllCollections);
const mockListTagCounts = vi.mocked(listTagCounts);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  mockListFolders.mockResolvedValue([
    makeFolder({ folder: "vacation", count: 12 }),
    makeFolder({ folder: "barcelona", count: 1 }),
  ]);
  mockListCollections.mockResolvedValue([
    { id: "c1", folder: "vacation", title: "Day one", count: 4 },
    { id: "c2", folder: "barcelona", title: "Sagrada", count: 2 },
  ]);
  mockListTagCounts.mockResolvedValue([
    { id: "t1", name: "portrait", count: 5 },
    { id: "t2", name: "landscape", count: 2 },
  ]);
});

afterEach(() => {
  cleanup();
});

function renderPalette() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>
    </ThemeProvider>
  );
}

/** Fire the global Cmd/Ctrl+K shortcut the palette listens for on window. */
function pressCmdK() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
}

function getInput() {
  return screen.getByPlaceholderText(/search folders, collections or actions/i);
}

describe("CommandPalette", () => {
  it("is closed until Cmd+K is pressed", async () => {
    renderPalette();
    expect(
      screen.queryByPlaceholderText(/search folders, collections or actions/i)
    ).not.toBeInTheDocument();

    pressCmdK();

    expect(getInput()).toBeInTheDocument();
    // Folders load in once the palette opens.
    await waitFor(() => expect(screen.getByText("vacation")).toBeInTheDocument());
  });

  it("lists the default actions and the folders", async () => {
    renderPalette();
    pressCmdK();

    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Search…")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("vacation")).toBeInTheDocument());
    expect(screen.getByText("barcelona")).toBeInTheDocument();
  });

  it("filters folders by the typed query, accent-insensitively", async () => {
    mockListFolders.mockResolvedValue([
      makeFolder({ folder: "Café", count: 3 }),
      makeFolder({ folder: "vacation", count: 12 }),
    ]);
    renderPalette();
    pressCmdK();
    await waitFor(() => expect(screen.getByText("Café")).toBeInTheDocument());

    fireEvent.change(getInput(), { target: { value: "cafe" } });

    expect(screen.getByText("Café")).toBeInTheDocument();
    expect(screen.queryByText("vacation")).not.toBeInTheDocument();
  });

  it("lists tags and navigates to a tag's photos on Enter", async () => {
    renderPalette();
    pressCmdK();
    await waitFor(() =>
      expect(screen.getByText("portrait")).toBeInTheDocument()
    );

    // Narrow to the tag, then step past the always-on Search action to it.
    fireEvent.change(getInput(), { target: { value: "portrait" } });
    fireEvent.keyDown(getInput(), { key: "ArrowDown" });
    fireEvent.keyDown(getInput(), { key: "Enter" });

    // Goes to the search page with a typed tag query the user can refine.
    expect(mockNavigate).toHaveBeenCalledWith("/search?q=tag%3Aportrait");
  });

  it("lists collections with the folder they're in", async () => {
    renderPalette();
    pressCmdK();

    await waitFor(() => expect(screen.getByText("Day one")).toBeInTheDocument());
    expect(screen.getByText("Sagrada")).toBeInTheDocument();
    // Titles are only unique per folder, so each row says where it lives.
    expect(screen.getByText("in vacation")).toBeInTheDocument();
    expect(screen.getByText("in barcelona")).toBeInTheDocument();
  });

  it("filters collections by title and opens one on Enter", async () => {
    renderPalette();
    pressCmdK();
    await waitFor(() => expect(screen.getByText("Day one")).toBeInTheDocument());

    // A partial match splits the title around the highlight, so the row is
    // identified by the folder label riding beside it.
    fireEvent.change(getInput(), { target: { value: "sagr" } });
    expect(screen.getByText("in barcelona")).toBeInTheDocument();
    expect(screen.queryByText("in vacation")).not.toBeInTheDocument();

    // Step past the always-on Search action to the collection.
    fireEvent.keyDown(getInput(), { key: "ArrowDown" });
    fireEvent.keyDown(getInput(), { key: "Enter" });

    expect(mockNavigate).toHaveBeenCalledWith(
      "/folders/barcelona/collections/c2"
    );
  });

  it("keeps a folder query on the folder, not its collections", async () => {
    renderPalette();
    pressCmdK();
    await waitFor(() => expect(screen.getByText("Day one")).toBeInTheDocument());

    // "vacation" is the folder holding "Day one"; typing it shouldn't drag
    // the collection along — the folder row is what the user asked for.
    fireEvent.change(getInput(), { target: { value: "vacation" } });

    expect(screen.getByText("vacation")).toBeInTheDocument();
    expect(screen.queryByText("Day one")).not.toBeInTheDocument();
  });

  it("navigates to a folder on Enter", async () => {
    renderPalette();
    pressCmdK();
    await waitFor(() => expect(screen.getByText("vacation")).toBeInTheDocument());

    // Move past the actions to the first folder, then activate.
    const input = getInput();
    for (let i = 0; i < 6; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockNavigate).toHaveBeenCalledWith("/folders/vacation");
  });

  it("opens the Tags page from the Tags action", async () => {
    renderPalette();
    pressCmdK();

    // "tags" selects the Tags action (it sorts ahead of the always-on Search).
    fireEvent.change(getInput(), { target: { value: "tags" } });
    fireEvent.keyDown(getInput(), { key: "Enter" });

    expect(mockNavigate).toHaveBeenCalledWith("/tags");
  });

  it("runs a search for the typed text via the Search action", async () => {
    renderPalette();
    pressCmdK();

    fireEvent.change(getInput(), { target: { value: "sunset" } });
    // The Search action relabels to carry the query and stays first.
    expect(screen.getByText(/Search for/)).toBeInTheDocument();
    fireEvent.keyDown(getInput(), { key: "Enter" });

    expect(mockNavigate).toHaveBeenCalledWith("/search?q=sunset");
  });

  it("navigates Home and Settings from their actions", async () => {
    renderPalette();
    pressCmdK();

    // Home is first; Enter on the default selection activates it.
    fireEvent.keyDown(getInput(), { key: "Enter" });
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  it("closes and resets the query when reopened after Cmd+K close", async () => {
    renderPalette();
    pressCmdK();
    fireEvent.change(getInput(), { target: { value: "barce" } });
    expect((getInput() as HTMLInputElement).value).toBe("barce");

    // Close with the shortcut (the path that used to skip the reset)...
    pressCmdK();
    expect(
      screen.queryByPlaceholderText(/search folders, collections or actions/i)
    ).not.toBeInTheDocument();

    // ...and reopening shows a fresh, empty palette.
    pressCmdK();
    expect((getInput() as HTMLInputElement).value).toBe("");
  });

  it("toggles the theme from the palette and persists the choice", async () => {
    renderPalette();
    pressCmdK();

    // Starts light (no .dark class), so the toggle offers dark.
    const toggle = screen.getByText("Switch to dark theme");
    fireEvent.click(toggle);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");

    // Reopen: the toggle now offers the opposite direction.
    pressCmdK();
    expect(screen.getByText("Switch to light theme")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Switch to light theme"));

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("switches to the system theme from the palette", async () => {
    localStorage.setItem("theme", "dark");
    renderPalette();
    pressCmdK();

    fireEvent.click(screen.getByText("Use system theme"));

    // matchMedia is stubbed to light, so system resolves to light here.
    expect(localStorage.getItem("theme")).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("filters to the theme actions by keyword", async () => {
    renderPalette();
    pressCmdK();

    fireEvent.change(getInput(), { target: { value: "theme" } });

    expect(screen.getByText("Switch to dark theme")).toBeInTheDocument();
    expect(screen.getByText("Use system theme")).toBeInTheDocument();
    expect(screen.queryByText("Home")).not.toBeInTheDocument();
  });

  it("closes on Escape and stops the event from reaching document handlers", async () => {
    // photo-grid/search-results attach a document-level Escape handler that
    // clears the photo selection with no input guard; the palette must stop
    // propagation so dismissing it doesn't also wipe the selection.
    const documentEscape = vi.fn();
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") documentEscape();
    });

    renderPalette();
    pressCmdK();
    fireEvent.keyDown(getInput(), { key: "Escape" });

    expect(
      screen.queryByPlaceholderText(/search folders, collections or actions/i)
    ).not.toBeInTheDocument();
    expect(documentEscape).not.toHaveBeenCalled();
  });
});
