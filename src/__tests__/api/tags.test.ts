import { describe, it, expect, vi, beforeEach } from "vitest";

let mockAllTags = [
  { id: "t1", name: "Landscape", createdAt: "2026-01-01" },
  { id: "t2", name: "Portrait", createdAt: "2026-01-02" },
];
let mockInsertReturning: Record<string, unknown>[] = [];

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        orderBy: () => mockAllTags,
        where: () => [{ id: "t1", name: "Landscape", createdAt: "2026-01-01" }],
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => mockInsertReturning,
        }),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  tags: { name: "name" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

const { NextRequest } = await import("next/server");
const { GET, POST } = await import("@/app/api/tags/route");

beforeEach(() => {
  vi.clearAllMocks();
  mockAllTags = [
    { id: "t1", name: "Landscape", createdAt: "2026-01-01" },
    { id: "t2", name: "Portrait", createdAt: "2026-01-02" },
  ];
  mockInsertReturning = [];
});

describe("GET /api/tags", () => {
  it("returns all tags", async () => {
    const res = await GET();
    const body = await res.json();

    expect(body.tags).toEqual(mockAllTags);
  });

  it("returns empty array when no tags exist", async () => {
    mockAllTags = [];
    const res = await GET();
    const body = await res.json();

    expect(body.tags).toEqual([]);
  });
});

describe("POST /api/tags", () => {
  it("returns 400 when name is missing", async () => {
    const req = new NextRequest("http://localhost/api/tags", {
      method: "POST",
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("name is required");
  });

  it("returns 400 when name is empty string", async () => {
    const req = new NextRequest("http://localhost/api/tags", {
      method: "POST",
      body: JSON.stringify({ name: "   " }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("creates a new tag and returns 201", async () => {
    mockInsertReturning = [{ id: "t3", name: "Street", createdAt: "2026-03-01" }];

    const req = new NextRequest("http://localhost/api/tags", {
      method: "POST",
      body: JSON.stringify({ name: "Street" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.tag.name).toBe("Street");
  });

  it("returns existing tag when name conflicts (upsert)", async () => {
    // onConflictDoNothing returns empty, so it falls through to SELECT
    mockInsertReturning = [];

    const req = new NextRequest("http://localhost/api/tags", {
      method: "POST",
      body: JSON.stringify({ name: "Landscape" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tag.name).toBe("Landscape");
  });

  it("trims whitespace from tag name", async () => {
    mockInsertReturning = [{ id: "t4", name: "Nature", createdAt: "2026-03-01" }];

    const req = new NextRequest("http://localhost/api/tags", {
      method: "POST",
      body: JSON.stringify({ name: "  Nature  " }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
  });
});
