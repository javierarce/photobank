import { useEffect, useRef, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { createCollection } from "@/lib/api";
import type { Collection } from "@/lib/types";

/**
 * Names a new, empty collection in a folder — the counterpart to New folder on
 * the home page. It starts empty on purpose: the card it creates is a drop
 * target, so photos go in by dragging them onto it (or by selecting them and
 * pressing C, which offers this collection alongside the rest).
 */
export function NewCollectionDialog({
  folder,
  onClose,
  onCreated,
}: {
  folder: string;
  onClose: () => void;
  onCreated: (collection: Collection) => void;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = title.trim();

  const create = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createCollection(folder, trimmed, []));
    } catch (err) {
      // Tauri commands reject with a plain message string (see src/lib/api.ts)
      setError(
        typeof err === "string" ? err : "Failed to create the collection"
      );
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      title="New collection"
      busy={busy}
      onClose={onClose}
      footer={{
        confirmLabel: "Create",
        busyLabel: "Creating…",
        confirmDisabled: !trimmed,
        onConfirm: create,
      }}
    >
      <div className="flex flex-col gap-2">
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            // Escape has to reach ModalDialog's document listener to close.
            if (e.key === "Enter") create();
          }}
          placeholder="Collection title"
          aria-label="Collection title"
          spellCheck={false}
          disabled={busy}
          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-foreground/40 focus:border-foreground/30"
          data-testid="new-collection-input"
        />
        <p className="text-xs text-foreground/50">
          It starts empty — drag photos onto its card to fill it.
        </p>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </ModalDialog>
  );
}
