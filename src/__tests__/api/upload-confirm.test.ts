import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueueAdd = vi.fn();

vi.mock("@/lib/queue", () => ({
  imageQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
  },
}));

let mockDbPhotos: { id: string; s3Key: string }[] = [];

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => mockDbPhotos,
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  photos: { id: "id", s3Key: "s3_key" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

const { NextRequest } = await import("next/server");
const { POST } = await import("@/app/api/upload/confirm/route");

beforeEach(() => {
  vi.clearAllMocks();
  mockDbPhotos = [{ id: "p1", s3Key: "inbox/photo.jpg" }];
});

describe("POST /api/upload/confirm", () => {
  it("returns 400 when no photoIds provided", async () => {
    const req = new NextRequest("http://localhost/api/upload/confirm", {
      method: "POST",
      body: JSON.stringify({ photoIds: [] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("queues image processing for valid photos", async () => {
    const req = new NextRequest("http://localhost/api/upload/confirm", {
      method: "POST",
      body: JSON.stringify({ photoIds: ["p1"] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.results).toEqual([{ photoId: "p1", queued: true }]);
    expect(mockQueueAdd).toHaveBeenCalledWith("process", {
      photoId: "p1",
      s3Key: "inbox/photo.jpg",
    });
  });

  it("marks non-existent photos as not queued", async () => {
    mockDbPhotos = [];

    const req = new NextRequest("http://localhost/api/upload/confirm", {
      method: "POST",
      body: JSON.stringify({ photoIds: ["nonexistent"] }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(body.results).toEqual([
      { photoId: "nonexistent", queued: false },
    ]);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
