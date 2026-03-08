import { describe, it, expect, vi, beforeEach } from "vitest";

const mockResults: Record<string, unknown>[] = [];

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => mockResults,
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => [{ id: "1", filename: "renamed.jpg", folder: "moved", s3Key: "moved/renamed.jpg" }],
        }),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  photos: {
    id: "id",
    folder: "folder",
    createdAt: "created_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  desc: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  CopyObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn(),
  ListObjectsV2Command: vi.fn(),
}));

vi.mock("@/lib/s3", () => ({
  s3: {
    send: vi.fn().mockResolvedValue({}),
  },
  S3_BUCKET: "test-bucket",
}));

const { NextRequest } = await import("next/server");

beforeEach(() => {
  vi.clearAllMocks();
  mockResults.length = 0;
});

describe("GET /api/photos", () => {
  it("returns 400 when folder param is missing", async () => {
    const { GET } = await import("@/app/api/photos/route");
    const req = new NextRequest("http://localhost/api/photos");
    const res = await GET(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("folder is required");
  });

  it("returns photos for a given folder", async () => {
    const { GET } = await import("@/app/api/photos/route");
    const req = new NextRequest("http://localhost/api/photos?folder=vacation");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("photos");
  });
});

describe("PATCH /api/photos/:id", () => {
  it("returns 404 when photo not found", async () => {
    // Override the select to return empty
    vi.doMock("@/db", () => ({
      db: {
        select: () => ({
          from: () => ({
            where: () => [],
          }),
        }),
      },
    }));

    const { PATCH } = await import("@/app/api/photos/[id]/route");
    const req = new NextRequest("http://localhost/api/photos/nonexistent", {
      method: "PATCH",
      body: JSON.stringify({ folder: "new-folder" }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: "nonexistent" }) });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/photos/:id", () => {
  it("returns 404 when photo not found", async () => {
    vi.doMock("@/db", () => ({
      db: {
        select: () => ({
          from: () => ({
            where: () => [],
          }),
        }),
      },
    }));

    const { DELETE } = await import("@/app/api/photos/[id]/route");
    const req = new NextRequest("http://localhost/api/photos/nonexistent", {
      method: "DELETE",
    });

    const res = await DELETE(req, { params: Promise.resolve({ id: "nonexistent" }) });
    expect(res.status).toBe(404);
  });
});
