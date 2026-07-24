import { NextResponse } from "next/server";

import { getAmapBrowserConfig } from "@/lib/amap-browser-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = getAmapBrowserConfig();
  if (!config) {
    return NextResponse.json(
      { error: "AMAP_CONFIG_MISSING" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  return NextResponse.json(config, {
    headers: { "Cache-Control": "no-store" },
  });
}
