import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Header } from "@/components/header";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

afterEach(() => {
  cleanup();
});

describe("Header", () => {
  it("renders the Photobank link", () => {
    render(<Header />);

    const link = screen.getByText("Photobank");
    expect(link).toBeInTheDocument();
    expect(link.closest("a")?.getAttribute("href")).toBe("/");
  });

  it("renders the search bar", () => {
    render(<Header />);

    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
  });
});
