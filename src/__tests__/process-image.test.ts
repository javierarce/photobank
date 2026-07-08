import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  VARIANT_WIDTHS,
  VARIANT_FORMATS,
  VARIANT_SUFFIXES,
  variantKey,
} from "@/lib/keys";
import { formatShutterSpeed, gpsToDecimal } from "@/worker/exif";

// Create a test image buffer (red 4000x3000 pixel image)
async function createTestImage(width = 4000, height = 3000) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer();
}

describe("formatShutterSpeed", () => {
  it("formats fractional exposures as 1/x", () => {
    expect(formatShutterSpeed(1 / 60)).toBe("1/60s");
    expect(formatShutterSpeed(1 / 250)).toBe("1/250s");
    expect(formatShutterSpeed(1 / 8000)).toBe("1/8000s");
    expect(formatShutterSpeed(0.01)).toBe("1/100s");
  });

  it("formats exposures >= 1 second as plain numbers", () => {
    expect(formatShutterSpeed(1)).toBe("1s");
    expect(formatShutterSpeed(30)).toBe("30s");
  });
});

describe("gpsToDecimal", () => {
  it("converts [deg, min, sec] to decimal degrees", () => {
    expect(gpsToDecimal([49, 1, 3.12], "N")).toBeCloseTo(49.017533, 5);
    expect(gpsToDecimal([11, 1, 4.56], "E")).toBeCloseTo(11.017933, 5);
  });

  it("negates southern and western hemispheres", () => {
    expect(gpsToDecimal([33, 52, 4], "S")).toBeCloseTo(-33.867778, 5);
    expect(gpsToDecimal([70, 40, 0], "W")).toBeCloseTo(-70.666667, 5);
  });

  it("returns null for missing or malformed coordinates", () => {
    expect(gpsToDecimal(undefined, "N")).toBeNull();
    expect(gpsToDecimal(49.5, "N")).toBeNull();
    expect(gpsToDecimal([49, 1], "N")).toBeNull();
    expect(gpsToDecimal([49, "x", 3], "N")).toBeNull();
    expect(gpsToDecimal([NaN, 1, 3], "N")).toBeNull();
  });
});

describe("image processing pipeline", () => {
  it("generates all 6 variants (3 resolutions × 2 formats)", async () => {
    const original = await createTestImage();
    const results: { width: number }[] = [];

    for (const width of VARIANT_WIDTHS) {
      const resized = sharp(original)
        .autoOrient()
        .keepIccProfile()
        .resize(width, undefined, { withoutEnlargement: true });

      for (const format of VARIANT_FORMATS) {
        const buffer =
          format === "jpg"
            ? await resized.clone().jpeg({ quality: 85 }).toBuffer()
            : await resized.clone().webp({ quality: 85 }).toBuffer();

        const meta = await sharp(buffer).metadata();
        results.push({ width: meta.width! });
      }
    }

    expect(results).toHaveLength(6);
  });

  it("resizes to exact target widths", async () => {
    const original = await createTestImage(4000, 3000);

    for (const width of VARIANT_WIDTHS) {
      const buffer = await sharp(original)
        .resize(width, undefined, { withoutEnlargement: true })
        .jpeg()
        .toBuffer();

      const meta = await sharp(buffer).metadata();
      expect(meta.width).toBe(width);
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

    for (const width of VARIANT_WIDTHS) {
      const buffer = await sharp(original)
        .resize(width, undefined, { withoutEnlargement: true })
        .jpeg()
        .toBuffer();

      const meta = await sharp(buffer).metadata();
      const expectedHeight = Math.round((width * 3000) / 4000);
      expect(meta.height).toBe(expectedHeight);
    }
  });

  it("bakes EXIF orientation into the output pixels", async () => {
    // 400x300 image tagged orientation 6 (rotate 90° CW) displays as 300x400
    const rotated = await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const buffer = await sharp(rotated)
      .autoOrient()
      .resize(150, undefined, { withoutEnlargement: true })
      .jpeg()
      .toBuffer();

    const meta = await sharp(buffer).metadata();
    // Width/height swapped: the orientation was applied, not stripped
    expect(meta.width).toBe(150);
    expect(meta.height).toBe(200);
    expect(meta.orientation).toBeUndefined();
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

    const generatedKeys: string[] = [];
    for (const width of VARIANT_WIDTHS) {
      for (const format of VARIANT_FORMATS) {
        generatedKeys.push(variantKey(s3Key, width, format));
      }
    }

    expect(generatedKeys).toEqual([
      "barcelona/2026-03-06-R0018076_640.jpg",
      "barcelona/2026-03-06-R0018076_640.webp",
      "barcelona/2026-03-06-R0018076_1280.jpg",
      "barcelona/2026-03-06-R0018076_1280.webp",
      "barcelona/2026-03-06-R0018076_2880.jpg",
      "barcelona/2026-03-06-R0018076_2880.webp",
    ]);
  });

  it("keeps legacy 128px variants in the cleanup suffix list", () => {
    expect(VARIANT_SUFFIXES).toContain("_128.jpg");
    expect(VARIANT_SUFFIXES).toContain("_128.webp");
    expect(VARIANT_SUFFIXES).toHaveLength(8);
  });
});
