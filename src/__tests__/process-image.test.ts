import { describe, it, expect } from "vitest";
import sharp from "sharp";

const VARIANTS = [
  { width: 128, suffix: "128" },
  { width: 640, suffix: "640" },
  { width: 1280, suffix: "1280" },
  { width: 2880, suffix: "2880" },
] as const;

const FORMATS = ["jpeg", "webp"] as const;

// Create a test image buffer (red 4000x3000 pixel image)
async function createTestImage(width = 4000, height = 3000) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer();
}

describe("image processing pipeline", () => {
  it("generates all 8 variants (4 resolutions × 2 formats)", async () => {
    const original = await createTestImage();
    const results: { suffix: string; format: string; width: number }[] = [];

    for (const variant of VARIANTS) {
      const resized = sharp(original).resize(variant.width, undefined, {
        withoutEnlargement: true,
      });

      for (const format of FORMATS) {
        const buffer =
          format === "jpeg"
            ? await resized.clone().jpeg({ quality: 85 }).toBuffer()
            : await resized.clone().webp({ quality: 85 }).toBuffer();

        const meta = await sharp(buffer).metadata();
        results.push({
          suffix: variant.suffix,
          format,
          width: meta.width!,
        });
      }
    }

    expect(results).toHaveLength(8);
  });

  it("resizes to exact target widths", async () => {
    const original = await createTestImage(4000, 3000);

    for (const variant of VARIANTS) {
      const buffer = await sharp(original)
        .resize(variant.width, undefined, { withoutEnlargement: true })
        .jpeg()
        .toBuffer();

      const meta = await sharp(buffer).metadata();
      expect(meta.width).toBe(variant.width);
    }
  });

  it("does not enlarge images smaller than the target resolution", async () => {
    const smallImage = await createTestImage(100, 75);

    const buffer = await sharp(smallImage)
      .resize(2880, undefined, { withoutEnlargement: true })
      .jpeg()
      .toBuffer();

    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(100);
  });

  it("preserves aspect ratio when resizing", async () => {
    const original = await createTestImage(4000, 3000); // 4:3 ratio

    for (const variant of VARIANTS) {
      const buffer = await sharp(original)
        .resize(variant.width, undefined, { withoutEnlargement: true })
        .jpeg()
        .toBuffer();

      const meta = await sharp(buffer).metadata();
      const expectedHeight = Math.round((variant.width * 3000) / 4000);
      expect(meta.height).toBe(expectedHeight);
    }
  });

  it("produces valid JPEG output", async () => {
    const original = await createTestImage();
    const buffer = await sharp(original)
      .resize(640, undefined, { withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const meta = await sharp(buffer).metadata();
    expect(meta.format).toBe("jpeg");
  });

  it("produces valid WebP output", async () => {
    const original = await createTestImage();
    const buffer = await sharp(original)
      .resize(640, undefined, { withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    const meta = await sharp(buffer).metadata();
    expect(meta.format).toBe("webp");
  });

  it("generates correct S3 keys for variants", () => {
    const s3Key = "barcelona/2026-03-06-R0018076.jpg";
    const baseName = s3Key.replace(/\.[^.]+$/, "");

    const expectedKeys = [
      "barcelona/2026-03-06-R0018076_128.jpg",
      "barcelona/2026-03-06-R0018076_128.webp",
      "barcelona/2026-03-06-R0018076_640.jpg",
      "barcelona/2026-03-06-R0018076_640.webp",
      "barcelona/2026-03-06-R0018076_1280.jpg",
      "barcelona/2026-03-06-R0018076_1280.webp",
      "barcelona/2026-03-06-R0018076_2880.jpg",
      "barcelona/2026-03-06-R0018076_2880.webp",
    ];

    const generatedKeys: string[] = [];
    for (const variant of VARIANTS) {
      for (const format of FORMATS) {
        const ext = format === "jpeg" ? "jpg" : "webp";
        generatedKeys.push(`${baseName}_${variant.suffix}.${ext}`);
      }
    }

    expect(generatedKeys).toEqual(expectedKeys);
  });
});
