import { NavLink } from "react-router-dom";
import { UpdateBadge } from "@/components/update-badge";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm font-medium transition-colors ${
    isActive ? "text-foreground" : "text-foreground/50 hover:text-foreground"
  }`;

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
        <nav className="flex items-center gap-5">
          {/* `end` so Folders only lights up on "/", not on nested routes. */}
          <NavLink to="/" end className={linkClass}>
            Folders
          </NavLink>
          <NavLink to="/tags" className={linkClass}>
            Tags
          </NavLink>
        </nav>
        <div className="flex-1" />
        <UpdateBadge />
        <NavLink to="/settings" aria-label="Settings" className={linkClass}>
          Settings
        </NavLink>
      </div>
    </header>
  );
}
