import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return {
        from: (...a: unknown[]) => {
          mockFrom(...a);
          return {
            innerJoin: () => ({
              where: () => "subquery",
            }),
            where: (...w: unknown[]) => {
              mockWhere(...w);
              return {
                orderBy: (...o: unknown[]) => {
                  mockOrderBy(...o);
                  return {
                    limit: (...l: unknown[]) => {
                      mockLimit(...l);
                      return [];
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  },
}));

vi.mock("@/db/schema", () => ({
  photos: {
    id: "id",
    filename: "filename",
    folder: "folder",
    cameraMake: "camera_make",
    cameraModel: "camera_model",
    lens: "lens",
    createdAt: "created_at",
  },
  tags: { id: "id", name: "name" },
  photoTags: { photoId: "photo_id", tagId: "tag_id" },
}));

vi.mock("drizzle-orm", () => ({
  sql: () => "sql",
  eq: vi.fn((...args) => ({ type: "eq", args })),
  ilike: vi.fn((...args) => ({ type: "ilike", args })),
  or: vi.fn((...args) => ({ type: "or", args })),
  and: vi.fn((...args) => ({ type: "and", args })),
  inArray: vi.fn((...args) => ({ type: "inArray", args })),
}));

// Import after mocks
const { GET } = await import("@/app/api/search/route");
const { NextRequest } = await import("next/server");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/search", () => {
  it("returns empty photos when no query params provided", async () => {
    const req = new NextRequest("http://localhost/api/search");
    const res = await GET(req);
    const body = await res.json();

    expect(body).toEqual({ photos: [] });
  });

  it("searches by query parameter q", async () => {
    const req = new NextRequest("http://localhost/api/search?q=sunset");
    const res = await GET(req);
    const body = await res.json();

    expect(mockLimit).toHaveBeenCalledWith(200);
    expect(body).toEqual({ photos: [] });
  });

  it("searches by tag parameter", async () => {
    const req = new NextRequest("http://localhost/api/search?tag=landscape");
    await GET(req);

    expect(mockLimit).toHaveBeenCalledWith(200);
  });

  it("searches by camera parameter", async () => {
    const req = new NextRequest("http://localhost/api/search?camera=ricoh");
    await GET(req);

    expect(mockLimit).toHaveBeenCalledWith(200);
  });

  it("combines multiple search parameters", async () => {
    const req = new NextRequest(
      "http://localhost/api/search?q=beach&tag=summer&camera=canon"
    );
    await GET(req);

    expect(mockLimit).toHaveBeenCalledWith(200);
  });

  it("trims whitespace from query params", async () => {
    const req = new NextRequest("http://localhost/api/search?q=%20%20%20");
    const res = await GET(req);
    const body = await res.json();

    // Empty after trim means no conditions, returns empty
    expect(body).toEqual({ photos: [] });
  });
});
