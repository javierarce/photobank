/**
 * Ankitron-style typed search: the query string is a space-separated list of
 * terms, each either free text or a `field:value` qualifier. The authoritative
 * parser + matcher lives in Rust (`src-tauri/src/commands.rs`); this module
 * mirrors just enough of it to power the syntax help sheet, highlighting, and
 * the "metadata not loaded" caveat — it never filters photos itself.
 */

export type Prefix = {
  /** Canonical qualifier keyword, e.g. "tag". */
  keyword: string;
  /** Alternate spellings that resolve to the same filter. */
  aliases?: string[];
  /** One-line description for the help sheet. */
  hint: string;
  /** A copy-pasteable example. */
  example: string;
  /**
   * True when the filter reads EXIF that is only present after a photo's info
   * has been loaded — so results can miss un-loaded photos.
   */
  metadata: boolean;
};

/** The qualifiers the backend understands, in help-sheet order. */
export const PREFIXES: Prefix[] = [
  { keyword: "tag", hint: "Has a tag (tag:none = untagged)", example: "tag:sunset", metadata: false },
  { keyword: "folder", hint: "In a folder", example: "folder:trips", metadata: false },
  { keyword: "filename", aliases: ["name"], hint: "Filename contains", example: "filename:beach", metadata: false },
  { keyword: "camera", hint: "Camera make or model", example: "camera:fuji", metadata: true },
  { keyword: "make", hint: "Camera manufacturer", example: "make:canon", metadata: true },
  { keyword: "model", hint: "Camera model", example: "model:x100v", metadata: true },
  { keyword: "lens", hint: "Lens", example: "lens:35mm", metadata: true },
  { keyword: "iso", hint: "ISO — exact, range or >=/<=", example: "iso:>=800", metadata: true },
  { keyword: "f", aliases: ["aperture"], hint: "Aperture", example: "f:1.8", metadata: true },
  { keyword: "shutter", aliases: ["speed"], hint: "Shutter speed", example: "shutter:1/250", metadata: true },
  { keyword: "focal", hint: "Focal length", example: "focal:50", metadata: true },
  { keyword: "date", aliases: ["year"], hint: "Date taken — year/month/day or A..B", example: "date:2024", metadata: true },
];

const BY_KEYWORD = new Map<string, Prefix>();
for (const prefix of PREFIXES) {
  BY_KEYWORD.set(prefix.keyword, prefix);
  for (const alias of prefix.aliases ?? []) BY_KEYWORD.set(alias, prefix);
}

/** A single term of a query, once negation and any qualifier are peeled off. */
export type ParsedTerm = {
  /** The term exactly as written. */
  raw: string;
  /** A leading `-` negates the term. */
  negated: boolean;
  /** The matched qualifier, or null for free text / an unknown prefix. */
  prefix: Prefix | null;
  /** The typed field keyword (lowercased) when `prefix` is set. */
  field: string | null;
  /** The value after the colon when `prefix` is set. */
  value: string | null;
};

/**
 * Split a query into terms, honoring double quotes so a quoted phrase — or a
 * quoted value like `tag:"my tag"` — stays one term. Mirrors the Rust
 * `split_terms`: quotes are stripped, the whitespace they protect is kept.
 */
export function splitTerms(query: string): string[] {
  const terms: string[] = [];
  let cur = "";
  let inQuote = false;
  let started = false;
  for (const c of query) {
    if (c === '"') {
      inQuote = !inQuote;
      started = true;
    } else if (/\s/.test(c) && !inQuote) {
      if (started) {
        terms.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) terms.push(cur);
  return terms;
}

/** Parse one raw term into its negation / qualifier / free-text parts. */
export function parseTerm(raw: string): ParsedTerm {
  let negated = false;
  let body = raw;
  if (body.startsWith("-") && body.length > 1) {
    negated = true;
    body = body.slice(1);
  }
  const colon = body.indexOf(":");
  if (colon > 0) {
    const field = body.slice(0, colon).toLowerCase();
    const prefix = BY_KEYWORD.get(field);
    if (prefix) {
      return { raw, negated, prefix, field, value: body.slice(colon + 1) };
    }
  }
  return { raw, negated, prefix: null, field: null, value: null };
}

/** Parse a whole query into its non-empty terms. */
export function parseQuery(query: string): ParsedTerm[] {
  return splitTerms(query)
    .filter((term) => term.length > 0)
    .map(parseTerm);
}

/**
 * True when the query has a *positive* qualifier that reads lazily-loaded EXIF.
 * EXIF is populated on demand, so such a filter silently skips photos whose info
 * hasn't been loaded — worth surfacing. A negated metadata filter (e.g.
 * `-camera:fuji`) instead keeps un-loaded photos (NULL metadata satisfies the
 * negation), so it has no such pitfall and doesn't count.
 */
export function usesMetadataFilter(query: string): boolean {
  return parseQuery(query).some(
    (term) => term.prefix?.metadata === true && !term.negated
  );
}

// --- Highlighting & autocomplete (Phase 2) --------------------------------
//
// These keep the original characters (quotes included) so the search bar can
// paint a styled overlay and complete tokens in place, unlike splitTerms/
// parseTerm which normalize for matching.

/** Character span of one term, quote-aware, keeping quotes in the range. */
export type Span = { start: number; end: number };

/** Locate every term's span, honoring quotes so a quoted value stays one span. */
export function tokenizeSpans(query: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < query.length) {
    while (i < query.length && /\s/.test(query[i])) i++;
    if (i >= query.length) break;
    const start = i;
    let inQuote = false;
    while (i < query.length) {
      const c = query[i];
      if (c === '"') inQuote = !inQuote;
      else if (/\s/.test(c) && !inQuote) break;
      i++;
    }
    spans.push({ start, end: i });
  }
  return spans;
}

/** Split a recognized qualifier token into its `field:` and value halves. */
function splitQualifier(
  token: string
): { fieldText: string; valueText: string } | null {
  let body = token;
  let dash = 0;
  if (body.startsWith("-") && body.length > 1) {
    dash = 1;
    body = body.slice(1);
  }
  const colon = body.indexOf(":");
  if (colon > 0 && BY_KEYWORD.has(body.slice(0, colon).toLowerCase())) {
    const cut = dash + colon + 1; // through the `-`, field, and `:`
    return { fieldText: token.slice(0, cut), valueText: token.slice(cut) };
  }
  return null;
}

export type HighlightKind = "plain" | "field" | "value";
export type HighlightSegment = { text: string; kind: HighlightKind };

/**
 * Break a query into contiguous styled runs covering every character (spaces
 * included), so an overlay rendered from these segments lines up exactly with
 * the input text beneath it.
 */
export function highlightQuery(query: string): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  const push = (text: string, kind: HighlightKind) => {
    if (text) segments.push({ text, kind });
  };
  for (const { start, end } of tokenizeSpans(query)) {
    push(query.slice(cursor, start), "plain"); // leading whitespace
    const token = query.slice(start, end);
    const qualifier = splitQualifier(token);
    if (qualifier) {
      push(qualifier.fieldText, "field");
      push(qualifier.valueText, "value");
    } else {
      push(token, "plain");
    }
    cursor = end;
  }
  push(query.slice(cursor), "plain"); // trailing whitespace
  return segments;
}

/** Value pools the autocomplete draws on, sourced from the catalog. */
export type SearchValues = {
  tags: string[];
  folders: string[];
  makes: string[];
  models: string[];
  lenses: string[];
};

export const EMPTY_SEARCH_VALUES: SearchValues = {
  tags: [],
  folders: [],
  makes: [],
  models: [],
  lenses: [],
};

/** Which value pool (if any) a qualifier completes from. */
const VALUE_POOL: Record<string, (v: SearchValues) => string[]> = {
  tag: (v) => v.tags,
  folder: (v) => v.folders,
  make: (v) => v.makes,
  model: (v) => v.models,
  camera: (v) => dedupe([...v.makes, ...v.models]),
  lens: (v) => v.lenses,
};

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

export type Suggestion = {
  /** What replaces the active span when chosen. */
  insert: string;
  /** Primary text shown in the dropdown. */
  label: string;
  /** Secondary text (the qualifier's hint, or its keyword). */
  detail: string;
  kind: "qualifier" | "value";
};

export type SuggestResult = { range: Span; items: Suggestion[] };

/** The whitespace-delimited token surrounding the caret. */
function activeSpan(query: string, caret: number): Span {
  let start = caret;
  while (start > 0 && !/\s/.test(query[start - 1])) start--;
  let end = caret;
  while (end < query.length && !/\s/.test(query[end])) end++;
  return { start, end };
}

/** Values already used for `keyword` elsewhere in the query, lowercased. */
function appliedValues(query: string, active: Span, keyword: string): Set<string> {
  const used = new Set<string>();
  for (const span of tokenizeSpans(query)) {
    if (span.start === active.start && span.end === active.end) continue;
    const term = parseTerm(query.slice(span.start, span.end));
    if (term.prefix?.keyword === keyword && term.value) {
      used.add(term.value.replace(/"/g, "").toLowerCase());
    }
  }
  return used;
}

export type SuggestOptions = {
  /**
   * List every qualifier when the token is empty (nothing typed). Off by
   * default so the dropdown stays quiet until there's something to complete;
   * the search bar turns it on when the user presses ArrowDown.
   */
  showAll?: boolean;
  /** Cap on value suggestions (qualifier lists are short and never capped). */
  limit?: number;
};

/**
 * Suggestions for the token at `caret`: qualifier keywords when typing a bare
 * word (or all of them with `showAll` on an empty token), or values once a
 * recognized `field:` is present. `range` is the span a chosen suggestion's
 * `insert` replaces.
 */
export function getSuggestions(
  query: string,
  caret: number,
  values: SearchValues,
  { showAll = false, limit = 8 }: SuggestOptions = {}
): SuggestResult {
  const range = activeSpan(query, caret);
  const token = query.slice(range.start, range.end);
  const dash = token.startsWith("-") ? "-" : "";
  const body = dash ? token.slice(1) : token;
  const colon = body.indexOf(":");

  if (colon > 0) {
    const field = body.slice(0, colon).toLowerCase();
    const prefix = BY_KEYWORD.get(field);
    const pool = prefix ? VALUE_POOL[prefix.keyword] : undefined;
    if (!prefix || !pool) return { range, items: [] };

    const partial = body.slice(colon + 1).replace(/"/g, "").toLowerCase();
    const used = appliedValues(query, range, prefix.keyword);
    const items: Suggestion[] = [];
    // `tag:none` is a real filter, not a tag name — offer it first.
    if (prefix.keyword === "tag" && "none".startsWith(partial)) {
      items.push({
        insert: `${dash}tag:none `,
        label: "none",
        detail: "untagged",
        kind: "value",
      });
    }
    for (const value of pool(values)) {
      if (items.length >= limit) break;
      if (used.has(value.toLowerCase())) continue;
      if (!value.toLowerCase().includes(partial)) continue;
      items.push({
        insert: `${dash}${field}:${quoteIfNeeded(value)} `,
        label: value,
        detail: prefix.keyword,
        kind: "value",
      });
    }
    return { range, items };
  }

  // No colon yet: complete qualifier keywords. An empty token lists them all
  // (only when `showAll` is set); a partial word lists prefixes/aliases that
  // start with it.
  const typed = body.toLowerCase();
  if (typed.length === 0 && !showAll) return { range, items: [] };
  const items: Suggestion[] = [];
  for (const prefix of PREFIXES) {
    const keyword =
      typed.length === 0
        ? prefix.keyword
        : [prefix.keyword, ...(prefix.aliases ?? [])].find((k) =>
            k.startsWith(typed)
          );
    if (keyword) {
      items.push({
        insert: `${dash}${keyword}:`,
        label: `${keyword}:`,
        detail: prefix.hint,
        kind: "qualifier",
      });
    }
  }
  return { range, items };
}

/** Splice a suggestion into the query, returning the new text and caret. */
export function applySuggestion(
  query: string,
  range: Span,
  insert: string
): { query: string; caret: number } {
  return {
    query: query.slice(0, range.start) + insert + query.slice(range.end),
    caret: range.start + insert.length,
  };
}
