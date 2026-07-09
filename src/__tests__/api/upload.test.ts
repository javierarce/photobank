import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/client-s3", () => ({
  PutObjectCommand: vi.fn(),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://s3.example.com/presigned"),
}));

vi.mock("@/lib/s3", () => ({
  s3: {},
  S3_BUCKET: "test-bucket",
}));

vi.mock("@/db", () => ({
  db: {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () => [{ id: "photo-123" }],
        }),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  photos: {
    folder: "folder",
    filename: "filename",
  },
}));

const { NextRequest } = await import("next/server");
const { POST } = await import("@/app/api/upload/route");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/upload", () => {
  it("returns 400 when no files provided", async () => {
    const req = new NextRequest("http://localhost/api/upload", {
      method: "POST",
      body: JSON.stringify({ files: [] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns presigned URLs for each file", async () => {
    const req = new NextRequest("http://localhost/api/upload", {
      method: "POST",
      body: JSON.stringify({
        folder: "vacation",
        files: [
          { filename: "beach.jpg", contentType: "image/jpeg", size: 1024 },
        ],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.uploads).toHaveLength(1);
    expect(body.uploads[0]).toEqual({
      id: "photo-123",
      filename: "beach.jpg",
      presignedUrl: "https://s3.example.com/presigned",
    });
  });

  it("uses inbox as default folder", async () => {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");

    const req = new NextRequest("http://localhost/api/upload", {
      method: "POST",
      body: JSON.stringify({
        files: [
          { filename: "photo.jpg", contentType: "image/jpeg", size: 512 },
        ],
      }),
    });

    await POST(req);

    expect(PutObjectCommand).toHaveBeenCalledWith({
      Bucket: "test-bucket",
      Key: "inbox/photo.jpg",
      ContentType: "image/jpeg",
    });
  });

  it("strips directory components from filenames", async () => {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");

    const req = new NextRequest("http://localhost/api/upload", {
      method: "POST",
      body: JSON.stringify({
        files: [
          { filename: "../../etc/passwd.jpg", contentType: "image/jpeg", size: 1 },
        ],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({ Key: "inbox/passwd.jpg" })
    );
  });

  it("rejects invalid folders and filenames", async () => {
    const badFolder = new NextRequest("http://localhost/api/upload", {
      method: "POST",
      body: JSON.stringify({
        folder: "a/b",
        files: [{ filename: "ok.jpg", contentType: "image/jpeg", size: 1 }],
      }),
    });
    expect((await POST(badFolder)).status).toBe(400);

    const badFilename = new NextRequest("http://localhost/api/upload", {
      method: "POST",
      body: JSON.stringify({
        files: [{ filename: "..", contentType: "image/jpeg", size: 1 }],
      }),
    });
    expect((await POST(badFilename)).status).toBe(400);
  });

  it("handles multiple files in a single request", async () => {
    const req = new NextRequest("http://localhost/api/upload", {
      method: "POST",
      body: JSON.stringify({
        folder: "barcelona",
        files: [
          { filename: "img1.jpg", contentType: "image/jpeg", size: 100 },
          { filename: "img2.jpg", contentType: "image/jpeg", size: 200 },
          { filename: "img3.jpg", contentType: "image/jpeg", size: 300 },
        ],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(body.uploads).toHaveLength(3);
  });
});
