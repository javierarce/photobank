import { useUpdate } from "@/lib/update-context";

/**
 * A small pill in the header that appears only when an update is waiting;
 * tapping it opens the install dialog. Signals the update quietly instead of
 * interrupting with a modal on launch.
 */
export function UpdateBadge() {
  const { update, openDialog } = useUpdate();
  if (!update) return null;

  const label = `New version available: Photobank ${update.version}`;

  return (
    <button
      type="button"
      onClick={openDialog}
      title={label}
      aria-label={label}
      className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1 text-sm font-medium text-accent transition-colors hover:bg-accent/20 active:scale-[0.97]"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-3.5"
        aria-hidden
      >
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 11V5M5.5 7.5 8 5l2.5 2.5" />
      </svg>
      New version
    </button>
  );
}
