import { describe, expect, it } from "vitest";

import { isValidDemoAuthorization } from "@/proxy";

function basic(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

describe("NOMI Demo access protection", () => {
  it("accepts the exact configured username and password", () => {
    expect(isValidDemoAuthorization(basic("nomi", "demo-secret"), "nomi", "demo-secret")).toBe(true);
  });

  it("rejects missing, malformed, or incorrect credentials", () => {
    expect(isValidDemoAuthorization(null, "nomi", "demo-secret")).toBe(false);
    expect(isValidDemoAuthorization("Bearer token", "nomi", "demo-secret")).toBe(false);
    expect(isValidDemoAuthorization(basic("nomi", "wrong"), "nomi", "demo-secret")).toBe(false);
    expect(isValidDemoAuthorization(basic("other", "demo-secret"), "nomi", "demo-secret")).toBe(false);
  });
});
