import {
  intentForConversationModel,
  pruneConversationHistory,
} from "@/lib/ai/conversation-context";
import {
  interpretConversationWithRules,
  needsRealtimeRefresh,
} from "@/lib/ai/conversation-fallback";
import { MiniMaxConversationInterpreter } from "@/lib/ai/conversation-interpreter";
import {
  applyConversationOperations,
  type MiniMaxConversationTurn,
} from "@/lib/ai/conversation-operations";
import { getIntentParserProvider } from "@/lib/ai/config";
import { createConfiguredIntentParser } from "@/lib/ai/intent-parser-provider";
import { MiniMaxClient, type MiniMaxCompletionClient } from "@/lib/ai/minimax-client";
import type { IntentParser } from "@/lib/intent-parser";
import type {
  ConversationPlanFreshness,
  ConversationTurnMeta,
  ConversationTurnRequest,
  ConversationTurnResponse,
} from "@/lib/conversation-turn";
import type { TripIntentDraft } from "@/lib/types";

export interface ConversationTurnServiceOptions {
  env?: NodeJS.ProcessEnv;
  client?: MiniMaxCompletionClient;
  intentParser?: IntentParser;
}

function freshnessFor(request: ConversationTurnRequest): ConversationPlanFreshness {
  return request.planFreshness ?? {
    status: request.planFacts ? "SNAPSHOT" : "MISSING",
    updatedAt: request.planFacts?.plannedAt ?? null,
    refreshedForTurnId: null,
  };
}

function responseBase(
  request: ConversationTurnRequest,
  text: string,
  meta: ConversationTurnMeta,
) {
  return {
    conversationId: request.conversationId,
    turnId: request.turnId,
    text,
    meta,
  };
}

function metaFromIntent(intent: TripIntentDraft): ConversationTurnMeta {
  const understanding = intent.understanding;
  return {
    provider: understanding?.provider ?? "mock",
    model: understanding?.model ?? null,
    fallback: understanding?.fallback ?? false,
  };
}

function firstTurnText(intent: TripIntentDraft): string {
  if (intent.issues.length > 0) return intent.issues[0];
  const stops = intent.stops.map((stop) => stop.label).join("、");
  return `好的，我先按${intent.date}从${intent.origin.label}前往${stops}来规划。`;
}

function publicResponseFromInterpreted(
  request: ConversationTurnRequest,
  interpreted: MiniMaxConversationTurn,
  baseIntent: TripIntentDraft,
  meta: ConversationTurnMeta,
): ConversationTurnResponse {
  if (interpreted.type === "PLAN_CHANGE") {
    try {
      const intent = applyConversationOperations(baseIntent, interpreted.operations, {
        rawText: request.text,
        provider: meta.provider === "minimax" ? "minimax" : "mock",
        model: meta.model,
        fallback: meta.fallback,
      });
      return {
        type: "PLAN_CHANGE",
        ...responseBase(request, interpreted.text, meta),
        intent,
      };
    } catch (error) {
      return {
        type: "CLARIFY",
        ...responseBase(
          request,
          `这次修改还不能安全应用：${error instanceof Error ? error.message : "行程结构无效"}。请再具体说明一下。`,
          meta,
        ),
        reason: "INVALID_CHANGE",
      };
    }
  }
  if (interpreted.type === "ANSWER") {
    return { type: "ANSWER", ...responseBase(request, interpreted.text, meta) };
  }
  if (interpreted.type === "CLARIFY") {
    return {
      type: "CLARIFY",
      ...responseBase(request, interpreted.text, meta),
      reason: interpreted.reason,
    };
  }
  const refreshSet = new Set(interpreted.refresh);
  return {
    type: "REFRESH_REQUIRED",
    ...responseBase(request, interpreted.text, meta),
    refresh: {
      route: refreshSet.has("route"),
      weather: refreshSet.has("weather"),
    },
  };
}

export async function executeConversationTurn(
  request: ConversationTurnRequest,
  options: ConversationTurnServiceOptions = {},
): Promise<ConversationTurnResponse> {
  const env = options.env ?? process.env;
  const now = request.now ? new Date(request.now) : new Date();
  const baseIntent = request.pendingIntent ?? request.currentIntent ?? null;

  // The first turn intentionally stays on the existing configured parser so
  // the legacy endpoint and the conversation endpoint understand trips the
  // same way.
  if (!baseIntent) {
    const parser = options.intentParser ?? createConfiguredIntentParser(env);
    const intent = await parser.parse(request.text, now);
    const meta = metaFromIntent(intent);
    if (intent.stops.length === 0 || intent.issues.length > 0) {
      return {
        type: "CLARIFY",
        ...responseBase(request, firstTurnText(intent), meta),
        // Keep the partial draft so the next user message can resolve the
        // missing field inside this conversation instead of starting over.
        intent,
        reason: "MISSING_CONTEXT",
      };
    }
    return {
      type: "PLAN_CHANGE",
      ...responseBase(request, firstTurnText(intent), meta),
      intent,
    };
  }

  const freshness = freshnessFor(request);
  const refresh = needsRealtimeRefresh(request.text, request.turnId, freshness);
  if (refresh) {
    return {
      type: "REFRESH_REQUIRED",
      ...responseBase(request, "我先刷新路线和天气，再按最新数据回答你。", {
        provider: "rules",
        model: null,
        fallback: false,
      }),
      refresh,
    };
  }

  const provider = getIntentParserProvider(env);
  let minimaxFailure = false;
  let configuredModel: string | null = null;

  if (provider === "minimax") {
    try {
      const client = options.client ?? MiniMaxClient.fromEnv(env);
      configuredModel = client.model;
      const interpreter = new MiniMaxConversationInterpreter(client);
      const interpreted = await interpreter.interpret({
        turnId: request.turnId,
        userText: request.text,
        currentIntent: intentForConversationModel(request.currentIntent),
        pendingIntent: intentForConversationModel(request.pendingIntent),
        planFacts: request.planFacts ?? null,
        planFreshness: freshness,
        recentMessages: pruneConversationHistory(request.history ?? []),
      }, now);
      return publicResponseFromInterpreted(request, interpreted, baseIntent, {
        provider: "minimax",
        model: interpreter.model,
        fallback: false,
      });
    } catch {
      minimaxFailure = true;
      configuredModel = configuredModel ?? (env.MINIMAX_MODEL?.trim() || null);
    }
  }

  let interpreted = interpretConversationWithRules({
    text: request.text,
    currentIntent: baseIntent,
    planFacts: request.planFacts ?? null,
    now,
  });
  if (interpreted.type === "CLARIFY" && interpreted.reason === "UNSUPPORTED") {
    interpreted = {
      ...interpreted,
      text: minimaxFailure || provider === "invalid"
        ? "MiniMax 暂时不可用，这类复杂修改需要模型恢复后重试；当前成功路线保持不变。"
        : "当前处于有限规则模式，这类复杂修改需要启用 MiniMax 后重试；当前成功路线保持不变。",
    };
  }
  return publicResponseFromInterpreted(request, interpreted, baseIntent, {
    provider: "rules",
    model: configuredModel,
    fallback: minimaxFailure || provider === "invalid",
  });
}
