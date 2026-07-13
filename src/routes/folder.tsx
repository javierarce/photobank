import { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { PhotoGrid, PhotoGridRef } from "@/components/photo-grid";
import { SelectionToolbar } from "@/components/selection-toolbar";
import { useUpload } from "@/hooks/use-upload";
import { useBackgroundDeselect, useSelection } from "@/hooks/use-selection";

export default function FolderPage() {
  // react-router decodes the param, so "My%20Trip" arrives as "My Trip"
  const { folder = "" } = useParams();
  const photoGridRef = useRef<PhotoGridRef>(null);
  const { selected } = useSelection();
  const handleBackgroundClick = useBackgroundDeselect();
  const { files, dropFolder, openFilePicker, removeUpload, onUploadComplete } =
    useUpload();

  // Refresh so the grid picks up the new photo rows once an import into this
  // folder settles; the grid dismisses each upload tile itself when the
  // processed thumbnail is ready to display.
  useEffect(() => {
    return onUploadComplete((completedFolder) => {
      if (completedFolder === folder) photoGridRef.current?.refresh();
    });
  }, [onUploadComplete, folder]);

  const folderUploads = files.filter((f) => f.folder === folder);

  return (
    <div
      className="relative min-h-screen font-sans"
      data-drop-folder={folder}
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
              <h1 className="text-xl font-semibold text-foreground">
                {folder}
              </h1>
              <button
                type="button"
                onClick={() => openFilePicker(folder)}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97]"
              >
                Upload
              </button>
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
            uploads={folderUploads}
            onDismissUpload={removeUpload}
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
