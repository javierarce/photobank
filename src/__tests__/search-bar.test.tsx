import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SearchBar } from "@/components/search-bar";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@/lib/api", () => ({
  listTags: vi.fn(() =>
    Promise.resolve([
      { id: "1", name: "sunset" },
      { id: "2", name: "night" },
    ])
  ),
  listFolders: vi.fn(() =>
    Promise.resolve([{ folder: "trips", count: 1 }])
  ),
  listSearchFacets: vi.fn(() =>
    Promise.resolve({ makes: ["FUJIFILM"], models: ["X100V"], lenses: [] })
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSearchBar(initialEntry = "/") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SearchBar />
    </MemoryRouter>
  );
}

function type(value: string) {
  const input = screen.getByPlaceholderText(/search/i);
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("SearchBar", () => {
  it("renders an input and a submit button", () => {
    renderSearchBar();
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^search$/i })).toBeInTheDocument();
  });

  it("navigates to /search with query on submit", () => {
    renderSearchBar();
    const input = type("barcelona");
    fireEvent.submit(input.closest("form")!);
    expect(mockNavigate).toHaveBeenCalledWith("/search?q=barcelona");
  });

  it("trims whitespace from the query", () => {
    renderSearchBar();
    const input = type("  city  ");
    fireEvent.submit(input.closest("form")!);
    expect(mockNavigate).toHaveBeenCalledWith("/search?q=city");
  });

  it("does not navigate when query is empty", () => {
    renderSearchBar();
    const input = type("   ");
    fireEvent.submit(input.closest("form")!);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("preserves typed qualifier queries verbatim on submit", () => {
    renderSearchBar();
    const input = type("camera:fuji iso:>=800");
    fireEvent.submit(input.closest("form")!);
    expect(mockNavigate).toHaveBeenCalledWith(
      "/search?q=camera%3Afuji%20iso%3A%3E%3D800"
    );
  });

  it("initializes with the q param from the URL", () => {
    renderSearchBar("/search?q=landscape");
    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
    expect(input.value).toBe("landscape");
  });

  it("highlights recognized qualifiers with the accent color", () => {
    const { container } = renderSearchBar();
    type("camera:fuji");
    const accent = container.querySelector(".text-accent");
    expect(accent).not.toBeNull();
    expect(accent).toHaveTextContent("camera:");
  });

  it("suggests qualifier keywords as you type a bare word", () => {
    renderSearchBar();
    type("cam");
    expect(
      screen.getByRole("option", { name: /camera:/i })
    ).toBeInTheDocument();
  });

  it("suggests catalog values after a recognized qualifier", async () => {
    renderSearchBar();
    type("tag:sun");
    // The tag pool loads asynchronously on mount.
    expect(
      await screen.findByRole("option", { name: /sunset/i })
    ).toBeInTheDocument();
  });

  it("accepts a value suggestion into the input with a trailing space", async () => {
    renderSearchBar();
    const input = type("tag:sun") as HTMLInputElement;
    const option = await screen.findByRole("option", { name: /sunset/i });
    fireEvent.mouseDown(option);
    expect(input.value).toBe("tag:sunset ");
  });

  it("navigates the suggestion list with the keyboard", async () => {
    renderSearchBar();
    const input = type("tag:") as HTMLInputElement;
    await screen.findByRole("option", { name: /sunset/i });
    // List is [none, sunset, night]; ArrowDown moves to sunset, Enter accepts.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("tag:sunset ");
    expect(mockNavigate).not.toHaveBeenCalled(); // Enter accepted, didn't submit
  });

  it("reveals the full qualifier list on ArrowDown from an empty input", () => {
    renderSearchBar();
    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.focus(input);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(5);
    expect(screen.getByRole("option", { name: /tag:/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /iso:/i })).toBeInTheDocument();
  });

  it("picks the highlighted qualifier from the revealed list", () => {
    renderSearchBar();
    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowDown" }); // reveal, tag: highlighted
    fireEvent.keyDown(input, { key: "ArrowDown" }); // move to folder:
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("folder:");
  });

  it("closes the suggestion list on Escape", () => {
    renderSearchBar();
    const input = type("cam");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
