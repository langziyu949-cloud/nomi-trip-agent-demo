import { describe, expect, it } from "vitest";

import { MiniMaxTripNarrator } from "@/lib/ai/minimax-trip-narrator";
import type { MiniMaxCompletionClient, MiniMaxCompletionRequest } from "@/lib/ai/minimax-client";
import { buildTemplateNarration } from "@/lib/ai/trip-narrator";
import { DEFAULT_PLACES, favoriteDraft } from "@/lib/default-places";
import type { TripPlan } from "@/lib/types";

class CapturingClient implements MiniMaxCompletionClient {
  readonly model = "MiniMax-Test";
  request: MiniMaxCompletionRequest | null = null;
  requests: MiniMaxCompletionRequest[] = [];

  constructor(private readonly output: string | string[]) {}

  async complete(request: MiniMaxCompletionRequest): Promise<string> {
    this.request = request;
    this.requests.push(request);
    return Array.isArray(this.output)
      ? this.output[Math.min(this.requests.length - 1, this.output.length - 1)]
      : this.output;
  }
}

function makePlan(): TripPlan {
  return {
    id: "trip-test",
    createdAt: "2026-07-14T02:00:00.000Z",
    intent: {
      rawText: "测试",
      date: "2026-07-15",
      city: "上海市",
      origin: favoriteDraft("home"),
      stops: [favoriteDraft("school")],
      timeConstraint: { type: "ARRIVE_BY", time: "08:00", targetStopIndex: 0, inferred: false },
      preferences: ["precondition_vehicle"],
      confidence: 1,
      issues: [],
    },
    departureAt: "2026-07-14T23:35:00.000Z",
    departureTime: "07:35",
    totalDistanceM: 8_000,
    totalDurationSec: 1_200,
    planningBufferSec: 300,
    legs: [{
      from: DEFAULT_PLACES.home,
      to: DEFAULT_PLACES.school,
      distanceM: 8_000,
      durationSec: 1_200,
      polyline: [DEFAULT_PLACES.home.location, DEFAULT_PLACES.school.location],
      steps: [],
    }],
    stops: [{ place: DEFAULT_PLACES.school, eta: "07:55", dateTime: "2026-07-14T23:55:00.000Z" }],
    weather: { available: true, condition: "小雪", temperatureC: 8, humidity: 60, reportTime: null, source: "forecast" },
    vehicle: { batteryPercent: 42, estimatedArrivalBattery: 38.9, cabinTemperatureC: 8, consumptionKwhPer100Km: 23, batteryCapacityKwh: 100, source: "mock" },
    actions: [{ id: "preheat", type: "PREHEAT", title: "提前温暖座舱", detail: "建议提前 15 分钟开启暖风。", scheduledAt: "2026-07-14T23:20:00.000Z", severity: "suggestion" }],
    notes: [],
  };
}

describe("MiniMaxTripNarrator", () => {
  it("只向模型发送总结所需事实，不发送坐标或路线折线", async () => {
    const client = new CapturingClient("计划好了，建议 07:35 从家出发，预计 07:55 到达儿子学校；小雪天气，我会提前温暖座舱，路上更从容。");
    const result = await new MiniMaxTripNarrator(client).narrate(makePlan());
    const prompt = client.request?.messages.at(-1)?.content ?? "";

    expect(result.provider).toBe("minimax");
    expect(prompt).not.toContain("lng");
    expect(prompt).not.toContain("polyline");
    expect(prompt).not.toContain("121.43838");
    expect(client.request?.messages[0].content).toContain("# NOMI 行程回答规范");
    expect(client.request?.temperature).toBe(0.1);
  });

  it("拒绝缺少关键时间或含有新数字的总结", async () => {
    const client = new CapturingClient("建议 09:00 出发，我已经为你安排好了全部行程。 ");
    await expect(new MiniMaxTripNarrator(client).narrate(makePlan()))
      .rejects.toMatchObject({ code: "MINIMAX_INVALID_NARRATION" });
  });

  it("将自然时间格式归一为计划中的 HH:mm", async () => {
    const client = new CapturingClient("计划好了，建议 7点35分 从家出发，预计 7:55 到达儿子学校；小雪天气，我会提前温暖座舱。 ");
    const result = await new MiniMaxTripNarrator(client).narrate(makePlan());
    expect(result.text).toContain("07:35");
    expect(result.text).toContain("07:55");
  });

  it("首次总结过短时自动修复一次", async () => {
    const client = new CapturingClient([
      "07:35 出发，07:55 到达。",
      "计划好了，建议 07:35 从家出发，预计 07:55 到达儿子学校；小雪天气，我会提前温暖座舱，路上更从容。",
    ]);
    const result = await new MiniMaxTripNarrator(client).narrate(makePlan());
    expect(client.requests).toHaveLength(2);
    expect(result).toMatchObject({ provider: "minimax", fallback: false });
  });

  it("剥离推理模型混入 content 的思考块", async () => {
    const client = new CapturingClient("<think>这里是不能展示给用户的长推理过程，包含对字段的逐项检查。</think>计划好了，建议 07:35 从家出发，预计 07:55 到达儿子学校；小雪天气，我会提前温暖座舱。 ");
    const result = await new MiniMaxTripNarrator(client).narrate(makePlan());
    expect(result.text).not.toContain("think");
    expect(result.text).not.toContain("推理过程");
    expect(result).toMatchObject({ provider: "minimax", fallback: false });
  });

  it("模板兜底仍包含规则计算的出发和首站到达时间", () => {
    const narration = buildTemplateNarration(makePlan(), { fallback: true, errorCode: "MINIMAX_TIMEOUT" });
    expect(narration.text).toContain("07:35");
    expect(narration.text).toContain("07:55");
    expect(narration).toMatchObject({ provider: "template", fallback: true, errorCode: "MINIMAX_TIMEOUT" });
  });

  it("长时间停留时模板会说明途经点最晚出发时间", () => {
    const plan = makePlan();
    plan.intent.stops.push(favoriteDraft("company"));
    plan.stops = [
      {
        place: DEFAULT_PLACES.school,
        eta: "09:55",
        dateTime: "2026-07-15T01:55:00.000Z",
        departureTime: "11:25",
        departureDateTime: "2026-07-15T03:25:00.000Z",
        dwellSec: 90 * 60,
      },
      {
        place: DEFAULT_PLACES.company,
        eta: "11:55",
        dateTime: "2026-07-15T03:55:00.000Z",
        departureTime: null,
        departureDateTime: null,
        dwellSec: 0,
      },
    ];

    const narration = buildTemplateNarration(plan);
    expect(narration.text).toContain("最晚 11:25");
    expect(narration.text).toContain("11:55 到我的公司");
  });

  it("微信模板简洁覆盖关键时间、全部准备和人工提醒，并区分座舱与室外温度", () => {
    const plan = makePlan();
    plan.weather = {
      ...plan.weather,
      condition: "小雨",
      temperatureC: 37,
      source: "override",
    };
    plan.vehicle.cabinTemperatureC = 8;
    plan.stops = [
      {
        place: DEFAULT_PLACES.company,
        eta: "09:55",
        dateTime: "2026-07-15T01:55:00.000Z",
        departureTime: "11:12",
        departureDateTime: "2026-07-15T03:12:00.000Z",
        dwellSec: 77 * 60,
      },
      {
        place: DEFAULT_PLACES.school,
        eta: "11:55",
        dateTime: "2026-07-15T03:55:00.000Z",
        departureTime: null,
        departureDateTime: null,
        dwellSec: 0,
      },
    ];
    plan.actions = [
      { id: "preheat", type: "PREHEAT", title: "提前温暖座舱", detail: "当前座舱 8°C，将在出发前开启暖风。", scheduledAt: null, severity: "suggestion" },
      { id: "seat", type: "SEAT_HEAT", title: "开启座椅加热", detail: "将在出发前开启。", scheduledAt: null, severity: "info" },
      { id: "defog", type: "DEFOG", title: "准备除雾", detail: "将在出发前开启前挡除雾。", scheduledAt: null, severity: "suggestion" },
      { id: "umbrella", type: "UMBRELLA", title: "别忘了雨具", detail: "已加入雨具提醒。", scheduledAt: null, severity: "info" },
      { id: "buffer", type: "LEAVE_BUFFER", title: "预留路况缓冲", detail: "增加 5 分钟缓冲。", scheduledAt: null, severity: "info" },
    ];

    const text = buildTemplateNarration(plan).text;
    expect(text).toContain("11:12");
    expect(text).toContain("11:55");
    expect(text).toContain("当前座舱 8°C");
    expect(text).toContain("我会提前温暖座舱、开启座椅加热、准备除雾");
    expect(text).toContain("小雨，记得带雨具");
    expect(text).toContain("5 分钟路况缓冲");
    expect(text).not.toContain("37°C");
    expect(text).not.toContain("建议提前温暖座舱");
    expect(text.length).toBeLessThanOrEqual(180);
  });
});
