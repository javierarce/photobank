import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { FolderList } from "@/components/folder-list";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("FolderList", () => {
  it("shows loading state initially", () => {
    vi.spyOn(global, "fetch").mockReturnValueOnce(new Promise(() => {}));
    render(<FolderList />);

    expect(screen.getByText("Loading folders...")).toBeInTheDocument();
  });

  it("shows empty state when no folders exist", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ folders: [] }),
    } as Response);

    render(<FolderList />);

    await waitFor(() => {
      expect(
        screen.getByText("No folders yet. Upload some photos to get started.")
      ).toBeInTheDocument();
    });
  });

  it("renders folders with counts", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          folders: [
            { folder: "vacation", count: 12, latest: "2026-01-01" },
            { folder: "barcelona", count: 1, latest: "2026-02-01" },
          ],
        }),
    } as Response);

    render(<FolderList />);

    await waitFor(() => {
      expect(screen.getByText("vacation")).toBeInTheDocument();
      expect(screen.getByText("12 photos")).toBeInTheDocument();
      expect(screen.getByText("barcelona")).toBeInTheDocument();
      expect(screen.getByText("1 photo")).toBeInTheDocument();
    });
  });

  it("links to the correct folder pages", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          folders: [{ folder: "inbox", count: 5, latest: "2026-01-01" }],
        }),
    } as Response);

    render(<FolderList />);

    await waitFor(() => {
      const link = screen.getByText("inbox").closest("a");
      expect(link?.getAttribute("href")).toBe("/folders/inbox");
    });
  });

  it("encodes folder names with special characters in links", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          folders: [
            { folder: "my photos", count: 3, latest: "2026-01-01" },
          ],
        }),
    } as Response);

    render(<FolderList />);

    await waitFor(() => {
      const link = screen.getByText("my photos").closest("a");
      expect(link?.getAttribute("href")).toBe("/folders/my%20photos");
    });
  });
});
