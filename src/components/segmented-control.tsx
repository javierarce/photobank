import { useRef } from "react";

type Props<T extends string> = {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  /** Names the whole group for screen readers, e.g. "Filter by orientation". */
  label: string;
};

/**
 * A row of mutually exclusive choices, all of them visible — the counterpart to
 * SortDropdown for a setting with few enough options that hiding them behind a
 * popover costs more than it saves. Built as a radio group with roving
 * tabindex: one Tab stop for the whole control, arrows move between segments,
 * which is what a segmented control is expected to do.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: Props<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  // Arrows move the choice AND the focus, wrapping around, so the control can
  // be driven entirely from the keyboard once tabbed into.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!delta) return;
    e.preventDefault();
    const index = options.findIndex((o) => o.value === value);
    const next = (index + delta + options.length) % options.length;
    onChange(options[next].value);
    const buttons =
      groupRef.current?.querySelectorAll<HTMLButtonElement>("button");
    buttons?.[next]?.focus();
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border p-0.5"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(opt.value)}
            className={`rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
              active
                ? "bg-foreground/10 text-foreground"
                : "text-foreground/55 hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
