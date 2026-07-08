import { describe, it, expect, vi, beforeEach } from "vitest";

describe("image-url", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns proxy URL when CDN_URL is not set", async () => {
    vi.stubEnv("NEXT_PUBLIC_CDN_URL", "");
    const { imageUrl } = await import("@/lib/image-url");

    expect(imageUrl("inbox/photo.jpg", "640", "webp")).toBe(
      "/api/images?key=inbox%2Fphoto_640.webp"
    );
  });

  it("returns CDN URL when CDN_URL is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_CDN_URL", "https://img.example.com");
    const { imageUrl } = await import("@/lib/image-url");

    expect(imageUrl("inbox/photo.jpg", "640", "webp")).toBe(
      "https://img.example.com/inbox/photo_640.webp"
    );
  });

  it("percent-encodes special characters in CDN URLs", async () => {
    vi.stubEnv("NEXT_PUBLIC_CDN_URL", "https://img.example.com");
    const { imageUrl } = await import("@/lib/image-url");

    expect(imageUrl("my photos/café #1.jpg", "640", "webp")).toBe(
      "https://img.example.com/my%20photos/caf%C3%A9%20%231_640.webp"
    );
  });

  it("builds correct variant keys for different resolutions and formats", async () => {
    vi.stubEnv("NEXT_PUBLIC_CDN_URL", "");
    const { imageUrl } = await import("@/lib/image-url");

    expect(imageUrl("folder/img.png", "1280", "jpg")).toBe(
      "/api/images?key=folder%2Fimg_1280.jpg"
    );
    expect(imageUrl("folder/img.png", "2880", "webp")).toBe(
      "/api/images?key=folder%2Fimg_2880.webp"
    );
  });

  it("returns original URL via originalUrl", async () => {
    vi.stubEnv("NEXT_PUBLIC_CDN_URL", "");
    const { originalUrl } = await import("@/lib/image-url");

    expect(originalUrl("inbox/photo.jpg")).toBe(
      "/api/images?key=inbox%2Fphoto.jpg"
    );
  });
});
