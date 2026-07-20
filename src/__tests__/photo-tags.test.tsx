import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { PhotoTags } from "@/components/photo-tags";
import {
  addPhotoTag,
  getPhotoTags,
  listTags,
  removePhotoTag,
} from "@/lib/api";

vi.mock("@/lib/api", () => ({
  getPhotoTags: vi.fn(),
  listTags: vi.fn(),
  addPhotoTag: vi.fn(),
  removePhotoTag: vi.fn(),
}));

const mockGetPhotoTags = vi.mocked(getPhotoTags);
const mockListTags = vi.mocked(listTags);
const mockAddPhotoTag = vi.mocked(addPhotoTag);
const mockRemovePhotoTag = vi.mocked(removePhotoTag);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPhotoTags.mockResolvedValue([{ id: "t1", name: "Landscape" }]);
  mockListTags.mockResolvedValue([
    { id: "t1", name: "Landscape" },
    { id: "t2", name: "Portrait" },
    { id: "t3", name: "Street" },
  ]);
  mockAddPhotoTag.mockResolvedValue({ id: "t4", name: "NewTag" });
  mockRemovePhotoTag.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("PhotoTags", () => {
  it("fetches and renders existing tags", async () => {
    render(<PhotoTags photoId="p1" />);

    await waitFor(() => {
      expect(screen.getByText("Landscape")).toBeInTheDocument();
    });
  });

  it("fetches tags for the correct photo", async () => {
    render(<PhotoTags photoId="photo-123" />);

    await waitFor(() => {
      expect(mockGetPhotoTags).toHaveBeenCalledWith("photo-123");
    });
  });

  it("adds a new tag on Enter", async () => {
    render(<PhotoTags photoId="p1" />);

    await waitFor(() => {
      expect(screen.getByText("Landscape")).toBeInTheDocument();
    });

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "NewTag" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockAddPhotoTag).toHaveBeenCalledWith("p1", "NewTag");
    });
    expect(screen.getByText("NewTag")).toBeInTheDocument();
  });

  it("removes a tag when × is clicked", async () => {
    render(<PhotoTags photoId="p1" />);

    await waitFor(() => {
      expect(screen.getByText("Landscape")).toBeInTheDocument();
    });

    const removeButton = screen.getByText("×");
    fireEvent.click(removeButton);

    await waitFor(() => {
      expect(mockRemovePhotoTag).toHaveBeenCalledWith("p1", "t1");
    });
    expect(screen.queryByText("Landscape")).not.toBeInTheDocument();
  });

  it("shows tag suggestions while typing", async () => {
    render(<PhotoTags photoId="p1" />);

    await waitFor(() => {
      expect(screen.getByText("Landscape")).toBeInTheDocument();
    });

    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Por" } });

    await waitFor(() => {
      expect(screen.getByText("Portrait")).toBeInTheDocument();
    });
    // "Landscape" is already applied so shouldn't appear as suggestion
    // "Street" doesn't match "Por" so shouldn't appear
    expect(screen.queryByText("Street")).not.toBeInTheDocument();
  });

  it("clears input after adding a tag", async () => {
    render(<PhotoTags photoId="p1" />);

    await waitFor(() => {
      expect(screen.getByText("Landscape")).toBeInTheDocument();
    });

    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "NewTag" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(input.value).toBe("");
    });
  });
});
