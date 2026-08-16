import { useState } from "react";
import { FolderList } from "@/components/folder-list";
import { NewFolderButton } from "@/components/new-folder-button";
import { SearchBar } from "@/components/search-bar";
import { SortDropdown } from "@/components/sort-dropdown";
import {
  FOLDER_SORT_OPTIONS,
  loadFolderSortMode,
  saveFolderSortMode,
  type FolderSortMode,
} from "@/lib/folder-sort";

export default function HomePage() {
  // Like the photo sort, the folder order is a preference that outlives the
  // session.
  const [sortMode, setSortMode] = useState<FolderSortMode>(loadFolderSortMode);
  // The listing's folder names, which New folder matches a typed name against.
  const [folderNames, setFolderNames] = useState<string[]>([]);

  const handleSortChange = (mode: FolderSortMode) => {
    setSortMode(mode);
    saveFolderSortMode(mode);
  };

  return (
    <div className="relative min-h-screen font-sans">
      <main className="app-row py-8">
        <section>
          <div className="mb-4 flex min-h-[34px] items-center justify-between gap-4">
            <h2 className="text-lg font-semibold text-foreground">Folders</h2>
            <div className="flex shrink-0 items-center gap-2">
              <SortDropdown
                value={sortMode}
                options={FOLDER_SORT_OPTIONS}
                onChange={handleSortChange}
                label="Sort folders"
              />
              <NewFolderButton existing={folderNames} />
            </div>
          </div>
          <div className="mb-6">
            <SearchBar />
          </div>
          <FolderList sort={sortMode} onFoldersLoaded={setFolderNames} />
        </section>
      </main>
    </div>
  );
}
