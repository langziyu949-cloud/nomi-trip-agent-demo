import { NextRequest, NextResponse } from "next/server";

import { ProviderError, searchPlaces } from "@/lib/amap";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim();
  const city = request.nextUrl.searchParams.get("city")?.trim() || "上海市";
  if (!query) {
    return NextResponse.json(
      { error: "缺少地点关键词。", code: "PLACE_QUERY_MISSING", retryable: false },
      { status: 400 },
    );
  }

  try {
    const candidates = await searchPlaces(query, city);
    if (candidates.length === 0) {
      return NextResponse.json(
        { error: `没有在${city}找到“${query}”。`, code: "PLACE_NOT_FOUND", retryable: false },
        { status: 404 },
      );
    }
    return NextResponse.json({ candidates, provider: "amap" });
  } catch (error) {
    if (error instanceof ProviderError) {
      return NextResponse.json(
        { error: error.message, code: error.code, retryable: error.retryable },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: "地点服务发生未知错误。", code: "PLACE_UNKNOWN", retryable: true },
      { status: 500 },
    );
  }
}
