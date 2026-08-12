import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  listFolderFacets,
  listFolders,
  listSearchFacets,
  listTags,
} from "@/lib/api";
import {
  applySuggestion,
  EMPTY_SEARCH_VALUES,
  getSuggestions,
  highlightQuery,
  type SearchValues,
  type Suggestion,
} from "@/lib/search-query";

// Shared box metrics so the highlight overlay lines up exactly with the input
// text painted beneath it. The overlay's border is transparent — it exists
// only to match the input's 1px border offset.
const FIELD_BOX =
  "w-full rounded-lg px-3 py-2 text-sm leading-normal whitespace-pre";

type Props = {
  /** The current query text (controlled). */
  value: string;
  onChange: (value: string) => void;
  /** Fired on Enter / the submit button when the suggestion list is closed. */
  onSubmit?: (value: string) => void;
  placeholder?: string;
  /** When set, renders a submit button with this label to the right. */
  submitLabel?: string;
  ariaLabel?: string;
  /** Scope the autocomplete pools to one folder — only the tags/cameras/lenses
   * that actually occur there are suggested, and the `folder:` qualifier is
   * hidden (the search is already confined to this folder). Omit for the
   * whole-library bar. */
  folder?: string;
};

/**
 * The Ankitron-style typed-query input shared by the global search bar and the
 * in-folder search field: a highlight overlay for recognized `field:value`
 * qualifiers plus a value-completing suggestion dropdown. Purely presentational
 * over its `value`/`onChange`; navigation and filtering live in the consumer.
 */
export function SearchField({
  value,
  onChange,
  onSubmit,
  placeholder,
  submitLabel,
  ariaLabel,
  folder,
}: Props) {
  const [caret, setCaret] = useState(0);
  const [values, setValues] = useState<SearchValues>(EMPTY_SEARCH_VALUES);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);

  // Fetch the autocomplete value pools: scoped to `folder` when set (only the
  // values present there), otherwise the whole library.
  const fetchValues = useCallback((): Promise<SearchValues> => {
    if (folder) {
      // In-folder scope: only this folder's tags/cameras/lenses. The `folder:`
      // qualifier is hidden in scoped mode (see excludeKeywords below), so no
      // folders pool is needed.
      return listFolderFacets(folder).then((f) => ({
        tags: f.tags,
        folders: [],
        makes: f.makes,
        models: f.models,
        lenses: f.lenses,
      }));
    }
    return Promise.all([listTags(), listFolders(), listSearchFacets()]).then(
      ([tags, folders, facets]) => ({
        tags: tags.map((t) => t.name),
        folders: folders.map((f) => f.folder),
        makes: facets.makes,
        models: facets.models,
        lenses: facets.lenses,
      })
    );
  }, [folder]);

  // Pools are re-read on focus so tags added since mount show up. Deliberately
  // unconditional rather than time-gated: a freshness window would re-open the
  // bug this fixes (tag a photo, immediately search for that tag, and it isn't
  // offered). Concurrent loads are collapsed, and a monotonic sequence discards
  // a slow earlier response that lands after a newer one, which would otherwise
  // resurrect a stale pool. Failure leaves the pools as they were — qualifier
  // name completion still works. If the unscoped facet scans ever get hot, the
  // next step is invalidating on tag mutations rather than polling on focus.
  const inFlight = useRef(false);
  const seq = useRef(0);
  const loadValues = useCallback(() => {
    if (inFlight.current) return;
    const mine = ++seq.current;
    inFlight.current = true;
    fetchValues()
      .then((next) => {
        if (mine !== seq.current) return; // a newer load already won
        setValues(next);
      })
      .catch(() => {})
      .finally(() => {
        if (mine === seq.current) inFlight.current = false;
      });
  }, [fetchValues]);

  // A new scope loads, and invalidates anything in flight for the old one.
  useEffect(() => {
    seq.current++;
    inFlight.current = false;
    loadValues();
  }, [loadValues]);

  // Off until the user presses ArrowDown on an empty token, then the dropdown
  // reveals the full qualifier list. Reset whenever the list is dismissed.
  const [showAll, setShowAll] = useState(false);

  // Inside a folder the search is already confined to it, so hide `folder:`.
  const excludeKeywords = useMemo(() => (folder ? ["folder"] : []), [folder]);
  const { range, items } = useMemo(
    () => getSuggestions(value, caret, values, { showAll, excludeKeywords }),
    [value, caret, values, showAll, excludeKeywords]
  );

  // A fresh suggestion list (any query/caret/showAll change) starts highlighted
  // at the top. Adjusting during render — not in an effect — avoids a cascading
  // pass, mirroring the pattern in search-results.tsx.
  const suggestKey = `${value} ${caret} ${showAll}`;
  const [selKey, setSelKey] = useState(suggestKey);
  if (selKey !== suggestKey) {
    setSelKey(suggestKey);
    setSelected(0);
  }
  // Guard against the list shrinking under a stale index.
  const activeIndex = Math.min(selected, Math.max(items.length - 1, 0));

  // Restore the DOM caret after a suggestion rewrites the query. State-only work
  // (the caret value) happens in `accept`; the effect just moves the cursor.
  useLayoutEffect(() => {
    if (pendingCaret.current == null || !inputRef.current) return;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    inputRef.current.setSelectionRange(pos, pos);
  }, [value]);

  const showDropdown = open && items.length > 0;

  const dismiss = () => {
    setOpen(false);
    setShowAll(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit?.(value);
    dismiss();
  };

  const accept = (item: Suggestion) => {
    const next = applySuggestion(value, range, item.insert);
    pendingCaret.current = next.caret; // the layout effect moves the DOM cursor
    onChange(next.query);
    setCaret(next.caret);
    setOpen(true);
    setShowAll(false); // a completed value shouldn't reopen the full list
    inputRef.current?.focus();
  };

  const syncCaret = () => {
    if (inputRef.current) setCaret(inputRef.current.selectionStart ?? 0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown) {
      // Nothing to complete yet: ArrowDown reveals the full qualifier list.
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setShowAll(true);
        setOpen(true);
      }
      return; // otherwise let Enter fall through to submit
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((activeIndex + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((activeIndex - 1 + items.length) % items.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      accept(items[activeIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <div className="relative flex-1">
        {/* Styled mirror of the input text. */}
        <div
          ref={overlayRef}
          aria-hidden
          className={`${FIELD_BOX} pointer-events-none absolute inset-0 overflow-hidden border border-transparent text-transparent`}
        >
          {highlightQuery(value).map((seg, i) => (
            <span
              key={i}
              className={seg.kind === "field" ? "text-accent" : "text-foreground"}
            >
              {seg.text}
            </span>
          ))}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label={ariaLabel}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onFocus={() => {
            setOpen(true);
            // Refresh the pools so tags/cameras added since mount show up.
            loadValues();
          }}
          onBlur={dismiss}
          onScroll={(e) => {
            if (overlayRef.current)
              overlayRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }}
          className={`${FIELD_BOX} relative border border-border bg-transparent text-transparent caret-foreground placeholder:text-foreground/40 outline-none focus:border-foreground/30`}
        />
        {showDropdown && (
          <ul
            role="listbox"
            className="fade-in absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-auto rounded-lg border border-border bg-background py-1 text-sm shadow-lg"
          >
            {items.map((item, i) => (
              <li key={`${item.insert}-${i}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  // Keep focus on the input so blur doesn't close the list
                  // before the click lands.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(item);
                  }}
                  onMouseEnter={() => setSelected(i)}
                  className={`flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left ${
                    i === activeIndex ? "bg-foreground/10" : ""
                  }`}
                >
                  <span className="truncate text-foreground">{item.label}</span>
                  <span className="shrink-0 text-xs text-foreground/40">
                    {item.detail}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {submitLabel && (
        <button
          type="submit"
          className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:bg-foreground/85 active:scale-[0.97]"
        >
          {submitLabel}
        </button>
      )}
    </form>
  );
}
