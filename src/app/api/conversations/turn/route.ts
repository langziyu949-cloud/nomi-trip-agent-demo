import { NextResponse } from "next/server";

import { executeConversationTurn } from "@/lib/ai/conversation-turn-service";
import { MiniMaxError } from "@/lib/ai/minimax-client";
import { ConversationTurnRequestSchema } from "@/lib/conversation-turn";

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const parsed = ConversationTurnRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "这轮对话缺少有效的会话、消息或行程上下文。",
        code: "INVALID_CONVERSATION_TURN",
        retryable: false,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await executeConversationTurn(parsed.data));
  } catch (error) {
    if (error instanceof MiniMaxError) {
      return NextResponse.json(
        { error: error.message, code: error.code, retryable: error.retryable },
        { status: error.status },
      );
    }
    return NextResponse.json(
      {
        error: "处理这轮行程对话时发生未知错误。",
        code: "CONVERSATION_TURN_UNKNOWN",
        retryable: true,
      },
      { status: 500 },
    );
  }
}
