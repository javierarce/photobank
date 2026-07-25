import { ModalDialog } from "@/components/modal-dialog";
import { displayName } from "@/lib/keys";

/** What to do with the dropped files whose names are already taken. */
export type CollisionChoice = "replace" | "keep-both" | "skip";

type Props = {
  folder: string;
  /** Filenames already in the folder, in drop order. */
  collisions: string[];
  /** How many importable files the drop had in total. */
  total: number;
  /** null when the drop is abandoned (Escape, backdrop, or Cancel). */
  onChoose: (choice: CollisionChoice | null) => void;
};

/** At most this many names are listed before the rest are summarised. */
const PREVIEW = 5;

/**
 * Asked before a drop whose filenames already exist in the target folder.
 * Without it the importer silently suffixes ("photo (1).jpg"), which is right
 * for two genuinely different pictures but not for re-uploading an edit of one
 * — so the choice is surfaced instead of guessed.
 *
 * Replace is deliberately not the default: it overwrites the bucket objects in
 * place and can't be undone, whereas Keep both is always recoverable.
 */
export function ImportCollisionDialog({
  folder,
  collisions,
  total,
  onChoose,
}: Props) {
  const count = collisions.length;
  const others = total - count;
  const shown = collisions.slice(0, PREVIEW);
  const hidden = count - shown.length;

  return (
    <ModalDialog
      title={
        count === 1
          ? "A photo with that name already exists"
          : `${count} photos with those names already exist`
      }
      onClose={() => onChoose(null)}
    >
      <p className="text-sm text-foreground/60">
        {count === 1 ? "This file is" : "These files are"} already in{" "}
        <span className="font-mono text-foreground/80">{folder}</span>:
      </p>
      <ul
        className="mt-2 max-h-40 overflow-y-auto rounded-md border border-border p-2"
        data-testid="collision-list"
      >
        {shown.map((filename) => (
          <li
            key={filename}
            className="truncate font-mono text-xs text-foreground/70"
          >
            {displayName(filename)}
          </li>
        ))}
        {hidden > 0 && (
          <li className="mt-1 text-xs text-foreground/40">
            and {hidden} more
          </li>
        )}
      </ul>
      {others > 0 && (
        <p className="mt-2 text-xs text-foreground/40">
          The other {others === 1 ? "file" : `${others} files`} in this drop
          {others === 1 ? " doesn't" : " don't"} clash and will be uploaded
          either way.
        </p>
      )}

      <div className="mt-5 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => onChoose("keep-both")}
          data-testid="collision-keep-both"
          className="w-full rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-foreground/5 active:scale-[0.97]"
        >
          Keep both
          <span className="ml-1.5 text-foreground/40">
            — upload as &ldquo;name (1)&rdquo;
          </span>
        </button>
        <button
          type="button"
          onClick={() => onChoose("skip")}
          data-testid="collision-skip"
          className="w-full rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-foreground/5 active:scale-[0.97]"
        >
          {others > 0 ? "Skip these" : "Skip"}
          <span className="ml-1.5 text-foreground/40">
            — keep what&rsquo;s already there
          </span>
        </button>
        <button
          type="button"
          onClick={() => onChoose("replace")}
          data-testid="collision-replace"
          className="w-full rounded-md border border-red-500/30 px-3 py-1.5 text-sm text-red-600 transition hover:bg-red-500/10 active:scale-[0.97] dark:text-red-400"
        >
          Replace
          <span className="ml-1.5 opacity-60">
            — overwrite, keeping {count === 1 ? "its link" : "their links"}
          </span>
        </button>
      </div>
    </ModalDialog>
  );
}
