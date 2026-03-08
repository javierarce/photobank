"use client";

import { Suspense } from "react";
import Link from "next/link";
import { SearchBar } from "@/components/search-bar";

export function Header() {
  return (
    <header className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-black">
      <div className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight text-black dark:text-zinc-50"
        >
          Photobank
        </Link>
        <div className="flex-1">
          <Suspense>
            <SearchBar />
          </Suspense>
        </div>
      </div>
    </header>
  );
}
