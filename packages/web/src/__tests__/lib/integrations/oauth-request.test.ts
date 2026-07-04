import { describe, it, expect } from "vitest";
import { parseCookieHeader, resolveForwardedOrigin } from "@/lib/integrations/oauth-request";

describe("parseCookieHeader", () => {
  it("returns no meaningful cookie values for an undefined header", () => {
    // Matches the exact pre-existing inline behavior: splitting "" on ";"
    // yields [""], so the map contains a single empty-string key. No caller
    // ever reads that key, so this is behaviorally equivalent to "no cookies".
    expect(parseCookieHeader(undefined)).toEqual({ "": "" });
  });

  it("returns no meaningful cookie values for a null header", () => {
    expect(parseCookieHeader(null)).toEqual({ "": "" });
  });

  it("returns no meaningful cookie values for an empty string header", () => {
    expect(parseCookieHeader("")).toEqual({ "": "" });
  });

  it("parses a single cookie", () => {
    expect(parseCookieHeader("oauth_state=abc123")).toEqual({ oauth_state: "abc123" });
  });

  it("parses multiple cookies separated by '; '", () => {
    expect(parseCookieHeader("oauth_state=abc123; oauth_pending_id=xyz789")).toEqual({
      oauth_state: "abc123",
      oauth_pending_id: "xyz789",
    });
  });

  it("preserves '=' characters within a cookie value via rest.join('=')", () => {
    expect(parseCookieHeader("oauth_state=a=b==")).toEqual({ oauth_state: "a=b==" });
  });

  it("trims whitespace around cookie names", () => {
    expect(parseCookieHeader("oauth_state=abc123;   oauth_pending_id=xyz789")).toEqual({
      oauth_state: "abc123",
      oauth_pending_id: "xyz789",
    });
  });
});

describe("resolveForwardedOrigin", () => {
  it("uses x-forwarded-proto and x-forwarded-host when present", () => {
    const request = new Request("http://localhost:3000/x", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "app.example.com",
      },
    });
    expect(resolveForwardedOrigin(request)).toEqual({
      origin: "https://app.example.com",
      isSecure: true,
    });
  });

  it("uses the first entry of a comma-separated x-forwarded-proto list", () => {
    const request = new Request("http://localhost:3000/x", {
      headers: {
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "app.example.com",
      },
    });
    expect(resolveForwardedOrigin(request)).toEqual({
      origin: "https://app.example.com",
      isSecure: true,
    });
  });

  it("falls back to the request URL origin when no forwarded headers are present", () => {
    const request = new Request("http://localhost:3000/x");
    expect(resolveForwardedOrigin(request)).toEqual({
      origin: "http://localhost:3000",
      isSecure: false,
    });
  });

  it("uses the host header when x-forwarded-host is absent", () => {
    const request = new Request("http://localhost:3000/x", {
      headers: {
        "x-forwarded-proto": "https",
        host: "app.example.com",
      },
    });
    expect(resolveForwardedOrigin(request)).toEqual({
      origin: "https://app.example.com",
      isSecure: true,
    });
  });
});
