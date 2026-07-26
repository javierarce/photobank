import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useState } from "react";
import { SearchField } from "@/components/search-field";
import { listFolderFacets, listSearchFacets, listTags } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  // Whole-library pools — used only in unscoped mode.
  listTags: vi.fn(() => Promise.resolve([{ id: "1", name: "sunset" }])),
  listFolders: vi.fn(() => Promise.resolve([{ folder: "trips", count: 1 }])),
  listSearchFacets: vi.fn(() =>
    Promise.resolve({ makes: ["FUJIFILM"], models: [], lenses: [] })
  ),
  // Folder-scoped pool — used when a folder is passed.
  listFolderFacets: vi.fn(() =>
    Promise.resolve({
      tags: ["beach"],
      makes: ["Canon"],
      models: [],
      lenses: [],
    })
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// A controlled harness so typing updates the field like a real consumer.
function Harness({ folder }: { folder?: string }) {
  const [value, setValue] = useState("");
  return (
    <SearchField
      value={value}
      onChange={setValue}
      folder={folder}
      ariaLabel="Search this folder"
      placeholder="Search"
    />
  );
}

describe("SearchField folder scoping", () => {
  it("loads folder-scoped pools when given a folder", async () => {
    render(<Harness folder="trips" />);

    // Only the folder-scoped loader runs; the global ones stay untouched.
    expect(vi.mocked(listFolderFacets)).toHaveBeenCalledWith("trips");
    expect(vi.mocked(listTags)).not.toHaveBeenCalled();
    expect(vi.mocked(listSearchFacets)).not.toHaveBeenCalled();

    // Suggestions come from the folder's own tags.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "tag:be" },
    });
    expect(
      await screen.findByRole("option", { name: /beach/i })
    ).toBeInTheDocument();
    // The whole-library tag never appears in scoped mode.
    expect(screen.queryByRole("option", { name: /sunset/i })).toBeNull();
  });

  it("never suggests the folder: qualifier in a scoped field", () => {
    render(<Harness folder="trips" />);

    // Reveal the full qualifier list (ArrowDown on an empty input).
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /tag:/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^folder:/i })).toBeNull();

    // Typing "fol" must not resurface it either.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "fol" } });
    expect(screen.queryByRole("option", { name: /folder:/i })).toBeNull();
  });

  it("refreshes the folder pools on focus so newly-added tags appear", async () => {
    const scoped = vi.mocked(listFolderFacets);
    // First load: no tags yet. After the user tags a photo, the next load
    // includes it.
    scoped.mockResolvedValueOnce({
      tags: [],
      makes: [],
      models: [],
      lenses: [],
    });
    scoped.mockResolvedValueOnce({
      tags: ["fresh"],
      makes: [],
      models: [],
      lenses: [],
    });

    render(<Harness folder="trips" />);
    const input = screen.getByRole("textbox");

    // Let the mount load actually settle first — a focus that races it is
    // deliberately collapsed into the in-flight request (covered separately),
    // so flush the pending promise rather than only its call.
    await vi.waitFor(() => expect(scoped).toHaveBeenCalledTimes(1));
    await act(async () => {});

    // Focusing then re-fetches, so a tag added since mount shows up.
    fireEvent.focus(input);
    await vi.waitFor(() => expect(scoped).toHaveBeenCalledTimes(2));

    fireEvent.change(input, { target: { value: "tag:fr" } });
    expect(
      await screen.findByRole("option", { name: /fresh/i })
    ).toBeInTheDocument();
  });

  it("collapses focus churn into a single in-flight pool load", async () => {
    const scoped = vi.mocked(listFolderFacets);
    let settle!: () => void;
    scoped.mockReturnValueOnce(
      new Promise((res) => {
        settle = () => res({ tags: [], makes: [], models: [], lenses: [] });
      })
    );

    render(<Harness folder="trips" />);
    const input = screen.getByRole("textbox");

    // Clicking in and out repeatedly while the first load is still running must
    // not pile up duplicate catalog scans.
    fireEvent.focus(input);
    fireEvent.blur(input);
    fireEvent.focus(input);
    expect(scoped).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
    });
  });

  it("uses the whole-library pools when no folder is given", async () => {
    render(<Harness />);

    expect(vi.mocked(listTags)).toHaveBeenCalled();
    expect(vi.mocked(listFolderFacets)).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "tag:sun" },
    });
    expect(
      await screen.findByRole("option", { name: /sunset/i })
    ).toBeInTheDocument();
  });
});
