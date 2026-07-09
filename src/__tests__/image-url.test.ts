import { describe, it, expect } from "vitest";
import { imageUrl, originalUrl } from "@/lib/image-url";

describe("image-url", () => {
  it("builds a photo:// URL for the default variant", () => {
    expect(imageUrl("inbox/photo.jpg")).toBe(
      "photo://localhost/inbox/photo_640.webp"
    );
  });

  it("builds correct variant keys for different resolutions and formats", () => {
    expect(imageUrl("folder/img.png", "1280", "jpg")).toBe(
      "photo://localhost/folder/img_1280.jpg"
    );
    expect(imageUrl("folder/img.png", "2880", "webp")).toBe(
      "photo://localhost/folder/img_2880.webp"
    );
  });

  it("percent-encodes special characters per path segment", () => {
    expect(imageUrl("my photos/café #1.jpg", "640", "webp")).toBe(
      "photo://localhost/my%20photos/caf%C3%A9%20%231_640.webp"
    );
  });

  it("returns the original object URL untouched by variant naming", () => {
    expect(originalUrl("inbox/photo.jpg")).toBe(
      "photo://localhost/inbox/photo.jpg"
    );
  });
});
