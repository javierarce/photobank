import { SearchBar } from "@/components/search-bar";
import { SearchResults } from "@/components/search-results";
import { useBackgroundDeselect } from "@/hooks/use-selection";

export default function SearchPage() {
  const handleBackgroundClick = useBackgroundDeselect();
  return (
    <div className="min-h-screen font-sans" onClick={handleBackgroundClick}>
      <main className="app-row py-8">
        <div className="mb-6">
          <SearchBar />
        </div>
        <SearchResults />
      </main>
    </div>
  );
}
