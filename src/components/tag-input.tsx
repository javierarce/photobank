import { useState } from "react";

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  /** Existing tags to offer as autocomplete suggestions while typing. */
  suggestions?: string[];
  autoFocus?: boolean;
  disabled?: boolean;
  /** Placeholder shown while the field is empty. */
  placeholder?: string;
  /**
   * Called when Enter is pressed with the field empty — i.e. a second Enter
   * after committing a tag — so the surrounding form can submit.
   */
  onSubmit?: () => void;
  /**
   * Reports the current uncommitted input text. Lets a parent that applies on a
   * button click include text the user typed but never turned into a chip
   * (pressing a button doesn't reliably blur the input on WebKit-based
   * webviews, so onBlur can't be relied on to commit it first).
   */
  onInputChange?: (value: string) => void;
}

const MAX_SUGGESTIONS = 8;

/**
 * A chip-style tag entry field with autocomplete: type to filter existing
 * tags, Enter/comma commits, Backspace on an empty field removes the last chip.
 * Shared by the single-photo tag list and the bulk tag editor.
 */
export function TagInput({
  tags,
  onChange,
  suggestions = [],
  autoFocus,
  disabled = false,
  placeholder = "Add tags...",
  onSubmit,
  onInputChange,
}: TagInputProps) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  // Keep state and the parent's view of the pending text in sync from one place.
  function changeInput(value: string) {
    setInput(value);
    onInputChange?.(value);
  }

  const query = input.trim().toLowerCase();
  const matches = query
    ? suggestions
        .filter((s) => !tags.includes(s) && s.toLowerCase().includes(query))
        .slice(0, MAX_SUGGESTIONS)
    : [];
  const showMenu = open && matches.length > 0;

  function addTag(tag: string) {
    const t = tag.trim();
    if (t && !tags.includes(t)) {
      onChange([...tags, t]);
    }
    changeInput("");
    setHighlight(0);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (showMenu && e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % matches.length);
      return;
    }
    if (showMenu && e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + matches.length) % matches.length);
      return;
    }
    if (e.key === "Enter" && !input.trim() && onSubmit) {
      // Empty field: the tag (if any) is already committed, so a second Enter
      // submits the surrounding form.
      e.preventDefault();
      onSubmit();
      return;
    }
    if ((e.key === "Enter" || e.key === ",") && input.trim()) {
      e.preventDefault();
      // Enter accepts the highlighted suggestion; comma always takes the typed
      // text verbatim so you can still coin a brand-new tag.
      if (showMenu && e.key === "Enter") addTag(matches[highlight]);
      else addTag(input);
      return;
    }
    if (e.key === "Escape" && showMenu) {
      // Scope Escape to the menu so it doesn't also bubble to a dialog's
      // window-level Escape handler and close the whole dialog.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === "Backspace" && !input && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  function commitInput() {
    if (input.trim()) addTag(input);
    setOpen(false);
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border px-3 py-2">
        {tags.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 rounded-md bg-foreground/10 px-2 py-0.5 text-xs"
          >
            {tag}
            {!disabled && (
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="ml-0.5 text-foreground/40 hover:text-foreground"
              >
                &times;
              </button>
            )}
          </span>
        ))}
        <input
          type="text"
          value={input}
          disabled={disabled}
          onChange={(e) => {
            changeInput(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onKeyDown={handleKeyDown}
          onBlur={commitInput}
          autoFocus={autoFocus}
          spellCheck={false}
          placeholder={tags.length === 0 ? placeholder : ""}
          className="min-w-[80px] flex-1 bg-transparent text-sm placeholder:text-foreground/40 focus:outline-none disabled:cursor-not-allowed"
        />
      </div>
      {showMenu && (
        <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-border bg-background py-1 shadow-lg">
          {matches.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                // mousedown (not click) so it fires before the input's blur, and
                // preventDefault keeps focus from leaving and committing the
                // typed text first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  addTag(s);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`block w-full px-3 py-1.5 text-left text-sm ${
                  i === highlight ? "bg-foreground/10" : "hover:bg-foreground/5"
                }`}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
