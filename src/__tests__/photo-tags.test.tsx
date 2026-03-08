import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { PhotoTags } from "@/components/photo-tags";

let fetchCalls: { url: string; options?: RequestInit }[] = [];

beforeEach(() => {
  fetchCalls = [];
  vi.spyOn(global, "fetch").mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, options: init });

      if (url.endsWith("/tags") && !init?.method) {
        // GET photo tags or all tags
        if (url.includes("/photos/")) {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                tags: [{ id: "t1", name: "Landscape" }],
              }),
          } as Response;
        }
        // GET /api/tags
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              tags: [
                { id: "t1", name: "Landscape" },
                { id: "t2", name: "Portrait" },
                { id: "t3", name: "Street" },
              ],
            }),
        } as Response;
      }

      if (init?.method === "POST") {
        return {
          ok: true,
          json: () =>
            Promise.resolve({ tag: { id: "t4", name: "NewTag" } }),
        } as Response;
      }

      if (init?.method === "DELETE") {
        return { ok: true, json: () => Promise.resolve({ deleted: true }) } as Response;
      }

      return { ok: true, json: () => Promise.resolve({}) } as Response;
    }
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
      expect(fetchCalls.some((c) => c.url === "/api/photos/photo-123/tags")).toBe(true);
    });
  });

  it("adds a new tag on Enter", async () => {
    render(<PhotoTags photoId="p1" />);

    await waitFor(() => {
      expect(screen.getByText("Landscape")).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("Add tag...");
    fireEvent.change(input, { target: { value: "NewTag" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      const postCall = fetchCalls.find((c) => c.options?.method === "POST");
      expect(postCall).toBeDefined();
      expect(JSON.parse(postCall!.options!.body as string)).toEqual({
        name: "NewTag",
      });
    });
  });

  it("removes a tag when × is clicked", async () => {
    render(<PhotoTags photoId="p1" />);

    await waitFor(() => {
      expect(screen.getByText("Landscape")).toBeInTheDocument();
    });

    const removeButton = screen.getByText("×");
    fireEvent.click(removeButton);

    await waitFor(() => {
      const deleteCall = fetchCalls.find(
        (c) => c.options?.method === "DELETE"
      );
      expect(deleteCall).toBeDefined();
      expect(JSON.parse(deleteCall!.options!.body as string)).toEqual({
        tagId: "t1",
      });
    });
  });

  it("shows tag suggestions while typing", async () => {
    render(<PhotoTags photoId="p1" />);

    await waitFor(() => {
      expect(screen.getByText("Landscape")).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("Add tag...");
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

    const input = screen.getByPlaceholderText("Add tag...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "NewTag" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(input.value).toBe("");
    });
  });
});
