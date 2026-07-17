import { NextResponse } from "next/server";

import { createConfiguredTripNarrator } from "@/lib/ai/narrator-provider";
import { MiniMaxError } from "@/lib/ai/minimax-client";
import { TripPlanNarrationRequestSchema } from "@/lib/ai/schemas";
import { buildTemplateNarration } from "@/lib/ai/trip-narrator";
import type { TripPlan } from "@/lib/types";

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const parsed = TripPlanNarrationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "缺少生成行程总结所需的数据。", code: "INVALID_NARRATION_INPUT", retryable: false },
      { status: 400 },
    );
  }

  const plan = (body as { plan: TripPlan }).plan;
  try {
    return NextResponse.json(await createConfiguredTripNarrator().narrate(plan));
  } catch (error) {
    const errorCode = error instanceof MiniMaxError ? error.code : "NARRATION_UNKNOWN";
    const fallbackReason = error instanceof Error ? error.message.slice(0, 200) : "生成总结时发生未知错误。";
    return NextResponse.json(buildTemplateNarration(plan, {
      fallback: true,
      errorCode,
      fallbackReason,
    }));
  }
}
