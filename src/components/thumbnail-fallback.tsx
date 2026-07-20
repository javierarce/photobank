/** A quiet, on-brand stand-in for a thumbnail that can't be shown yet — the
 * variant/original is missing, still downloading, or failed to decode. Reads as
 * part of the app (a muted image glyph on the tile's own surface) rather than
 * the browser's broken-image icon. Fills its tile; the caller owns the border,
 * rounding, and background. */
export function ThumbnailFallback() {
  return (
    <div
      data-testid="thumbnail-fallback"
      className="flex h-full w-full items-center justify-center text-foreground/25"
    >
      <svg
        className="h-7 w-7"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9" r="1.5" />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 17l4.5-4.5a1.5 1.5 0 012 0L15 17m-2-3l1.75-1.75a1.5 1.5 0 012 0L20 15"
        />
      </svg>
    </div>
  );
}
