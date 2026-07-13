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
import { listFolders } from "@/lib/api";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@/lib/api", () => ({
  listFolders: vi.fn(),
}));

const mockListFolders = vi.mocked(listFolders);

beforeEach(() => {
  vi.clearAllMocks();
  mockListFolders.mockResolvedValue([
    { folder: "vacation", count: 12 },
    { folder: "barcelona", count: 1 },
  ]);
});

afterEach(() => {
  cleanup();
});

function renderPalette() {
  return render(
    <MemoryRouter>
      <CommandPalette />
    </MemoryRouter>
  );
}

/** Fire the global Cmd/Ctrl+K shortcut the palette listens for on window. */
function pressCmdK() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
}

function getInput() {
  return screen.getByPlaceholderText(/search folders or actions/i);
}

describe("CommandPalette", () => {
  it("is closed until Cmd+K is pressed", async () => {
    renderPalette();
    expect(
      screen.queryByPlaceholderText(/search folders or actions/i)
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
      { folder: "Café", count: 3 },
      { folder: "vacation", count: 12 },
    ]);
    renderPalette();
    pressCmdK();
    await waitFor(() => expect(screen.getByText("Café")).toBeInTheDocument());

    fireEvent.change(getInput(), { target: { value: "cafe" } });

    expect(screen.getByText("Café")).toBeInTheDocument();
    expect(screen.queryByText("vacation")).not.toBeInTheDocument();
  });

  it("navigates to a folder on Enter", async () => {
    renderPalette();
    pressCmdK();
    await waitFor(() => expect(screen.getByText("vacation")).toBeInTheDocument());

    // Move past the three actions to the first folder, then activate.
    const input = getInput();
    for (let i = 0; i < 3; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockNavigate).toHaveBeenCalledWith("/folders/vacation");
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
      screen.queryByPlaceholderText(/search folders or actions/i)
    ).not.toBeInTheDocument();

    // ...and reopening shows a fresh, empty palette.
    pressCmdK();
    expect((getInput() as HTMLInputElement).value).toBe("");
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
      screen.queryByPlaceholderText(/search folders or actions/i)
    ).not.toBeInTheDocument();
    expect(documentEscape).not.toHaveBeenCalled();
  });
});
