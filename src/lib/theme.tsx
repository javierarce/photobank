import { useEffect, useState } from "react";
import { ThemeContext, type Theme } from "./theme-context";

function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme) {
  const resolved = theme === "system" ? getSystemTheme() : theme;
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

/**
 * Holds the selected theme, persists it, and keeps the DOM in sync app-wide.
 * Lives at the root (not in a header control) so the theme applies on every
 * page and the Settings option is just another consumer.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // index.html applies the saved theme before React loads, so reading
  // localStorage during the initial render can't cause a flash.
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem("theme") as Theme | null) ?? "system"
  );

  // Sync the DOM with the selected theme, and while following the system
  // theme, track OS-level changes.
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme("system");
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, [theme]);

  function setTheme(next: Theme) {
    setThemeState(next);
    localStorage.setItem("theme", next);
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
