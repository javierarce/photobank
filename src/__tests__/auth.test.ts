import { describe, it, expect } from "vitest";
import { isAuthorized } from "@/lib/auth";

function basic(user: string, pass: string) {
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

describe("isAuthorized", () => {
  it("accepts correct credentials", () => {
    expect(isAuthorized(basic("admin", "secret"), "admin", "secret")).toBe(true);
  });

  it("rejects wrong password", () => {
    expect(isAuthorized(basic("admin", "wrong"), "admin", "secret")).toBe(false);
  });

  it("rejects wrong username", () => {
    expect(isAuthorized(basic("root", "secret"), "admin", "secret")).toBe(false);
  });

  it("rejects missing or malformed headers", () => {
    expect(isAuthorized(null, "admin", "secret")).toBe(false);
    expect(isAuthorized("", "admin", "secret")).toBe(false);
    expect(isAuthorized("Bearer token", "admin", "secret")).toBe(false);
    expect(isAuthorized("Basic not-base64!!!", "admin", "secret")).toBe(false);
    expect(isAuthorized(`Basic ${btoa("no-colon")}`, "admin", "secret")).toBe(false);
  });

  it("handles passwords containing colons", () => {
    expect(isAuthorized(basic("admin", "se:cr:et"), "admin", "se:cr:et")).toBe(true);
  });

  it("rejects empty credentials even if expected values are empty", () => {
    // proxy disables auth when AUTH_PASSWORD is unset, but the check itself
    // should still behave sanely
    expect(isAuthorized(basic("", ""), "admin", "secret")).toBe(false);
  });
});
