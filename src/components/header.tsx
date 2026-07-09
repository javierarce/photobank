"use client";

import { Suspense } from "react";
import Link from "next/link";
import { SearchBar } from "@/components/search-bar";

export function Header() {
  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight text-foreground"
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
