/**
 * Up-arrow-in-a-circle glyph, shared by the header <UpdateBadge /> and the
 * command palette's "Check for updates" action so the two stay in sync.
 */
export function UpdateIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 11V5M5.5 7.5 8 5l2.5 2.5" />
    </svg>
  );
}
