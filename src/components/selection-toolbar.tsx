import { exportPhotos, type ExportResolution } from "@/lib/api";
import { ExportButton } from "@/components/export-button";
import { useSelection } from "@/hooks/use-selection";

/**
 * The bulk-action bar shown in place of the folder/results title row while
 * photos are selected (Ankitron-style): a count with Select all / Clear on
 * the left, contextual actions on the right. Download is self-contained;
 * Move/Delete defer to the visible grid's registered handlers.
 */
export function SelectionToolbar() {
  const { selected, clear, actions, isSelected, pool, selectAll } =
    useSelection();
  const count = selected.length;
  const allSelected = pool.length > 0 && pool.every((p) => isSelected(p.id));

  const handleDownload = async (resolution: ExportResolution) => {
    try {
      await exportPhotos(selected.map((p) => p.id), resolution);
    } catch {
      alert("Failed to export photos");
    }
  };

  const subtle =
    "rounded-md px-1.5 py-0.5 text-sm text-foreground/50 transition-colors hover:text-foreground";
  const action =
    "rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-foreground/5 disabled:opacity-40 disabled:pointer-events-none";
  const danger =
    "rounded-md border border-red-500/30 px-3 py-1.5 text-sm text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-40 disabled:pointer-events-none dark:text-red-400";

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
      <div className="flex items-center gap-2">
        <ExportButton onExport={handleDownload} />
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
    </div>
  );
}
