import { useEffect, useMemo, useRef, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import {
  addPhotosToCollection,
  createCollection,
  removePhotosFromCollections,
} from "@/lib/api";
import { membershipMap } from "@/lib/collections";
import type { Collection, Photo } from "@/lib/types";

type Props = {
  /** The photos to file, captured when the dialog opened. */
  photos: Photo[];
  /** The folder they're in — a collection can only group one folder's photos. */
  folder: string;
  /** The folder's collections, newest first. */
  collections: Collection[];
  onClose: () => void;
  /** Called once the change lands; the caller reloads its collections and
   * decides what happens to the selection. */
  onApplied: () => void;
};

/** Where the selected photos should end up. */
type Target = { kind: "new"; title: string } | { kind: "existing"; id: string };

/**
 * Files the selected photos into a collection — an existing one, or a new one
 * you title here. Membership is exclusive, so this always *moves*: a photo
 * already in another collection leaves it. Photos that are in one can also be
 * taken out entirely, which leaves them in the folder as ungrouped.
 */
export function CollectionDialog({
  photos,
  folder,
  collections,
  onClose,
  onApplied,
}: Props) {
  // Default to the newest collection when there is one — the one you just
  // made is nearly always the one you're still filling.
  const [target, setTarget] = useState<Target>(() =>
    collections.length
      ? { kind: "existing", id: collections[0].id }
      : { kind: "new", title: "" }
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const ids = useMemo(() => photos.map((p) => p.id), [photos]);
  const count = photos.length;
  const noun = count === 1 ? "1 photo" : `${count} photos`;

  // How many of the selection are already filed somewhere — the number the
  // "Remove" action would act on.
  const membership = useMemo(() => membershipMap(collections), [collections]);
  const filed = ids.filter((id) => membership.has(id)).length;

  useEffect(() => {
    if (target.kind === "new") titleRef.current?.focus();
  }, [target.kind]);

  const title = target.kind === "new" ? target.title.trim() : "";
  const nothingToDo = target.kind === "new" && !title;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onApplied();
    } catch (err) {
      // Tauri commands reject with a plain message string (see src/lib/api.ts)
      setError(typeof err === "string" ? err : "Failed to update the collection");
      setBusy(false);
    }
  };

  const apply = () => {
    if (nothingToDo) return;
    void run(() =>
      target.kind === "new"
        ? createCollection(folder, title, ids)
        : addPhotosToCollection(target.id, ids)
    );
  };

  return (
    <ModalDialog
      title={`Add to collection · ${noun}`}
      busy={busy}
      onClose={onClose}
      footer={{
        confirmLabel: target.kind === "new" ? "Create" : "Add",
        busyLabel: "Adding…",
        confirmDisabled: nothingToDo,
        onConfirm: apply,
      }}
    >
      <div className="flex flex-col gap-3">
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="radio"
            name="collection-target"
            checked={target.kind === "new"}
            onChange={() => setTarget({ kind: "new", title: "" })}
            disabled={busy}
            className="mt-1 size-4 accent-accent"
          />
          <span className="flex-1">
            <span className="block">New collection</span>
            <input
              ref={titleRef}
              value={target.kind === "new" ? target.title : ""}
              onChange={(e) => setTarget({ kind: "new", title: e.target.value })}
              onFocus={() => {
                if (target.kind !== "new") setTarget({ kind: "new", title: "" });
              }}
              onKeyDown={(e) => {
                // Escape has to reach ModalDialog's document listener to close.
                if (e.key === "Enter") apply();
              }}
              placeholder="Title"
              aria-label="Collection title"
              spellCheck={false}
              disabled={busy}
              className="mt-1.5 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-foreground/40 focus:border-foreground/30"
              data-testid="collect-new-title-input"
            />
          </span>
        </label>

        {collections.length > 0 && (
          <ul className="max-h-56 overflow-auto rounded-lg border border-border">
            {collections.map((collection) => (
              <li key={collection.id}>
                <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-foreground/5">
                  <input
                    type="radio"
                    name="collection-target"
                    checked={target.kind === "existing" && target.id === collection.id}
                    onChange={() =>
                      setTarget({ kind: "existing", id: collection.id })
                    }
                    disabled={busy}
                    className="size-4 accent-accent"
                  />
                  <span className="flex-1 truncate">{collection.title}</span>
                  <span className="text-xs tabular-nums text-foreground/40">
                    {collection.photoIds.length}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <p className="text-pretty text-xs text-foreground/50">
          A collection holds its photos the way a folder does: adding them here
          takes them out of the folder's grid, and out of any other collection.
        </p>

        {filed > 0 && (
          <div>
            <button
              type="button"
              onClick={() => void run(() => removePhotosFromCollections(ids))}
              disabled={busy}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
              data-testid="collection-remove"
            >
              {filed === count && count === 1
                ? "Remove from collection"
                : `Remove ${filed} from their collection${filed > 1 ? "s" : ""}`}
            </button>
            <p className="mt-1.5 text-xs text-foreground/50">
              They stay in the folder, just not under a title.
            </p>
          </div>
        )}

        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </ModalDialog>
  );
}
