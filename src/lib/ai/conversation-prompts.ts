import { readPromptSpec } from "@/lib/ai/prompt-specs";
import type { ModelIntentContext } from "@/lib/ai/conversation-context";
import type {
  ConversationHistoryItem,
  ConversationPlanFacts,
  ConversationPlanFreshness,
} from "@/lib/conversation-turn";

export const CONVERSATION_PROMPT_VERSION = "nomi-conversation-v2";

function shanghaiNowContext(now: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

export function buildConversationSystemPrompt(now: Date): string {
  return `${readPromptSpec("conversation")}

## 本轮运行时上下文

- 内部调用版本：${CONVERSATION_PROMPT_VERSION}
- 当前时间：${shanghaiNowContext(now)}
- 固定时区：Asia/Shanghai
- 当前支持城市：上海市`;
}

export interface ConversationPromptContext {
  turnId: string;
  userText: string;
  currentIntent: ModelIntentContext | null;
  pendingIntent: ModelIntentContext | null;
  planFacts: ConversationPlanFacts | null;
  planFreshness: ConversationPlanFreshness;
  recentMessages: ConversationHistoryItem[];
}

export function buildConversationUserPrompt(context: ConversationPromptContext): string {
  return `请处理本轮行程对话。结果中的 text 会直接展示给用户：请自然承接本轮原话，优先回答这一轮的关注点，不要复述无关的旧计划，也不要使用固定开场。运行时数据：${JSON.stringify(context)}`;
}

export function buildConversationRepairPrompt(
  context: ConversationPromptContext,
  previousOutput: string,
  validationIssue: string,
): string {
  return `上一次输出不符合多轮行程对话协议。请重新输出一个完整、严格且只有一个 JSON 对象。
校验问题：${validationIssue.slice(0, 600)}
本轮运行时数据：${JSON.stringify(context)}
上一次输出：${previousOutput.slice(0, 4_000)}`;
}
