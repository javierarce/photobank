import { FolderList } from "@/components/folder-list";
import { SearchBar } from "@/components/search-bar";

export default function HomePage() {
  return (
    <div className="relative min-h-screen font-sans">
      <main className="mx-auto max-w-[1600px] px-6 py-8">
        <section>
          <h2 className="mb-4 text-lg font-semibold text-foreground">
            Folders
          </h2>
          <div className="mb-6">
            <SearchBar />
          </div>
          <FolderList />
        </section>
      </main>
    </div>
  );
}
