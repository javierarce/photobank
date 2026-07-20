import { Link } from "react-router-dom";
import { SearchBar } from "@/components/search-bar";
import { UpdateBadge } from "@/components/update-badge";

export function Header() {
  return (
    // data-tauri-drag-region: the window uses an overlay title bar, so the
    // header doubles as the draggable region. pl-24 clears the traffic lights.
    <header
      data-tauri-drag-region
      className="border-b border-border bg-background"
    >
      <div
        data-tauri-drag-region
        className="mx-auto flex max-w-[1600px] items-center gap-6 py-4 pl-24 pr-6"
      >
        <Link
          to="/"
          className="text-lg font-semibold tracking-tight text-foreground"
        >
          Photobank
        </Link>
        <div className="flex-1">
          <SearchBar />
        </div>
        <UpdateBadge />
        <Link
          to="/settings"
          aria-label="Settings"
          className="text-sm font-medium text-foreground/50 transition-colors hover:text-foreground"
        >
          Settings
        </Link>
      </div>
    </header>
  );
}
