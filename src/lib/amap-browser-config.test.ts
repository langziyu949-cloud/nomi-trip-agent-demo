import { describe, expect, it } from "vitest";

import { getAmapBrowserConfig } from "@/lib/amap-browser-config";

describe("getAmapBrowserConfig", () => {
  it("prefers runtime server variables", () => {
    expect(getAmapBrowserConfig({
      AMAP_JS_API_KEY: "runtime-key",
      AMAP_JS_SECURITY_CODE: "runtime-code",
      NEXT_PUBLIC_AMAP_JS_KEY: "legacy-key",
      NEXT_PUBLIC_AMAP_SECURITY_CODE: "legacy-code",
    })).toEqual({
      key: "runtime-key",
      securityJsCode: "runtime-code",
    });
  });

  it("keeps compatibility with existing NEXT_PUBLIC variables", () => {
    expect(getAmapBrowserConfig({
      NEXT_PUBLIC_AMAP_JS_KEY: "legacy-key",
      NEXT_PUBLIC_AMAP_SECURITY_CODE: "legacy-code",
    })).toEqual({
      key: "legacy-key",
      securityJsCode: "legacy-code",
    });
  });

  it("returns null when either value is missing", () => {
    expect(getAmapBrowserConfig({
      AMAP_JS_API_KEY: "runtime-key",
    })).toBeNull();
  });
});
