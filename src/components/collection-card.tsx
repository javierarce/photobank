import { Thumbnail } from "@/components/thumbnail";
import { ThumbnailFallback } from "@/components/thumbnail-fallback";
import type { Collection, Photo } from "@/lib/types";

/**
 * A collection as a square card, sitting among the folder's photo tiles the
 * way folders sit above files in a file manager: its newest displayable photo
 * on top, its title and count on a strip underneath — enough to read as a
 * container rather than one more picture. Opening it shows what's inside.
 *
 * It's also a drop target: photos dragged onto it are filed here. The drop is
 * driven by native cursor positions hit-testing `data-drop-collection` (see
 * the DragTracker note in use-upload), not by DOM drop events, which never
 * fire for drags over the webview.
 */
export function CollectionCard({
  collection,
  cover,
  isDragging,
  isDropTarget,
  onOpen,
}: {
  collection: Collection;
  /** The photo to show, or null when nothing in it can be displayed yet. */
  cover: Photo | null;
  /** True while photos are being dragged, so every card shows it can take them. */
  isDragging: boolean;
  /** True while the drag is over this card. */
  isDropTarget: boolean;
  onOpen: (collection: Collection) => void;
}) {
  const count = collection.photoIds.length;
  const border = isDropTarget
    ? "border-accent bg-accent/5"
    : isDragging
      ? "border-dashed border-foreground/30"
      : "border-border hover:border-foreground/35";

  return (
    <button
      type="button"
      onClick={() => onOpen(collection)}
      data-drop-collection={collection.id}
      data-testid="collection-card"
      title={collection.title}
      className={`fade-in relative flex aspect-square flex-col overflow-hidden rounded-md border bg-foreground/[0.04] text-left transition-colors dark:bg-foreground/5 ${border}`}
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {cover ? <Thumbnail photo={cover} /> : <ThumbnailFallback />}
      </div>
      <div className="flex shrink-0 flex-col gap-0.5 px-2.5 py-2">
        <span className="truncate text-sm font-medium text-foreground">
          {collection.title}
        </span>
        <span className="text-xs tabular-nums text-foreground/50">
          {count} {count === 1 ? "photo" : "photos"}
        </span>
      </div>
    </button>
  );
}
