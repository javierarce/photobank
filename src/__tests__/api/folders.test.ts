import { describe, it, expect, vi, beforeEach } from "vitest";

let mockFolders: { folder: string; count: number }[] = [];

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        groupBy: () => ({
          orderBy: () => mockFolders,
        }),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  photos: {
    folder: "folder",
    createdAt: "created_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  sql: () => "sql",
}));

const { GET } = await import("@/app/api/folders/route");

beforeEach(() => {
  vi.clearAllMocks();
  mockFolders = [];
});

describe("GET /api/folders", () => {
  it("returns empty array when no folders exist", async () => {
    const res = await GET();
    const body = await res.json();

    expect(body.folders).toEqual([]);
  });

  it("returns folders with counts", async () => {
    mockFolders = [
      { folder: "barcelona", count: 15 },
      { folder: "inbox", count: 3 },
    ];

    const res = await GET();
    const body = await res.json();

    expect(body.folders).toHaveLength(2);
    expect(body.folders[0]).toEqual({
      folder: "barcelona",
      count: 15,
    });
  });
});
