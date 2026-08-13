import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { NewFolderDialog } from "@/components/new-folder-dialog";
import { useUpload } from "@/hooks/use-upload";

/** The home page's New folder action: the header button and the dialog it
 * opens, which is where creating a folder is explained. */
export function NewFolderButton({
  /** The folder names already in the listing, passed to the dialog so a typed
   * name resolves to an existing folder rather than a case-variant sibling. */
  existing,
}: {
  existing: string[];
}) {
  const [open, setOpen] = useState(false);
  const { importPaths } = useUpload();
  const navigate = useNavigate();

  const handleCreate = (folder: string, paths: string[]) => {
    setOpen(false);
    // Land on the folder first, then start the import: its tiles (and the
    // progress) belong to that page.
    navigate(`/folders/${encodeURIComponent(folder)}`);
    if (paths.length) importPaths(paths, folder);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97]"
        data-testid="new-folder-button"
      >
        New folder
      </button>
      {open && (
        <NewFolderDialog
          existing={existing}
          onCreate={handleCreate}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
