import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TagList } from "@/components/tag-list";
import { deleteTag, listTagCounts, renameTag } from "@/lib/api";
import { ask } from "@tauri-apps/plugin-dialog";

vi.mock("@/lib/api", () => ({
  listTagCounts: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

const mockListTagCounts = vi.mocked(listTagCounts);
const mockRenameTag = vi.mocked(renameTag);
const mockDeleteTag = vi.mocked(deleteTag);
const mockAsk = vi.mocked(ask);

beforeEach(() => {
  vi.clearAllMocks();
  mockListTagCounts.mockResolvedValue([
    { id: "t1", name: "beach", count: 3 },
    { id: "t2", name: "sunset", count: 1 },
    { id: "t3", name: "draft", count: 0 },
  ]);
  mockRenameTag.mockResolvedValue({ id: "t1", name: "shore" });
  mockDeleteTag.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

function renderList() {
  render(
    <MemoryRouter>
      <TagList />
    </MemoryRouter>
  );
}

/** Open a row's overflow menu so its Rename/Delete items are reachable. */
function openRowMenu(name: string) {
  fireEvent.click(screen.getByLabelText(`Actions for ${name}`));
}

/** Rendered tag names in DOM order (excludes the count/label spans). */
function tagOrder() {
  return screen
    .getAllByText(/^(beach|sunset|draft)$/)
    .map((el) => el.textContent);
}

describe("TagList", () => {
  it("lists tags with counts and links to their photos", async () => {
    renderList();
    const beach = await screen.findByText("beach");
    // A typed tag query so the search bar shows "tag:beach" for refining.
    expect(beach.closest("a")?.getAttribute("href")).toBe(
      "/search?q=tag%3Abeach"
    );
    expect(screen.getByText("3 photos")).toBeInTheDocument();
    expect(screen.getByText("1 photo")).toBeInTheDocument();
  });

  it("does not link a tag with zero photos", async () => {
    renderList();
    const draft = await screen.findByText("draft");
    expect(draft.closest("a")).toBeNull();
    expect(screen.getByText("0 photos")).toBeInTheDocument();
  });

  it("filters the list by name", async () => {
    renderList();
    await screen.findByText("beach");

    fireEvent.change(screen.getByPlaceholderText("Search tags..."), {
      target: { value: "sun" },
    });

    expect(screen.getByText("sunset")).toBeInTheDocument();
    expect(screen.queryByText("beach")).not.toBeInTheDocument();
    expect(screen.queryByText("draft")).not.toBeInTheDocument();
  });

  it("sorts by name by default and by photo count on demand", async () => {
    renderList();
    await screen.findByText("beach");
    // Name order: beach, draft, sunset.
    expect(tagOrder()).toEqual(["beach", "draft", "sunset"]);

    fireEvent.click(screen.getByLabelText("Sort tags"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Photos/ }));
    // Count order (desc): beach (3), sunset (1), draft (0).
    expect(tagOrder()).toEqual(["beach", "sunset", "draft"]);
  });

  it("renames a tag from its menu on Enter", async () => {
    renderList();
    await screen.findByText("beach");

    openRowMenu("beach");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByLabelText("Rename tag beach") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "shore" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(mockRenameTag).toHaveBeenCalledWith("t1", "shore")
    );
    // The list reloads after a rename (a merge can change the set).
    expect(mockListTagCounts).toHaveBeenCalledTimes(2);
  });

  it("does not call renameTag when the name is unchanged", async () => {
    renderList();
    await screen.findByText("beach");

    openRowMenu("beach");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByLabelText("Rename tag beach");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockRenameTag).not.toHaveBeenCalled();
  });

  it("deletes a tag from its menu after confirmation", async () => {
    mockAsk.mockResolvedValue(true);
    renderList();
    await screen.findByText("beach");

    openRowMenu("beach");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(mockDeleteTag).toHaveBeenCalledWith("t1"));
    // Removed from the list immediately.
    await waitFor(() =>
      expect(screen.queryByText("beach")).not.toBeInTheDocument()
    );
  });

  it("does not delete when the confirmation is declined", async () => {
    mockAsk.mockResolvedValue(false);
    renderList();
    await screen.findByText("beach");

    openRowMenu("beach");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(mockAsk).toHaveBeenCalled());
    expect(mockDeleteTag).not.toHaveBeenCalled();
    expect(screen.getByText("beach")).toBeInTheDocument();
  });

  it("shows an empty state when there are no tags", async () => {
    mockListTagCounts.mockResolvedValue([]);
    renderList();
    expect(await screen.findByText(/No tags yet/)).toBeInTheDocument();
  });
});
