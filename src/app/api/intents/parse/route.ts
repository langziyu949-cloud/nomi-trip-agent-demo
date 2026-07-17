import { NextResponse } from "next/server";
import { z } from "zod";

import { createConfiguredIntentParser } from "@/lib/ai/intent-parser-provider";
import { MiniMaxError } from "@/lib/ai/minimax-client";

const RequestSchema = z.object({
  text: z.string().trim().min(2).max(240),
  now: z.string().datetime().optional(),
});

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "请输入一条完整的出行需求。", code: "INVALID_INTENT", retryable: false },
      { status: 400 },
    );
  }

  try {
    const intentParser = createConfiguredIntentParser();
    const intent = await intentParser.parse(
      parsed.data.text,
      parsed.data.now ? new Date(parsed.data.now) : new Date(),
    );
    return NextResponse.json(intent);
  } catch (error) {
    if (error instanceof MiniMaxError) {
      return NextResponse.json(
        { error: error.message, code: error.code, retryable: error.retryable },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: "理解行程时发生未知错误。", code: "INTENT_UNKNOWN", retryable: true },
      { status: 500 },
    );
  }
}
