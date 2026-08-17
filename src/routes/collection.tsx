import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CollectionHeader } from "@/components/collection-header";
import { PhotoGrid } from "@/components/photo-grid";
import { SearchField } from "@/components/search-field";
import {
  SelectionActionBar,
  SelectionToolbar,
} from "@/components/selection-toolbar";
import { SortDropdown } from "@/components/sort-dropdown";
import { listCollections } from "@/lib/api";
import {
  loadSortMode,
  saveSortMode,
  SORT_OPTIONS,
  type SortMode,
} from "@/lib/photo-sort";
import { useBackgroundDeselect, useSelection } from "@/hooks/use-selection";
import type { Collection } from "@/lib/types";

/**
 * One collection, opened like a folder: only its photos, with a way back to
 * the folder that holds it. Photos are added from the folder page (drag them
 * onto the card, or select and press C); from in here the selection toolbar's
 * Collect can move them on or take them out again.
 */
export default function CollectionPage() {
  // react-router decodes the params, so "My%20Trip" arrives as "My Trip".
  const { folder = "", id = "" } = useParams();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">(
    "loading"
  );
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>(loadSortMode);
  const { selected } = useSelection();
  const handleBackgroundClick = useBackgroundDeselect();
  const navigate = useNavigate();

  const folderHref = `/folders/${encodeURIComponent(folder)}`;

  // Pick this page's collection out of the folder's list. There's no get-one
  // command: the list is short, and working off the same data the grid holds
  // is one less thing that can disagree.
  const adopt = useCallback(
    (all: Collection[]) => {
      const found = all.find((c) => c.id === id) ?? null;
      setCollection(found);
      // Not in the list means it was dissolved (here or in another window).
      setState(found ? "ready" : "missing");
    },
    [id]
  );

  // Only for the first paint. After that the grid reloads the collections for
  // its own filtering and hands them over, so the page never fetches the same
  // list a second time — including on every tick of the 3s import poll.
  useEffect(() => {
    listCollections(folder).then(adopt).catch(() => setState("missing"));
  }, [folder, adopt]);

  const handleSortChange = (mode: SortMode) => {
    setSortMode(mode);
    saveSortMode(mode);
  };

  return (
    <div className="relative min-h-screen font-sans" onClick={handleBackgroundClick}>
      <main className="mx-auto max-w-[1600px] px-6 py-8">
        {/* One breadcrumb line: the folder, a slash, then the collection. The
            folder half is the only way back to it (the header's Folders link
            goes to the root), so it sits outside the branch below — with
            several photos selected the toolbar takes over the rest of the
            row, and before, a back link on its own line survived that. */}
        <div className="flex min-h-[34px] items-center gap-1.5">
          <Link
            to={folderHref}
            title={`Back to ${folder}`}
            className="max-w-[40%] shrink-0 truncate text-xl text-foreground/40 transition-colors hover:text-foreground"
            data-testid="collection-back"
          >
            {folder}
          </Link>

          <div className="flex min-w-0 flex-1 items-center justify-between gap-4">
            {selected.length > 1 ? (
              <SelectionToolbar />
            ) : (
              <>
                <div className="flex min-w-0 items-center gap-1.5">
                  {/* Nothing to join it to until the collection has loaded. */}
                  {state !== "loading" && (
                    <span
                      aria-hidden
                      className="shrink-0 text-xl text-foreground/25"
                    >
                      /
                    </span>
                  )}
                  {collection ? (
                    <CollectionHeader
                      collection={collection}
                      onRenamed={setCollection}
                      // The collection is gone; there's nothing left to show.
                      onUngrouped={() => navigate(folderHref, { replace: true })}
                    />
                  ) : (
                    state === "missing" && (
                      <h1 className="truncate text-xl font-semibold text-foreground">
                        Collection not found
                      </h1>
                    )
                  )}
                </div>
                {selected.length === 1 ? (
                  <SelectionActionBar />
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    <SortDropdown
                      value={sortMode}
                      options={SORT_OPTIONS}
                      onChange={handleSortChange}
                      label="Sort photos"
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {collection && collection.photoIds.length > 0 && (
          <div className="mt-4">
            <SearchField
              value={query}
              onChange={setQuery}
              folder={folder}
              placeholder="Search — try tag:sunset, iso:>=800"
              ariaLabel="Search this collection"
            />
          </div>
        )}

        <section className="mt-6">
          {state === "missing" ? (
            <p className="text-sm text-foreground/60">
              This collection no longer exists.{" "}
              <Link to={folderHref} className="underline">
                Back to {folder}
              </Link>
              .
            </p>
          ) : (
            collection && (
              // Keyed by collection so opening another one remounts the grid
              // rather than cross-fading the previous collection's tiles.
              <PhotoGrid
                key={collection.id}
                folder={folder}
                collectionId={collection.id}
                sortMode={sortMode}
                query={query}
                onCollectionsChange={adopt}
              />
            )
          )}
        </section>
      </main>
    </div>
  );
}
