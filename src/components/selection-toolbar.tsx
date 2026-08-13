import { exportPhotos, type ExportResolution } from "@/lib/api";
import { ExportButton } from "@/components/export-button";
import { useSelection } from "@/hooks/use-selection";

const subtle =
  "rounded-md px-1.5 py-0.5 text-sm text-foreground/50 transition-colors hover:text-foreground";
const action =
  "rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-foreground/5 active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none";
const danger =
  "rounded-md border border-red-500/30 px-3 py-1.5 text-sm text-red-600 transition hover:bg-red-500/10 active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none dark:text-red-400";

/**
 * The bulk-action bar shown in place of the folder/results title row while
 * SEVERAL photos are selected (Ankitron-style): a count with Select all /
 * Clear on the left, the contextual actions on the right. With a single photo
 * selected the pages keep their own title on the left and render just
 * <SelectionActionBar /> on the right — one photo needs no count, and swapping
 * the title out for "1 selected" made every click of a thumbnail feel like it
 * changed modes.
 */
export function SelectionToolbar() {
  const { selected, clear, isSelected, pool, selectAll } = useSelection();
  const count = selected.length;
  const allSelected = pool.length > 0 && pool.every((p) => isSelected(p.id));

  return (
    <div
      data-selection-toolbar
      className="flex w-full items-center justify-between gap-3"
    >
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium text-foreground">{count} selected</p>
        {!allSelected && pool.length > 0 && (
          <button type="button" onClick={() => selectAll(pool)} className={subtle}>
            Select all
          </button>
        )}
        <button type="button" onClick={clear} className={subtle}>
          Clear
        </button>
      </div>
      <SelectionActionBar />
    </div>
  );
}

/** The right-hand half of the toolbar: what can be done to the selection.
 * Download is self-contained; Tag/Move/Delete defer to the visible grid's
 * registered handlers. */
export function SelectionActionBar() {
  const { selected, actions } = useSelection();

  const handleDownload = async (resolution: ExportResolution) => {
    try {
      await exportPhotos(selected.map((p) => p.id), resolution);
    } catch {
      alert("Failed to export photos");
    }
  };

  return (
    <div
      data-selection-toolbar
      className="flex shrink-0 items-center gap-2"
    >
      <ExportButton onExport={handleDownload} />
      <button
        type="button"
        onClick={() => actions?.onTag(selected)}
        disabled={!actions}
        className={action}
      >
        Tag
      </button>
      <button
        type="button"
        onClick={() => actions?.onMove(selected)}
        disabled={!actions}
        className={action}
      >
        Move
      </button>
      <button
        type="button"
        onClick={() => actions?.onDelete(selected)}
        disabled={!actions}
        className={danger}
      >
        Delete
      </button>
    </div>
  );
}
