"use client";

import { Suspense } from "react";
import Link from "next/link";
import { SearchBar } from "@/components/search-bar";
import { SearchResults } from "@/components/search-results";

export default function SearchPage() {
  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto max-w-5xl px-6 py-16">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Photobank
          </Link>
          <span className="text-sm text-zinc-400">/</span>
          <h1 className="text-lg font-semibold text-black dark:text-zinc-50">
            Search
          </h1>
        </div>

        <section className="mt-8">
          <SearchBar />
        </section>

        <section className="mt-8">
          <Suspense fallback={<p className="text-sm text-zinc-500">Loading...</p>}>
            <SearchResults />
          </Suspense>
        </section>
      </main>
    </div>
  );
}
