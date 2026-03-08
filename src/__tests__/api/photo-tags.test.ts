import { describe, it, expect, vi, beforeEach } from "vitest";

let mockPhotoTags = [
  { id: "t1", name: "Landscape" },
  { id: "t2", name: "Mountain" },
];
let mockInsertReturning: Record<string, unknown>[] = [];
let mockSelectAfterConflict = [{ id: "t1", name: "Landscape" }];
const mockDelete = vi.fn().mockReturnValue({ where: vi.fn() });

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => mockPhotoTags,
        }),
        where: () => mockSelectAfterConflict,
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => mockInsertReturning,
        }),
      }),
    }),
    delete: () => ({
      where: vi.fn(),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  tags: { id: "id", name: "name" },
  photoTags: { photoId: "photo_id", tagId: "tag_id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));

const { NextRequest } = await import("next/server");
const { GET, POST, DELETE } = await import(
  "@/app/api/photos/[id]/tags/route"
);

beforeEach(() => {
  vi.clearAllMocks();
  mockPhotoTags = [
    { id: "t1", name: "Landscape" },
    { id: "t2", name: "Mountain" },
  ];
  mockInsertReturning = [];
  mockSelectAfterConflict = [{ id: "t1", name: "Landscape" }];
});

describe("GET /api/photos/:id/tags", () => {
  it("returns tags for a photo", async () => {
    const req = new NextRequest("http://localhost/api/photos/p1/tags");
    const res = await GET(req, { params: Promise.resolve({ id: "p1" }) });
    const body = await res.json();

    expect(body.tags).toEqual([
      { id: "t1", name: "Landscape" },
      { id: "t2", name: "Mountain" },
    ]);
  });

  it("returns empty array when photo has no tags", async () => {
    mockPhotoTags = [];
    const req = new NextRequest("http://localhost/api/photos/p1/tags");
    const res = await GET(req, { params: Promise.resolve({ id: "p1" }) });
    const body = await res.json();

    expect(body.tags).toEqual([]);
  });
});

describe("POST /api/photos/:id/tags", () => {
  it("returns 400 when name is missing", async () => {
    const req = new NextRequest("http://localhost/api/photos/p1/tags", {
      method: "POST",
      body: JSON.stringify({}),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 when name is empty", async () => {
    const req = new NextRequest("http://localhost/api/photos/p1/tags", {
      method: "POST",
      body: JSON.stringify({ name: "  " }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(400);
  });

  it("creates a new tag and links it to the photo", async () => {
    mockInsertReturning = [{ id: "t5", name: "Sunset" }];

    const req = new NextRequest("http://localhost/api/photos/p1/tags", {
      method: "POST",
      body: JSON.stringify({ name: "Sunset" }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.tag).toEqual({ id: "t5", name: "Sunset" });
  });

  it("uses existing tag when name already exists", async () => {
    // Insert returns empty (conflict), falls through to select
    mockInsertReturning = [];
    mockSelectAfterConflict = [{ id: "t1", name: "Landscape" }];

    const req = new NextRequest("http://localhost/api/photos/p1/tags", {
      method: "POST",
      body: JSON.stringify({ name: "Landscape" }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.tag.id).toBe("t1");
  });
});

describe("DELETE /api/photos/:id/tags", () => {
  it("removes a tag from a photo", async () => {
    const req = new NextRequest("http://localhost/api/photos/p1/tags", {
      method: "DELETE",
      body: JSON.stringify({ tagId: "t1" }),
    });

    const res = await DELETE(req, {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
  });
});
