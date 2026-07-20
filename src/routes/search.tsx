import { SearchResults } from "@/components/search-results";
import { useBackgroundDeselect } from "@/hooks/use-selection";

export default function SearchPage() {
  const handleBackgroundClick = useBackgroundDeselect();
  return (
    <div className="min-h-screen font-sans" onClick={handleBackgroundClick}>
      <main className="mx-auto max-w-[1600px] px-6 py-8">
        <SearchResults />
      </main>
    </div>
  );
}
