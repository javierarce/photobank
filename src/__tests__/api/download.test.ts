import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";

let mockSelectedPhotos: { filename: string; s3Key: string }[] = [];

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => mockSelectedPhotos,
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  photos: { id: "id", filename: "filename", s3Key: "s3_key" },
}));

vi.mock("drizzle-orm", () => ({
  inArray: vi.fn(),
}));

const mockS3Send = vi.fn();

vi.mock("@/lib/s3", () => ({
  s3: { send: (...args: unknown[]) => mockS3Send(...args) },
  S3_BUCKET: "test-bucket",
}));

const getObjectSpy = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  GetObjectCommand: class {
    constructor(params: Record<string, unknown>) {
      getObjectSpy(params);
      Object.assign(this, params);
    }
  },
}));

const { NextRequest } = await import("next/server");
const { POST } = await import("@/app/api/download/route");

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectedPhotos = [];
  mockS3Send.mockResolvedValue({
    Body: Readable.from(Buffer.from("fake-image-data")),
  });
});

describe("POST /api/download", () => {
  it("returns 400 when no photoIds provided", async () => {
    const req = new NextRequest("http://localhost/api/download", {
      method: "POST",
      body: JSON.stringify({ photoIds: [] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 404 when no photos found", async () => {
    mockSelectedPhotos = [];

    const req = new NextRequest("http://localhost/api/download", {
      method: "POST",
      body: JSON.stringify({ photoIds: ["nonexistent"] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("returns a zip response with correct headers", async () => {
    mockSelectedPhotos = [
      { filename: "beach.jpg", s3Key: "vacation/beach.jpg" },
    ];

    const req = new NextRequest("http://localhost/api/download", {
      method: "POST",
      body: JSON.stringify({ photoIds: ["p1"] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="photos.zip"'
    );
  });

  it("requests the correct S3 key based on resolution and format", async () => {
    mockSelectedPhotos = [
      { filename: "photo.jpg", s3Key: "inbox/photo.jpg" },
    ];

    const req = new NextRequest("http://localhost/api/download", {
      method: "POST",
      body: JSON.stringify({
        photoIds: ["p1"],
        resolution: "1280",
        format: "webp",
      }),
    });

    await POST(req);

    expect(getObjectSpy).toHaveBeenCalledWith({
      Bucket: "test-bucket",
      Key: "inbox/photo_1280.webp",
    });
  });

  it("defaults to 2880 jpg when no resolution/format specified", async () => {
    mockSelectedPhotos = [
      { filename: "photo.jpg", s3Key: "inbox/photo.jpg" },
    ];

    const req = new NextRequest("http://localhost/api/download", {
      method: "POST",
      body: JSON.stringify({ photoIds: ["p1"] }),
    });

    await POST(req);

    expect(getObjectSpy).toHaveBeenCalledWith({
      Bucket: "test-bucket",
      Key: "inbox/photo_2880.jpg",
    });
  });

  it("skips photos that fail to download from S3", async () => {
    mockSelectedPhotos = [
      { filename: "good.jpg", s3Key: "inbox/good.jpg" },
      { filename: "missing.jpg", s3Key: "inbox/missing.jpg" },
    ];

    let callCount = 0;
    mockS3Send.mockImplementation(() => {
      callCount++;
      if (callCount === 2) throw new Error("NoSuchKey");
      return { Body: Readable.from(Buffer.from("image-data")) };
    });

    const req = new NextRequest("http://localhost/api/download", {
      method: "POST",
      body: JSON.stringify({ photoIds: ["p1", "p2"] }),
    });

    const res = await POST(req);
    // Should still return 200 — missing files are skipped
    expect(res.status).toBe(200);
  });
});
