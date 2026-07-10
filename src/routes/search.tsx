import { SearchResults } from "@/components/search-results";

export default function SearchPage() {
  return (
    <div className="min-h-screen font-sans">
      <main className="mx-auto max-w-5xl px-6 py-8">
        <SearchResults />
      </main>
    </div>
  );
}
