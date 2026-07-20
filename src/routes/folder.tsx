import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { FolderTitle } from "@/components/folder-title";
import { PhotoGrid, PhotoGridRef } from "@/components/photo-grid";
import { SelectionToolbar } from "@/components/selection-toolbar";
import { SortDropdown } from "@/components/sort-dropdown";
import { loadSortMode, saveSortMode, type SortMode } from "@/lib/photo-sort";
import { useUpload } from "@/hooks/use-upload";
import { useBackgroundDeselect, useSelection } from "@/hooks/use-selection";

export default function FolderPage() {
  // react-router decodes the param, so "My%20Trip" arrives as "My Trip"
  const { folder = "" } = useParams();
  const [editingTitle, setEditingTitle] = useState(false);
  // While the backend rename is re-keying the folder's photos, mutations of
  // the folder are locked out (Upload, Rename, drag-and-drop): a photo added
  // mid-rename would be left behind under the old name.
  const [renamingFolder, setRenamingFolder] = useState(false);
  // Sort order is a global preference, persisted across folders and launches.
  const [sortMode, setSortMode] = useState<SortMode>(loadSortMode);
  const photoGridRef = useRef<PhotoGridRef>(null);
  const { selected } = useSelection();
  const handleBackgroundClick = useBackgroundDeselect();
  const {
    files,
    dropFolder,
    openFilePicker,
    removeUpload,
    cancelUpload,
    onUploadComplete,
  } = useUpload();

  // Refresh so the grid picks up the new photo rows once an import into this
  // folder settles; the grid dismisses each upload tile itself when the
  // processed thumbnail is ready to display.
  useEffect(() => {
    return onUploadComplete((completedFolder) => {
      if (completedFolder === folder) photoGridRef.current?.refresh();
    });
  }, [onUploadComplete, folder]);

  const folderUploads = files.filter((f) => f.folder === folder);
  const cancellable = folderUploads.filter(
    (u) => u.status === "pending" || u.status === "uploading"
  );
  // Renaming while an import is writing into this folder would race it (the
  // backend refuses too), so Rename waits for uploads to settle.
  const importing = folderUploads.some(
    (u) =>
      u.status === "pending" ||
      u.status === "uploading" ||
      u.status === "cancelling"
  );

  const handleSortChange = (mode: SortMode) => {
    setSortMode(mode);
    saveSortMode(mode);
  };

  return (
    <div
      className="relative min-h-screen font-sans"
      data-drop-folder={renamingFolder ? undefined : folder}
      onClick={handleBackgroundClick}
    >
      <main className="mx-auto max-w-5xl px-6 py-8">
        {/* The folder title bar turns into a bulk-action toolbar while photos
            are selected; otherwise it shows the folder name + Upload. */}
        <div className="flex min-h-[34px] items-center justify-between gap-4">
          {selected.length > 0 ? (
            <SelectionToolbar />
          ) : (
            <>
              <FolderTitle
                folder={folder}
                editing={editingTitle}
                onEditingChange={setEditingTitle}
                onRenamingChange={setRenamingFolder}
              />
              <div className="flex shrink-0 items-center gap-2">
                <SortDropdown value={sortMode} onChange={handleSortChange} />
                {cancellable.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      cancellable.forEach((u) => cancelUpload(u.key))
                    }
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97]"
                  >
                    Cancel {cancellable.length} upload
                    {cancellable.length > 1 ? "s" : ""}
                  </button>
                )}
                {/* inbox is the import default — renaming it would only see
                    it reappear on the next upload (the backend refuses too) */}
                {folder !== "inbox" && (
                  <button
                    type="button"
                    onClick={() => setEditingTitle(true)}
                    disabled={renamingFolder || importing}
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
                  >
                    Rename
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openFilePicker(folder)}
                  disabled={renamingFolder}
                  className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
                >
                  Upload
                </button>
              </div>
            </>
          )}
        </div>

        <section className="mt-8">
          {/* Key by folder so navigating between folders remounts the grid:
              its photo state resets and the new folder loads fresh, rather than
              the previous folder's tiles lingering (and animating out) while the
              new fetch is in flight. */}
          <PhotoGrid
            key={folder}
            folder={folder}
            ref={photoGridRef}
            sortMode={sortMode}
            uploads={folderUploads}
            onDismissUpload={removeUpload}
            onCancelUpload={cancelUpload}
          />
        </section>
      </main>

      {dropFolder === folder && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <p className="text-lg font-semibold text-white">
            Drop images to upload to{" "}
            <span className="font-mono">{folder}/</span>
          </p>
        </div>
      )}
    </div>
  );
}
