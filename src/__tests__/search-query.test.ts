import { describe, it, expect } from "vitest";
import {
  splitTerms,
  parseTerm,
  parseQuery,
  usesMetadataFilter,
  highlightQuery,
  getSuggestions,
  applySuggestion,
  type SearchValues,
} from "@/lib/search-query";

const VALUES: SearchValues = {
  tags: ["sunset", "night"],
  folders: ["trips", "inbox"],
  makes: ["FUJIFILM", "Canon"],
  models: ["X100V", "EOS R5"],
  lenses: ["23mm f/2"],
};

describe("splitTerms", () => {
  it("splits on whitespace", () => {
    expect(splitTerms("beach sunset")).toEqual(["beach", "sunset"]);
  });

  it("keeps quoted phrases and qualifier values intact", () => {
    expect(splitTerms('tag:"my tag" -foo')).toEqual(["tag:my tag", "-foo"]);
    expect(splitTerms('"el perro"')).toEqual(["el perro"]);
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(splitTerms("   a   b  ")).toEqual(["a", "b"]);
    expect(splitTerms("   ")).toEqual([]);
  });
});

describe("parseTerm", () => {
  it("recognizes a known qualifier and its value", () => {
    const term = parseTerm("camera:fuji");
    expect(term.prefix?.keyword).toBe("camera");
    expect(term.field).toBe("camera");
    expect(term.value).toBe("fuji");
    expect(term.negated).toBe(false);
  });

  it("resolves aliases to their canonical prefix", () => {
    expect(parseTerm("aperture:1.8").prefix?.keyword).toBe("f");
    expect(parseTerm("year:2024").prefix?.keyword).toBe("date");
    expect(parseTerm("name:beach").prefix?.keyword).toBe("filename");
  });

  it("peels a leading dash as negation", () => {
    const term = parseTerm("-tag:draft");
    expect(term.negated).toBe(true);
    expect(term.prefix?.keyword).toBe("tag");
    expect(term.value).toBe("draft");
  });

  it("treats an unknown prefix as free text", () => {
    const term = parseTerm("bogus:xyz");
    expect(term.prefix).toBeNull();
    expect(term.field).toBeNull();
    expect(term.value).toBeNull();
  });

  it("treats a bare word as free text", () => {
    expect(parseTerm("barcelona").prefix).toBeNull();
  });

  it("is case-insensitive on the field name", () => {
    expect(parseTerm("Camera:fuji").prefix?.keyword).toBe("camera");
  });
});

describe("parseQuery", () => {
  it("drops empty terms", () => {
    expect(parseQuery("  a   b ").map((t) => t.raw)).toEqual(["a", "b"]);
  });
});

describe("usesMetadataFilter", () => {
  it("is true when an EXIF-backed qualifier is used", () => {
    expect(usesMetadataFilter("iso:>=800")).toBe(true);
    expect(usesMetadataFilter("beach camera:fuji")).toBe(true);
    expect(usesMetadataFilter("date:2024")).toBe(true);
  });

  it("is false for free text and non-EXIF qualifiers", () => {
    expect(usesMetadataFilter("barcelona")).toBe(false);
    expect(usesMetadataFilter("tag:sunset")).toBe(false);
    expect(usesMetadataFilter("folder:trips")).toBe(false);
  });

  it("ignores negated metadata filters, which keep un-loaded photos", () => {
    // `-camera:fuji` includes NULL-metadata photos, so the caveat doesn't apply.
    expect(usesMetadataFilter("-camera:fuji")).toBe(false);
    expect(usesMetadataFilter("tag:x -iso:400")).toBe(false);
    // A positive metadata term still triggers it, even beside a negated one.
    expect(usesMetadataFilter("camera:fuji -iso:400")).toBe(true);
  });
});

describe("highlightQuery", () => {
  it("classifies qualifier field and value runs, preserving text exactly", () => {
    const segs = highlightQuery("beach camera:fuji");
    expect(segs.map((s) => s.text).join("")).toBe("beach camera:fuji");
    expect(segs).toContainEqual({ text: "beach", kind: "plain" });
    expect(segs).toContainEqual({ text: "camera:", kind: "field" });
    expect(segs).toContainEqual({ text: "fuji", kind: "value" });
  });

  it("keeps a negated qualifier in the field run and preserves whitespace", () => {
    const segs = highlightQuery("  -tag:draft");
    expect(segs.map((s) => s.text).join("")).toBe("  -tag:draft");
    expect(segs).toContainEqual({ text: "-tag:", kind: "field" });
  });

  it("treats unknown qualifiers as plain text", () => {
    expect(highlightQuery("bogus:x")).toEqual([{ text: "bogus:x", kind: "plain" }]);
  });
});

describe("getSuggestions", () => {
  it("completes qualifier keywords for a bare partial word", () => {
    const { items } = getSuggestions("cam", 3, VALUES);
    expect(items.map((i) => i.label)).toContain("camera:");
    expect(items[0].kind).toBe("qualifier");
  });

  it("resolves aliases when completing keywords", () => {
    const { items } = getSuggestions("aper", 4, VALUES);
    expect(items.map((i) => i.insert)).toContain("aperture:");
  });

  it("suggests catalog values once a qualifier is present", () => {
    const { items } = getSuggestions("tag:", 4, VALUES);
    const labels = items.map((i) => i.label);
    expect(labels).toContain("none"); // tag:none offered first
    expect(labels).toContain("sunset");
    expect(labels).toContain("night");
  });

  it("filters values by the partial after the colon", () => {
    const { items } = getSuggestions("tag:sun", 7, VALUES);
    expect(items.map((i) => i.label)).toEqual(["sunset"]);
  });

  it("merges makes and models for the camera qualifier", () => {
    const { items } = getSuggestions("camera:", 7, VALUES);
    expect(items.map((i) => i.label)).toEqual(
      expect.arrayContaining(["FUJIFILM", "Canon", "X100V", "EOS R5"])
    );
  });

  it("quotes values with spaces on insertion", () => {
    const { items } = getSuggestions("lens:", 5, VALUES);
    expect(items[0].insert).toBe('lens:"23mm f/2" ');
  });

  it("preserves negation when completing", () => {
    const { items } = getSuggestions("-tag:sun", 8, VALUES);
    expect(items[0].insert).toBe("-tag:sunset ");
  });

  it("does not re-suggest a value already used for the same field", () => {
    const { items } = getSuggestions("tag:sunset tag:", 15, VALUES);
    expect(items.map((i) => i.label)).not.toContain("sunset");
    expect(items.map((i) => i.label)).toContain("night");
  });

  it("offers nothing for operator-only fields", () => {
    expect(getSuggestions("iso:", 4, VALUES).items).toEqual([]);
    expect(getSuggestions("date:", 5, VALUES).items).toEqual([]);
  });

  it("stays quiet on an empty token by default", () => {
    expect(getSuggestions("", 0, VALUES).items).toEqual([]);
  });

  it("lists every qualifier for an empty token when showAll is set", () => {
    const { items } = getSuggestions("", 0, VALUES, { showAll: true });
    const labels = items.map((i) => i.label);
    expect(labels).toContain("tag:");
    expect(labels).toContain("iso:");
    expect(labels).toContain("date:");
    // One entry per canonical qualifier, all of kind "qualifier".
    expect(items.every((i) => i.kind === "qualifier")).toBe(true);
    expect(labels).toEqual([...new Set(labels)]); // no dupes
  });

  it("still filters a partial word even with showAll", () => {
    const { items } = getSuggestions("ca", 2, VALUES, { showAll: true });
    expect(items.map((i) => i.label)).toContain("camera:");
    expect(items.map((i) => i.label)).not.toContain("tag:");
  });
});

describe("applySuggestion", () => {
  it("splices the insert over the active range and reports the caret", () => {
    const { range } = getSuggestions("beach tag:sun", 13, VALUES);
    const result = applySuggestion("beach tag:sun", range, "tag:sunset ");
    expect(result.query).toBe("beach tag:sunset ");
    expect(result.caret).toBe(result.query.length);
  });
});
