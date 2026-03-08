import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/client-s3", () => ({
  GetObjectCommand: vi.fn(),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://s3.example.com/signed-url"),
}));

vi.mock("@/lib/s3", () => ({
  s3: {},
  S3_BUCKET: "test-bucket",
}));

const { NextRequest } = await import("next/server");
const { GET } = await import("@/app/api/images/route");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/images", () => {
  it("returns 400 when key param is missing", async () => {
    const req = new NextRequest("http://localhost/api/images");
    const res = await GET(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("key is required");
  });

  it("redirects to a signed S3 URL", async () => {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");

    const req = new NextRequest(
      "http://localhost/api/images?key=vacation/beach_640.webp"
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://s3.example.com/signed-url"
    );
    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: "test-bucket",
      Key: "vacation/beach_640.webp",
    });
  });
});
