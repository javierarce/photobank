import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ThemeProvider } from "@/lib/theme";
import { useTheme } from "@/lib/theme-context";

// A tiny consumer so we can drive setTheme and read the current value the same
// way the app's Settings and command palette do.
function Consumer() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("light")}>light</button>
      <button onClick={() => setTheme("system")}>system</button>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <ThemeProvider>
      <Consumer />
    </ThemeProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
});

describe("ThemeProvider", () => {
  it("defaults to system when nothing is stored", () => {
    renderWithProvider();
    expect(screen.getByTestId("theme").textContent).toBe("system");
  });

  it("reads the saved theme from localStorage on mount", () => {
    localStorage.setItem("theme", "dark");
    renderWithProvider();
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("applies the dark class and persists when set to dark", () => {
    renderWithProvider();
    fireEvent.click(screen.getByText("dark"));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("removes the dark class and persists when set to light", () => {
    localStorage.setItem("theme", "dark");
    renderWithProvider();
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    fireEvent.click(screen.getByText("light"));

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("resolves system to the OS appearance (light via the matchMedia stub)", () => {
    localStorage.setItem("theme", "dark");
    renderWithProvider();
    fireEvent.click(screen.getByText("system"));

    expect(localStorage.getItem("theme")).toBe("system");
    // The setup stub reports light, so system resolves to no dark class.
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
