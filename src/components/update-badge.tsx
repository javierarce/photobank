import { useUpdate } from "@/lib/update-context";
import { UpdateIcon } from "@/components/update-icon";

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
      <UpdateIcon className="size-3.5" />
      New version
    </button>
  );
}
