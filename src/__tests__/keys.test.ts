import { describe, it, expect } from "vitest";
import { displayName } from "@/lib/keys";

describe("displayName", () => {
  it("strips the legacy _original marker but keeps the extension", () => {
    expect(displayName("2025-07-01-Berlin-R0012750_original.jpg")).toBe(
      "2025-07-01-Berlin-R0012750.jpg"
    );
    expect(displayName("R0007098_original.png")).toBe("R0007098.png");
  });

  it("leaves current-scheme filenames untouched", () => {
    expect(displayName("photo.jpg")).toBe("photo.jpg");
    expect(displayName("R0012750.jpg")).toBe("R0012750.jpg");
  });

  it("only strips _original as a stem suffix, not anywhere in the name", () => {
    // Mirrors variantBase / keys.rs variant_base: the marker must sit
    // immediately before the extension.
    expect(displayName("original_takes.jpg")).toBe("original_takes.jpg");
    expect(displayName("my_original_shot.jpg")).toBe("my_original_shot.jpg");
  });

  it("handles a name with no extension", () => {
    expect(displayName("R0012750_original")).toBe("R0012750");
  });

  it("strips the width marker of stand-in originals", () => {
    // Photos whose original was lost are cataloged under their largest
    // variant; the width suffix is scheme plumbing, not part of the name.
    expect(displayName("2019_10_15_copenhaguen_P1160508_2880.jpg")).toBe(
      "2019_10_15_copenhaguen_P1160508.jpg"
    );
    expect(displayName("P1160509_1280.jpg")).toBe("P1160509.jpg");
  });

  it("only strips exact width markers, not camera counters with other digits", () => {
    expect(displayName("IMG_0640.jpg")).toBe("IMG_0640.jpg");
    expect(displayName("IMG_64.jpg")).toBe("IMG_64.jpg");
    expect(displayName("photo_6400.jpg")).toBe("photo_6400.jpg");
  });
});
