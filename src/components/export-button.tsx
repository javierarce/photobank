import { useEffect, useRef, useState } from "react";
import type { ExportResolution } from "@/lib/api";

/** The default version a plain click exports. */
export const DEFAULT_EXPORT_RESOLUTION: ExportResolution = "2880";

// Ordered biggest-first so "Original" reads as the primary choice and the
// numbered variants descend. Kept in sync with the stored variants (see
// VARIANT_WIDTHS in lib/keys) plus the untouched original.
const OPTIONS: { value: ExportResolution; label: string; hint: string }[] = [
  { value: "original", label: "Original", hint: "" },
  { value: "2880", label: "Large", hint: "2880px" },
  { value: "1280", label: "Medium", hint: "1280px" },
  { value: "640", label: "Small", hint: "640px" },
];

type Props = {
  /** Called with the chosen version. The caller owns the actual export + errors. */
  onExport: (resolution: ExportResolution) => void;
  disabled?: boolean;
  label?: string;
  /** Stretch to fill the container (lightbox) vs. stay compact (toolbar). */
  fullWidth?: boolean;
  /** Where the version menu opens. Use "top" when the button sits at the
   *  bottom of a panel so the menu doesn't overflow. */
  menuPlacement?: "top" | "bottom";
};

/**
 * Split button: the main half exports the default version; the caret opens a
 * menu to pick a specific stored version (Original / 2880 / 1280 / 640).
 */
export function ExportButton({
  onExport,
  disabled = false,
  label = "Download",
  fullWidth = false,
  menuPlacement = "bottom",
}: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);

  // Close on outside click or Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Capture phase + stopPropagation so Escape dismisses only the menu:
        // it runs before the bubble-phase document listeners that close the
        // lightbox (photo-lightbox) and clear the selection (photo-grid /
        // search-results), keeping the keypress from reaching them.
        e.stopPropagation();
        setOpen(false);
        caretRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const choose = (resolution: ExportResolution) => {
    setOpen(false);
    onExport(resolution);
  };

  const base =
    "border border-border text-sm transition-colors hover:bg-foreground/5 disabled:opacity-50 disabled:pointer-events-none";

  return (
    <div
      ref={containerRef}
      className={`relative ${fullWidth ? "flex w-full" : "inline-flex"}`}
    >
      <button
        type="button"
        onClick={() => choose(DEFAULT_EXPORT_RESOLUTION)}
        disabled={disabled}
        className={`${base} rounded-l-md border-r-0 px-3 py-1.5 ${fullWidth ? "flex-1 text-center" : ""}`}
      >
        {label}
      </button>
      <button
        ref={caretRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choose version to export"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={`${base} rounded-r-md px-2`}
      >
        <svg
          className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute right-0 z-10 min-w-44 overflow-hidden rounded-md border border-border bg-background shadow-lg ${
            menuPlacement === "top" ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          {OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="menuitem"
              onClick={() => choose(opt.value)}
              className="flex w-full items-baseline justify-between gap-4 px-3 py-1.5 text-left text-sm transition-colors hover:bg-foreground/5"
            >
              <span>{opt.label}</span>
              {opt.hint && (
                <span className="text-xs text-foreground/50">{opt.hint}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
