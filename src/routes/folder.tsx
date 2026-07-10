import { useRef } from "react";
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
  const {
    files,
    isDragging,
    dragHandlers,
    openFilePicker,
    removeUpload,
  } = useUpload({
    folder,
    // Refresh so the grid picks up the new photo rows; the grid dismisses each
    // upload tile itself once the processed thumbnail is ready to display.
    onUploadComplete: () => photoGridRef.current?.refresh(),
  });

  return (
    <div
      className="relative min-h-screen font-sans"
      {...dragHandlers}
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
                onClick={openFilePicker}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground/70 transition-colors hover:border-foreground/35 hover:text-foreground"
              >
                Upload
              </button>
            </>
          )}
        </div>

        <section className="mt-8">
          <PhotoGrid
            folder={folder}
            ref={photoGridRef}
            uploads={files}
            onDismissUpload={removeUpload}
          />
        </section>
      </main>

      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-accent/5 p-6">
          <div className="rounded-xl border-2 border-dashed border-accent bg-background/80 px-10 py-8 text-center backdrop-blur-sm">
            <p className="text-base font-medium text-foreground/80">
              Drop images to upload
            </p>
            <p className="mt-1 text-sm text-foreground/50">
              Uploading to <span className="font-mono">{folder}/</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
