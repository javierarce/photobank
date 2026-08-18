import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FolderTitle } from "@/components/folder-title";
import { NewCollectionDialog } from "@/components/new-collection-dialog";
import { SearchField } from "@/components/search-field";
import { PhotoGrid, PhotoGridRef } from "@/components/photo-grid";
import {
  SelectionActionBar,
  SelectionToolbar,
} from "@/components/selection-toolbar";
import { SegmentedControl } from "@/components/segmented-control";
import { SortDropdown } from "@/components/sort-dropdown";
import {
  loadSortMode,
  saveSortMode,
  SORT_OPTIONS,
  type SortMode,
} from "@/lib/photo-sort";
import {
  ORIENTATION_OPTIONS,
  type OrientationFilter,
} from "@/lib/orientation";
import type { UploadSummary } from "@/lib/upload-progress";
import { useUpload } from "@/hooks/use-upload";
import { useBackgroundDeselect, useSelection } from "@/hooks/use-selection";

export default function FolderPage() {
  // react-router decodes the param, so "My%20Trip" arrives as "My Trip"
  const { folder = "" } = useParams();
  const [editingTitle, setEditingTitle] = useState(false);
  // The in-folder search query — an Ankitron-style typed query (tag:, camera:,
  // iso:>=800, …) the grid runs against this folder.
  const [query, setQuery] = useState("");
  // The grid reports whether this folder has any photos; the search field only
  // appears once there's something to search.
  const [hasPhotos, setHasPhotos] = useState(false);
  // While the backend rename is re-keying the folder's photos, mutations of
  // the folder are locked out (Upload, Rename, drag-and-drop): a photo added
  // mid-rename would be left behind under the old name.
  const [renamingFolder, setRenamingFolder] = useState(false);
  // Sort order is a global preference, persisted across folders and launches.
  const [sortMode, setSortMode] = useState<SortMode>(loadSortMode);
  // Which way the photos are turned. Kept for the session (it rides along from
  // folder to folder, like the sort) but deliberately NOT persisted across
  // launches: a sort order only reorders, whereas this hides photos, and
  // opening the app to a silently thinned-out folder is a bad surprise.
  const [orientation, setOrientation] = useState<OrientationFilter>("all");
  // Naming a collection before it has any photos — the counterpart to New
  // folder on the home page. Photos are dragged onto its card afterwards.
  const [naming, setNaming] = useState(false);
  const photoGridRef = useRef<PhotoGridRef>(null);
  const { selected } = useSelection();
  const handleBackgroundClick = useBackgroundDeselect();
  const navigate = useNavigate();
  const {
    files,
    dropFolder,
    summarize,
    openFilePicker,
    removeUpload,
    cancelUpload,
    onUploadComplete,
    registerDragTracker,
  } = useUpload();

  // The folder page stays mounted across folder navigation (only the grid is
  // keyed), so clear the search when the folder changes. Adjusting during
  // render — not in an effect — avoids a stale-query flash on the new folder.
  const [searchedFolder, setSearchedFolder] = useState(folder);
  if (searchedFolder !== folder) {
    setSearchedFolder(folder);
    setQuery("");
    setHasPhotos(false);
  }

  // Refresh so the grid picks up the new photo rows once an import into this
  // folder settles; the grid dismisses each upload tile itself when the
  // processed thumbnail is ready to display.
  useEffect(() => {
    return onUploadComplete((completedFolder) => {
      if (completedFolder === folder) photoGridRef.current?.refresh();
    });
  }, [onUploadComplete, folder]);

  const folderUploads = files.filter((f) => f.folder === folder);
  // One number for the whole drop, next to the per-tile percentages.
  const batch = summarize(folder);
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
      <main className="app-row py-8">
        {/* The folder title bar turns into a bulk-action toolbar once SEVERAL
            photos are selected. A single selection keeps the folder name in
            place and only swaps the right-hand controls for the actions, so
            clicking one thumbnail doesn't feel like changing modes. */}
        <div className="flex min-h-[34px] items-center justify-between gap-4">
          {selected.length > 1 ? (
            <SelectionToolbar />
          ) : (
            <>
              <FolderTitle
                folder={folder}
                editing={editingTitle}
                onEditingChange={setEditingTitle}
                onRenamingChange={setRenamingFolder}
              />
              {selected.length === 1 ? (
                <SelectionActionBar />
              ) : (
                <div className="flex shrink-0 items-center gap-2">
                  {/* Cancelling the rest of the batch lives on the bar's ✕,
                      so there's no separate Cancel button here. */}
                  {batch.total > 0 && (
                    <UploadProgress
                      {...batch}
                      cancellable={cancellable.length}
                      onCancel={() =>
                        cancellable.forEach((u) => cancelUpload(u.key))
                      }
                    />
                  )}
                  <SortDropdown
                    value={sortMode}
                    options={SORT_OPTIONS}
                    onChange={handleSortChange}
                    label="Sort photos"
                  />
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
                    onClick={() => setNaming(true)}
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
                  >
                    New collection
                  </button>
                  <button
                    type="button"
                    onClick={() => openFilePicker(folder)}
                    disabled={renamingFolder}
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
                  >
                    Upload
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Narrow the grid with the same typed-query engine as global search
            (tag:, camera:, iso:>=800, …), scoped to this folder — only once the
            folder actually has photos to search. */}
        {hasPhotos && (
          <div className="mt-4 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <SearchField
                value={query}
                onChange={setQuery}
                folder={folder}
                placeholder="Search — try tag:sunset, iso:>=800"
                ariaLabel="Search this folder"
              />
            </div>
            {/* Sits with the search field rather than the header buttons: both
                narrow what the grid shows, and neither is an action. */}
            <SegmentedControl
              value={orientation}
              options={ORIENTATION_OPTIONS}
              onChange={setOrientation}
              label="Filter by orientation"
            />
          </div>
        )}

        <section className={hasPhotos ? "mt-6" : "mt-8"}>
          {/* Key by folder so navigating between folders remounts the grid:
              its photo state resets and the new folder loads fresh, rather than
              the previous folder's tiles lingering (and animating out) while the
              new fetch is in flight. */}
          <PhotoGrid
            key={folder}
            folder={folder}
            ref={photoGridRef}
            sortMode={sortMode}
            orientation={orientation}
            query={query}
            onHasPhotosChange={setHasPhotos}
            uploads={folderUploads}
            onDismissUpload={removeUpload}
            onCancelUpload={cancelUpload}
            onOpenCollection={(collection) =>
              navigate(
                `/folders/${encodeURIComponent(folder)}/collections/${collection.id}`
              )
            }
            registerDragTracker={registerDragTracker}
          />
        </section>
      </main>

      {naming && (
        <NewCollectionDialog
          folder={folder}
          onClose={() => setNaming(false)}
          onCreated={() => {
            setNaming(false);
            // The new (empty) card comes from the grid's own collection list.
            photoGridRef.current?.refresh();
          }}
        />
      )}

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

/** The whole drop's progress in the folder header: a bar, how many files have
 * landed, one percentage for the batch — the per-tile percentages only say
 * where each individual file is — and an ✕ to cancel what's left, sitting
 * with the readout it acts on. */
function UploadProgress({
  total,
  completed,
  percent,
  failed,
  cancellable,
  onCancel,
}: UploadSummary & {
  /** How many uploads can still be stopped; 0 hides the ✕. */
  cancellable: number;
  onCancel: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`Uploading ${total} image${total > 1 ? "s" : ""}`}
        className="h-1 w-20 overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className="h-full bg-accent transition-[width] duration-200 ease-linear"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-sm tabular-nums text-foreground/60">
        {completed}/{total} · {percent}%
      </span>
      {failed > 0 && (
        <span className="text-sm tabular-nums text-red-600 dark:text-red-400">
          {failed} failed
        </span>
      )}
      {cancellable > 0 && (
        <button
          type="button"
          onClick={onCancel}
          aria-label={`Cancel ${cancellable} upload${cancellable > 1 ? "s" : ""}`}
          title={`Cancel ${cancellable} upload${cancellable > 1 ? "s" : ""}`}
          className="p-1 text-sm leading-none text-foreground/40 transition-colors hover:text-foreground"
        >
          ✕
        </button>
      )}
    </div>
  );
}
