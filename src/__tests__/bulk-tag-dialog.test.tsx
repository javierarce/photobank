import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { BulkTagDialog } from "@/components/bulk-tag-dialog";
import {
  addTagsToPhotos,
  getTagsForPhotos,
  listTags,
  removeTagsFromPhotos,
} from "@/lib/api";
import { makePhoto } from "./fixtures";

vi.mock("@/lib/api", () => ({
  listTags: vi.fn(),
  getTagsForPhotos: vi.fn(),
  addTagsToPhotos: vi.fn(),
  removeTagsFromPhotos: vi.fn(),
}));

const mockListTags = vi.mocked(listTags);
const mockGetTagsForPhotos = vi.mocked(getTagsForPhotos);
const mockAddTagsToPhotos = vi.mocked(addTagsToPhotos);
const mockRemoveTagsFromPhotos = vi.mocked(removeTagsFromPhotos);

const photos = [
  makePhoto({ id: "1", filename: "a.jpg" }),
  makePhoto({ id: "2", filename: "b.jpg" }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockListTags.mockResolvedValue([
    { id: "t1", name: "beach" },
    { id: "t2", name: "sunset" },
    { id: "t3", name: "mountain" },
  ]);
  // "beach" is on both photos (full); "sunset" only on photo 1 (partial).
  mockGetTagsForPhotos.mockResolvedValue({
    "1": [
      { id: "t1", name: "beach" },
      { id: "t2", name: "sunset" },
    ],
    "2": [{ id: "t1", name: "beach" }],
  });
  mockAddTagsToPhotos.mockResolvedValue(undefined);
  mockRemoveTagsFromPhotos.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

function renderDialog(onApplied = vi.fn(), onClose = vi.fn()) {
  render(
    <BulkTagDialog photos={photos} onClose={onClose} onApplied={onApplied} />
  );
  return { onApplied, onClose };
}

describe("BulkTagDialog", () => {
  it("shows the selection count and per-tag usage checklist", async () => {
    renderDialog();
    expect(screen.getByText("Edit Tags · 2 photos")).toBeInTheDocument();
    // Usage counts render once the photos' tags load.
    expect(await screen.findByText("2 of 2")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByText("beach")).toBeInTheDocument();
    expect(screen.getByText("sunset")).toBeInTheDocument();
  });

  it("adds a typed tag to every selected photo on Apply", async () => {
    const { onApplied } = renderDialog();
    await screen.findByText("2 of 2");

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "mountain" } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(mockAddTagsToPhotos).toHaveBeenCalledWith(["1", "2"], ["mountain"])
    );
    expect(mockRemoveTagsFromPhotos).not.toHaveBeenCalled();
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it("folds uncommitted input text into the add on Apply", async () => {
    renderDialog();
    await screen.findByText("2 of 2");

    // Type but never press Enter — Apply must still pick it up.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "forest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(mockAddTagsToPhotos).toHaveBeenCalledWith(["1", "2"], ["forest"])
    );
  });

  it("removes a fully-applied tag when unchecked", async () => {
    renderDialog();
    await screen.findByText("2 of 2");

    // Checkboxes are ordered by tag name: [beach, sunset].
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]); // uncheck "beach" -> remove

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(mockRemoveTagsFromPhotos).toHaveBeenCalledWith(["1", "2"], [
        "beach",
      ])
    );
    expect(mockAddTagsToPhotos).not.toHaveBeenCalled();
  });

  it("adds a partially-applied tag to the rest when checked", async () => {
    renderDialog();
    await screen.findByText("1 of 2");

    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[1]); // "sunset" partial: keep -> add

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(mockAddTagsToPhotos).toHaveBeenCalledWith(["1", "2"], ["sunset"])
    );
  });

  it("keeps Apply disabled until there is something to do", async () => {
    renderDialog();
    await screen.findByText("2 of 2");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "new" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });
});
