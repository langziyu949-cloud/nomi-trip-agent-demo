import {
  buildConversationRepairPrompt,
  buildConversationSystemPrompt,
  buildConversationUserPrompt,
  type ConversationPromptContext,
} from "@/lib/ai/conversation-prompts";
import type { MiniMaxCompletionClient } from "@/lib/ai/minimax-client";
import { MiniMaxError } from "@/lib/ai/minimax-client";
import {
  MiniMaxConversationTurnSchema,
  type MiniMaxConversationTurn,
} from "@/lib/ai/conversation-operations";
import { extractJsonObjects } from "@/lib/ai/schemas";
import { validateGroundedAnswer } from "@/lib/ai/conversation-context";

function validationSummary(error: unknown): string {
  return error instanceof Error ? error.message : "输出不是有效的多轮对话 JSON";
}

function validateUserFacingText(text: string): void {
  if (/先确认你最关心的(?:时间|问题|信息)/.test(text)) {
    throw new Error("回复使用了重复、生硬的固定开场");
  }
}

export class MiniMaxConversationInterpreter {
  readonly model: string;

  constructor(private readonly client: MiniMaxCompletionClient) {
    this.model = client.model;
  }

  async interpret(context: ConversationPromptContext, now = new Date()): Promise<MiniMaxConversationTurn> {
    const systemPrompt = buildConversationSystemPrompt(now);
    let previousOutput = "";
    let previousIssue = "";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const userPrompt = attempt === 0
        ? buildConversationUserPrompt(context)
        : buildConversationRepairPrompt(context, previousOutput, previousIssue);
      const output = await this.client.complete({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxCompletionTokens: 2_048,
        temperature: 0.3,
      });

      try {
        const candidates = extractJsonObjects(output);
        const validationIssues: string[] = [];
        for (const candidate of candidates.toReversed()) {
          const parsed = MiniMaxConversationTurnSchema.safeParse(candidate);
          if (!parsed.success) {
            validationIssues.push(parsed.error.issues
              .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
              .join("；"));
            continue;
          }
          validateUserFacingText(parsed.data.text);
          if (parsed.data.type === "ANSWER") {
            validateGroundedAnswer(parsed.data.text, context.userText, context.planFacts);
          }
          return parsed.data;
        }
        throw new Error(validationIssues[0] || "JSON 对象不符合多轮对话协议");
      } catch (error) {
        previousOutput = output;
        previousIssue = validationSummary(error);
      }
    }

    throw new MiniMaxError(
      `MiniMax 连续返回了无效的多轮对话结构：${previousIssue.slice(0, 180) || "未知校验错误"}。`,
      "MINIMAX_INVALID_CONVERSATION_TURN",
      502,
      true,
    );
  }
}
