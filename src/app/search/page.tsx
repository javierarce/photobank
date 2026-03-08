"use client";

import { Suspense } from "react";
import { SearchResults } from "@/components/search-results";

export default function SearchPage() {
  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Suspense fallback={<p className="text-sm text-zinc-500">Loading...</p>}>
          <SearchResults />
        </Suspense>
      </main>
    </div>
  );
}
