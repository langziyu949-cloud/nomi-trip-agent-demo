import { describe, expect, it } from "vitest";

import { validateGroundedAnswer } from "@/lib/ai/conversation-context";
import type { MiniMaxCompletionClient, MiniMaxCompletionRequest } from "@/lib/ai/minimax-client";
import { executeConversationTurn } from "@/lib/ai/conversation-turn-service";
import {
  ConversationTurnRequestSchema,
  type ConversationPlanFacts,
  type ConversationTurnRequest,
} from "@/lib/conversation-turn";
import { DEFAULT_PLACES } from "@/lib/default-places";
import type { IntentParser } from "@/lib/intent-parser";
import type { TripIntentDraft } from "@/lib/types";

class ScriptedClient implements MiniMaxCompletionClient {
  readonly model = "MiniMax-Test";
  readonly requests: MiniMaxCompletionRequest[] = [];

  constructor(private readonly outputs: string[]) {}

  async complete(request: MiniMaxCompletionRequest): Promise<string> {
    this.requests.push(request);
    return this.outputs[Math.min(this.requests.length - 1, this.outputs.length - 1)];
  }
}

function currentIntent(): TripIntentDraft {
  const timeConstraint = {
    type: "ARRIVE_BY" as const,
    time: "08:00",
    targetStopIndex: 0,
    inferred: false,
  };
  return {
    rawText: "明早八点送孩子到学校，然后去公司",
    date: "2026-07-18",
    city: "上海市",
    origin: { key: "home", label: "家", query: "家", resolved: structuredClone(DEFAULT_PLACES.home) },
    stops: [
      { key: "school", label: "儿子学校", query: "儿子学校", resolved: structuredClone(DEFAULT_PLACES.school) },
      { key: "company", label: "我的公司", query: "我的公司", resolved: structuredClone(DEFAULT_PLACES.company) },
    ],
    timeConstraint,
    timeConstraints: [timeConstraint],
    preferences: ["precondition_vehicle"],
    confidence: 0.96,
    issues: [],
  };
}

function planFacts(): ConversationPlanFacts {
  return {
    tripDate: "2026-07-18",
    plannedAt: "2026-07-17T06:00:00.000Z",
    origin: "家",
    departureTime: "07:20",
    stops: [
      { name: "儿子学校", eta: "08:00", departureTime: "08:05", dwellMinutes: 5 },
      { name: "我的公司", eta: "08:40", departureTime: null, dwellMinutes: 0 },
    ],
    totalDistanceKm: 18.6,
    totalDurationMinutes: 63,
    planningBufferMinutes: 6,
    weather: {
      available: true,
      condition: "小雨",
      temperatureC: 19,
      humidity: 81,
      reportTime: "2026-07-17 14:00",
      source: "forecast",
    },
    vehicle: {
      batteryPercent: 42,
      estimatedArrivalBattery: 36.8,
      cabinTemperatureC: 22,
    },
    actions: [],
    notes: [],
  };
}

function request(overrides: Partial<ConversationTurnRequest> = {}): ConversationTurnRequest {
  return {
    conversationId: "conversation-1",
    turnId: "turn-2",
    text: "改成九点出发",
    currentIntent: currentIntent(),
    pendingIntent: null,
    planFacts: planFacts(),
    planFreshness: {
      status: "FRESH",
      updatedAt: "2026-07-17T06:00:00.000Z",
      refreshedForTurnId: null,
    },
    history: [],
    ...overrides,
  };
}

function providerEnv(provider: "mock" | "minimax"): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", INTENT_PARSER_PROVIDER: provider };
}

describe("executeConversationTurn", () => {
  it("没有当前意图时复用已配置的首次解析器", async () => {
    const parser: IntentParser = {
      async parse(text) {
        return { ...currentIntent(), rawText: text };
      },
    };
    const result = await executeConversationTurn(request({
      currentIntent: null,
      planFacts: null,
      text: "明早送孩子上学",
    }), { intentParser: parser, env: providerEnv("mock") });

    expect(result.type).toBe("PLAN_CHANGE");
    if (result.type === "PLAN_CHANGE") expect(result.intent.rawText).toBe("明早送孩子上学");
  });

  it("首轮需要澄清时返回可继续补充的部分意图", async () => {
    const partial = currentIntent();
    partial.stops = [];
    partial.issues = ["没有识别到目的地，请补充。"];
    const parser: IntentParser = { async parse() { return partial; } };

    const result = await executeConversationTurn(request({
      currentIntent: null,
      pendingIntent: null,
      planFacts: null,
      text: "明天九点出发",
    }), { intentParser: parser, env: providerEnv("mock") });

    expect(result).toMatchObject({
      type: "CLARIFY",
      reason: "MISSING_CONTEXT",
      intent: { stops: [], issues: ["没有识别到目的地，请补充。"] },
    });
  });

  it("规则模式支持明确时间修改，且不改变旧意图对象", async () => {
    const original = currentIntent();
    const result = await executeConversationTurn(request({ currentIntent: original }), {
      env: providerEnv("mock"),
    });

    expect(result.type).toBe("PLAN_CHANGE");
    if (result.type === "PLAN_CHANGE") {
      expect(result.intent.timeConstraint).toEqual({
        type: "DEPART_AT",
        time: "09:00",
        targetStopIndex: 0,
        inferred: false,
      });
    }
    expect(original.timeConstraint).toMatchObject({ type: "ARRIVE_BY", time: "08:00" });
  });

  it("规则模式只用计划事实回答里程和电量", async () => {
    const result = await executeConversationTurn(request({ text: "全程多远，到公司还剩多少电？" }), {
      env: providerEnv("mock"),
    });

    expect(result).toMatchObject({ type: "ANSWER", meta: { provider: "rules" } });
    expect(result.text).toContain("18.6 公里");
    expect(result.text).toContain("36.8%");
  });

  it("规则模式支持日期修改以及常见出发、到达问答", async () => {
    const changed = await executeConversationTurn(request({
      text: "改到后天",
      now: "2026-07-17T06:00:00.000Z",
    }), { env: providerEnv("mock") });
    expect(changed.type).toBe("PLAN_CHANGE");
    if (changed.type === "PLAN_CHANGE") expect(changed.intent.date).toBe("2026-07-19");

    const answered = await executeConversationTurn(request({
      text: "几点出发，什么时候到公司？",
    }), { env: providerEnv("mock") });
    expect(answered.type).toBe("ANSWER");
    expect(answered.text).toContain("07:20");
    expect(answered.text).toContain("08:40 到我的公司");
  });

  it("实时天气问题要求先刷新，同一 turn 刷新后再回答", async () => {
    const first = await executeConversationTurn(request({ text: "现在最新天气怎么样？" }), {
      env: providerEnv("mock"),
    });
    expect(first).toMatchObject({
      type: "REFRESH_REQUIRED",
      refresh: { route: false, weather: true },
    });

    const second = await executeConversationTurn(request({
      text: "现在最新天气怎么样？",
      planFreshness: {
        status: "FRESH",
        updatedAt: "2026-07-17T06:01:00.000Z",
        refreshedForTurnId: "turn-2",
      },
    }), { env: providerEnv("mock") });
    expect(second.type).toBe("ANSWER");
    expect(second.text).toContain("小雨");
  });

  it("MiniMax 上下文不包含坐标，并重试含虚构数字的回答", async () => {
    const client = new ScriptedClient([
      JSON.stringify({ type: "ANSWER", text: "全程 99 公里。" }),
      JSON.stringify({ type: "ANSWER", text: "全程约 18.6 公里。" }),
    ]);
    const result = await executeConversationTurn(request({ text: "全程多少公里？" }), {
      client,
      env: providerEnv("minimax"),
    });

    expect(result).toMatchObject({ type: "ANSWER", meta: { provider: "minimax", fallback: false } });
    expect(result.text).toContain("18.6");
    expect(client.requests).toHaveLength(2);
    const modelInput = client.requests.map((item) => JSON.stringify(item.messages)).join("\n");
    expect(modelInput).not.toContain('"lng"');
    expect(modelInput).not.toContain('"lat"');
    expect(modelInput).not.toContain("polyline");
    expect(client.requests[0].messages[0].content).toContain("# NOMI 多轮行程对话规范");
    expect(client.requests[0].temperature).toBe(0.3);
  });

  it("MiniMax 使用固定客服开场时重写为自然的本轮回答", async () => {
    const client = new ScriptedClient([
      JSON.stringify({ type: "ANSWER", text: "先确认你最关心的问题：我的公司预计 08:40 到。" }),
      JSON.stringify({ type: "ANSWER", text: "好，照现在这条路线，08:40 能到我的公司。" }),
    ]);

    const result = await executeConversationTurn(request({ text: "我几点能到公司？" }), {
      client,
      env: providerEnv("minimax"),
    });

    expect(result).toMatchObject({
      type: "ANSWER",
      text: "好，照现在这条路线，08:40 能到我的公司。",
    });
    expect(client.requests).toHaveLength(2);
  });

  it("规则降级询问公司时只回答公司，不机械罗列所有站点", async () => {
    const result = await executeConversationTurn(request({ text: "我几点能到公司？" }), {
      env: providerEnv("mock"),
    });

    expect(result).toMatchObject({ type: "ANSWER", meta: { provider: "rules" } });
    expect(result.text).toContain("08:40 到我的公司");
    expect(result.text).not.toContain("08:00 到儿子学校");
  });

  it("MiniMax 不可用时只对安全规则范围降级，复杂地点修改不改变计划", async () => {
    const client: MiniMaxCompletionClient = {
      model: "MiniMax-Test",
      async complete() {
        throw new Error("offline");
      },
    };
    const result = await executeConversationTurn(request({ text: "把学校换成虹桥火车站" }), {
      client,
      env: providerEnv("minimax"),
    });

    expect(result).toMatchObject({
      type: "CLARIFY",
      reason: "UNSUPPORTED",
      meta: { provider: "rules", fallback: true },
    });
    expect(result.text).toContain("MiniMax 暂时不可用");
    expect(result.text).toContain("当前成功路线保持不变");
  });
});

describe("ConversationTurnRequestSchema", () => {
  it("限制最近消息为 20 条且合计不超过 12000 字符", () => {
    const tooMany = request({
      history: Array.from({ length: 21 }, () => ({ role: "user" as const, content: "hello" })),
    });
    const tooLong = request({
      history: Array.from({ length: 4 }, () => ({ role: "assistant" as const, content: "x".repeat(3_100) })),
    });

    expect(ConversationTurnRequestSchema.safeParse(tooMany).success).toBe(false);
    expect(ConversationTurnRequestSchema.safeParse(tooLong).success).toBe(false);
  });
});

describe("validateGroundedAnswer", () => {
  it("保留温度正负号，拒绝把负温回答成正温", () => {
    const facts = planFacts();
    facts.weather.temperatureC = -5;

    expect(() => validateGroundedAnswer("计划温度是 -5°C。", "天气怎么样？", facts)).not.toThrow();
    expect(() => validateGroundedAnswer("计划温度是 5°C。", "天气怎么样？", facts)).toThrow(
      "不存在的带单位数字 5°C",
    );
  });

  it("按完整时钟校验，拒绝重排已有的小时和分钟", () => {
    const facts = planFacts();

    expect(() => validateGroundedAnswer("计划 07:20 出发。", "几点出发？", facts)).not.toThrow();
    expect(() => validateGroundedAnswer("计划 20:07 出发。", "几点出发？", facts)).toThrow(
      "不存在的时间 20:07",
    );
  });
});
