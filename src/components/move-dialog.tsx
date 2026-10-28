import { MoveContext } from "@/lib/move-context";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { listFolders } from "@/lib/api";
import { sanitizeFolder } from "@/lib/keys";

export function MoveDialogProvider({ children }: { children: ReactNode }) {
  const [destination, setDestination] = useState<string | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const pending = useRef<((value: string | null) => void) | null>(null);
  const choose = useCallback((initial: string) => new Promise<string | null>((resolve) => {
    pending.current?.(null);
    pending.current = resolve;
    setDestination(initial);
  }), []);
  const close = (value: string | null) => {
    pending.current?.(value);
    pending.current = null;
    setDestination(null);
  };
  useEffect(() => () => pending.current?.(null), []);
  const isOpen = destination !== null;
  useEffect(() => {
    if (!isOpen) return;
    let current = true;
    listFolders().then((all) => {
      if (current) setFolders(all.map((f) => f.folder));
    }).catch(() => {});
    return () => { current = false; };
  }, [isOpen]);
  const valid = sanitizeFolder(destination);

  return (
    <MoveContext.Provider value={choose}>
      {children}
      {destination !== null && (
        <ModalDialog title="Move photos" onClose={() => close(null)} footer={{
          confirmLabel: "Move", confirmDisabled: !valid, onConfirm: () => valid && close(valid),
        }}>
          <label className="flex flex-col gap-2 text-sm">
            Destination folder
            <input list="move-folders" value={destination}
              onChange={(event) => setDestination(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && valid) close(valid); }}
              className="rounded-md border border-border bg-transparent px-3 py-2" />
          </label>
          <datalist id="move-folders">{folders.map((folder) => <option key={folder} value={folder} />)}</datalist>
          {!valid && <p className="mt-2 text-xs text-red-600">Enter a folder name without slashes.</p>}
        </ModalDialog>
      )}
    </MoveContext.Provider>
  );
}
