import { describe, expect, it } from "vitest";

import { MiniMaxIntentParser } from "@/lib/ai/minimax-intent-parser";
import type { MiniMaxCompletionClient, MiniMaxCompletionRequest } from "@/lib/ai/minimax-client";

class ScriptedClient implements MiniMaxCompletionClient {
  readonly model = "MiniMax-Test";
  readonly requests: MiniMaxCompletionRequest[] = [];

  constructor(private readonly outputs: string[]) {}

  async complete(request: MiniMaxCompletionRequest): Promise<string> {
    this.requests.push(request);
    return this.outputs[Math.min(this.requests.length - 1, this.outputs.length - 1)];
  }
}

function intentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    date: "2026-07-15",
    city: "上海市",
    origin: { kind: "FAVORITE_OR_QUERY", favoriteKey: "home", query: null },
    stops: [
      { kind: "FAVORITE_OR_QUERY", favoriteKey: "school", query: null },
      { kind: "FAVORITE_OR_QUERY", favoriteKey: "company", query: null },
    ],
    timeConstraint: { type: "ARRIVE_BY", time: "08:00", targetStopIndex: 0, inferred: false },
    preferences: ["precondition_vehicle"],
    confidence: 0.96,
    issues: [],
    ...overrides,
  });
}

describe("MiniMaxIntentParser", () => {
  it("将模型语义字段适配为现有 TripIntentDraft", async () => {
    const client = new ScriptedClient([intentJson()]);
    const parser = new MiniMaxIntentParser(client);
    const intent = await parser.parse(
      "明早 8 点送孩子到学校，然后去公司，提前准备一下。",
      new Date("2026-07-14T02:00:00.000Z"),
    );

    expect(intent.timeConstraint).toEqual({
      type: "ARRIVE_BY",
      time: "08:00",
      targetStopIndex: 0,
      inferred: false,
    });
    expect(intent.stops.map((stop) => stop.resolved?.name)).toEqual(["儿子学校", "我的公司"]);
    expect(intent.understanding).toEqual({ provider: "minimax", model: "MiniMax-Test", fallback: false });
    expect(client.requests[0].messages[0].content).toContain("# NOMI 行程理解规范");
    expect(client.requests[0].temperature).toBe(0);
  });

  it("自定义地点保持未解析，不接受模型坐标", async () => {
    const invalidWithCoordinates = intentJson({
      stops: [{
        kind: "FAVORITE_OR_QUERY",
        favoriteKey: null,
        query: "虹桥火车站",
        location: { lng: 121.3, lat: 31.2 },
      }],
      timeConstraint: { type: "DEPART_AT", time: "07:30", targetStopIndex: 0, inferred: false },
    });
    const repaired = intentJson({
      stops: [{ kind: "FAVORITE_OR_QUERY", favoriteKey: null, query: "虹桥火车站" }],
      timeConstraint: { type: "DEPART_AT", time: "07:30", targetStopIndex: 0, inferred: false },
    });
    const client = new ScriptedClient([invalidWithCoordinates, repaired]);
    const intent = await new MiniMaxIntentParser(client).parse("明早 7:30 从家出发去虹桥火车站");

    expect(client.requests).toHaveLength(2);
    expect(intent.stops[0]).toMatchObject({ query: "虹桥火车站", resolved: null });
  });

  it("兼容模型对地点 kind 的常见简写", async () => {
    const output = intentJson().replaceAll("FAVORITE_OR_QUERY", "FAVORITE");
    const intent = await new MiniMaxIntentParser(new ScriptedClient([output])).parse(
      "明早 8 点送孩子到学校，然后去公司",
    );

    expect(intent.origin.resolved?.name).toBe("家");
    expect(intent.stops.map((stop) => stop.resolved?.name)).toEqual(["儿子学校", "我的公司"]);
  });

  it("剥离思考块并从连续 JSON 中选择最后一个有效行程", async () => {
    const stale = intentJson({
      stops: [{ kind: "FAVORITE_OR_QUERY", favoriteKey: "company", query: null }],
    });
    const finalAnswer = intentJson({
      stops: [
        { kind: "FAVORITE_OR_QUERY", favoriteKey: "school", query: null },
        { kind: "FAVORITE_OR_QUERY", favoriteKey: "wifeCompany", query: null },
        { kind: "FAVORITE_OR_QUERY", favoriteKey: "company", query: null },
      ],
      timeConstraint: { type: "ARRIVE_BY", time: "08:00", targetStopIndex: 0, inferred: false },
      preferences: [],
    });
    const output = `<think>${stale}</think>\n${stale}\n${finalAnswer}`;
    const client = new ScriptedClient([output]);
    const intent = await new MiniMaxIntentParser(client).parse(
      "明天早上从家出发，先去送我儿子上学，八点之前到，然后送我老婆上班，最后去我公司",
    );

    expect(client.requests).toHaveLength(1);
    expect(intent.stops.map((stop) => stop.key)).toEqual(["school", "wifeCompany", "company"]);
    expect(intent.timeConstraint).toMatchObject({ type: "ARRIVE_BY", time: "08:00", targetStopIndex: 0 });
  });

  it("只把明确时间绑定到相关站点，不追问其他途经点的独立时间", async () => {
    const client = new ScriptedClient([intentJson({
      stops: [
        { kind: "FAVORITE_OR_QUERY", favoriteKey: "school", query: null },
        { kind: "FAVORITE_OR_QUERY", favoriteKey: "wifeCompany", query: null },
        { kind: "FAVORITE_OR_QUERY", favoriteKey: "company", query: null },
      ],
      timeConstraint: { type: "ARRIVE_BY", time: "08:00", targetStopIndex: 1, inferred: false },
      issues: ["送儿子上学的具体时间未明确，请确认是几点送到学校？"],
    })]);

    const intent = await new MiniMaxIntentParser(client).parse(
      "明天先去送我儿子上学，然后送我老婆8点上班，最后去我公司",
      new Date("2026-07-14T02:00:00.000Z"),
    );

    expect(intent.issues).toEqual([]);
    expect(intent.timeConstraint).toEqual({
      type: "ARRIVE_BY",
      time: "08:00",
      targetStopIndex: 1,
      inferred: false,
    });
  });

  it("没有时间时使用可编辑的非阻断默认出发时间", async () => {
    const client = new ScriptedClient([intentJson({
      timeConstraint: { type: "ARRIVE_BY", time: "08:00", targetStopIndex: 0, inferred: true },
      issues: ["没有说明几点出发，请确认时间。"],
    })]);

    const intent = await new MiniMaxIntentParser(client).parse(
      "明天送儿子上学，然后去公司",
      new Date("2026-07-14T02:00:00.000Z"),
    );

    expect(intent.issues).toEqual([]);
    expect(intent.timeConstraint).toEqual({
      type: "DEPART_AT",
      time: "09:00",
      targetStopIndex: 0,
      inferred: true,
    });
  });

  it("保留多个明确时间并分别绑定对应站点", async () => {
    const client = new ScriptedClient([intentJson({
      stops: [
        { kind: "QUERY", favoriteKey: null, query: "东方明珠" },
        { kind: "FAVORITE", favoriteKey: "school", query: null },
      ],
      timeConstraints: [
        { type: "ARRIVE_BY", time: "10:00", targetStopIndex: 0, inferred: false },
        { type: "ARRIVE_BY", time: "12:00", targetStopIndex: 1, inferred: false },
      ],
      issues: [],
    })]);

    const intent = await new MiniMaxIntentParser(client).parse(
      "明天早上从家出发，先赶在10点前到东方明珠，然后12点去接儿子放学",
      new Date("2026-07-14T02:00:00.000Z"),
    );

    expect(intent.timeConstraints).toEqual([
      { type: "ARRIVE_BY", time: "10:00", targetStopIndex: 0, inferred: false },
      { type: "ARRIVE_BY", time: "12:00", targetStopIndex: 1, inferred: false },
    ]);
    expect(intent.timeConstraint).toEqual(intent.timeConstraints?.[1]);
  });

  it("模型漏掉接孩子站点时根据明确语义补齐，避免时间下标偶发越界", async () => {
    const client = new ScriptedClient([intentJson({
      stops: [{ kind: "FAVORITE", favoriteKey: "school", query: null }],
      timeConstraints: [
        { type: "ARRIVE_BY", time: "10:00", targetStopIndex: 0, inferred: false },
        { type: "ARRIVE_BY", time: "12:00", targetStopIndex: 1, inferred: false },
      ],
      issues: [],
    })]);

    const intent = await new MiniMaxIntentParser(client).parse(
      "明天早上我要10点之前到东方明珠，然后12点去接儿子放学",
      new Date("2026-07-15T02:00:00.000Z"),
    );

    expect(client.requests).toHaveLength(1);
    expect(intent.stops.map((stop) => stop.key)).toEqual(["custom-0-东方明珠", "school"]);
    expect(intent.timeConstraints?.[1].targetStopIndex).toBe(1);
  });

  it("兼容模型偶发使用从一开始的站点下标", async () => {
    const client = new ScriptedClient([intentJson({
      stops: [
        { kind: "QUERY", favoriteKey: null, query: "东方明珠" },
        { kind: "FAVORITE", favoriteKey: "school", query: null },
      ],
      timeConstraints: [
        { type: "ARRIVE_BY", time: "10:00", targetStopIndex: 1, inferred: false },
        { type: "ARRIVE_BY", time: "12:00", targetStopIndex: 2, inferred: false },
      ],
      issues: [],
    })]);

    const intent = await new MiniMaxIntentParser(client).parse(
      "明天早上我要10点之前到东方明珠，然后12点去接儿子放学",
    );

    expect(intent.timeConstraints?.map((constraint) => constraint.targetStopIndex)).toEqual([0, 1]);
  });

  it("移除目的地列表开头重复的起点并同步时间下标", async () => {
    const client = new ScriptedClient([intentJson({
      stops: [
        { kind: "FAVORITE", favoriteKey: "home", query: null },
        { kind: "QUERY", favoriteKey: null, query: "东方明珠" },
        { kind: "FAVORITE", favoriteKey: "school", query: null },
      ],
      timeConstraints: [
        { type: "ARRIVE_BY", time: "10:00", targetStopIndex: 1, inferred: false },
        { type: "ARRIVE_BY", time: "12:00", targetStopIndex: 2, inferred: false },
      ],
      issues: [],
    })]);

    const intent = await new MiniMaxIntentParser(client).parse(
      "明天早上我要10点之前到东方明珠，然后12点去接儿子放学",
    );

    expect(intent.stops.map((stop) => stop.key)).toEqual(["custom-0-东方明珠", "school"]);
    expect(intent.timeConstraints?.map((constraint) => constraint.targetStopIndex)).toEqual([0, 1]);
  });

  it("连续两次无效 JSON 后返回明确模型错误", async () => {
    const parser = new MiniMaxIntentParser(new ScriptedClient(["not json", "still not json"]));
    await expect(parser.parse("明天出发"))
      .rejects.toMatchObject({ code: "MINIMAX_INVALID_INTENT", retryable: true });
  });
});
