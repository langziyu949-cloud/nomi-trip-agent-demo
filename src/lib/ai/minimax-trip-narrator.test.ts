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
  const firstStop = favoriteDraft("school");
  firstStop.label = "第一站";
  firstStop.query = "第一站";
  return {
    id: "trip-test",
    createdAt: "2026-07-14T02:00:00.000Z",
    intent: {
      rawText: "明天需要八点前到达第一站，请帮我安排路线",
      date: "2026-07-15",
      city: "上海市",
      origin: favoriteDraft("home"),
      stops: [firstStop],
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

function makeMixedConstraintPlan(): TripPlan {
  const plan = makePlan();
  const secondStop = favoriteDraft("company");
  secondStop.label = "第二站";
  secondStop.query = "第二站";
  const firstConstraint = { type: "ARRIVE_BY" as const, time: "08:00", targetStopIndex: 0, inferred: false };
  const secondConstraint = { type: "ARRIVE_BY" as const, time: "08:30", targetStopIndex: 1, inferred: false };
  plan.intent.stops.push(secondStop);
  plan.intent.timeConstraints = [firstConstraint, secondConstraint];
  plan.intent.timeConstraint = secondConstraint;
  plan.stops.push({
    place: DEFAULT_PLACES.company,
    eta: "09:00",
    dateTime: "2026-07-15T01:00:00.000Z",
  });
  return plan;
}

describe("MiniMaxTripNarrator", () => {
  it("只向模型发送总结所需事实，不发送坐标或路线折线", async () => {
    const client = new CapturingClient("可以，第一站预计 07:55 到达，满足 08:00 前到达的要求。建议 07:35 从家出发；小雪天气，我会提前温暖座舱，路上更从容。");
    const result = await new MiniMaxTripNarrator(client).narrate(makePlan(), {
      userText: "明天需要八点前到达第一站，请帮我安排路线",
    });
    const prompt = client.request?.messages.at(-1)?.content ?? "";

    expect(result.provider).toBe("minimax");
    expect(prompt).not.toContain("lng");
    expect(prompt).not.toContain("polyline");
    expect(prompt).not.toContain("121.43838");
    expect(prompt).toContain("明天需要八点前到达第一站");
    expect(prompt).toContain('"time":"08:00"');
    expect(prompt).toContain('"satisfied":true');
    expect(prompt).toContain('"mode":"initial"');
    expect(client.request?.messages[0].content).toContain("# NOMI 行程回答规范");
    expect(client.request?.temperature).toBe(0.45);
  });

  it("拒绝缺少关键时间或含有新数字的总结", async () => {
    const client = new CapturingClient("建议 09:00 出发，我已经为你安排好了全部行程。 ");
    await expect(new MiniMaxTripNarrator(client).narrate(makePlan()))
      .rejects.toMatchObject({ code: "MINIMAX_INVALID_NARRATION" });
  });

  it("将自然时间格式归一为计划中的 HH:mm", async () => {
    const client = new CapturingClient("可以，第一站预计 7:55 到达，满足 8点00分 前到达的要求。建议 7点35分 从家出发；小雪天气，我会提前温暖座舱。 ");
    const result = await new MiniMaxTripNarrator(client).narrate(makePlan());
    expect(result.text).toContain("07:35");
    expect(result.text).toContain("07:55");
  });

  it("首次总结过短时自动修复一次", async () => {
    const client = new CapturingClient([
      "07:35 出发，07:55 到达。",
      "可以，第一站预计 07:55 到达，满足 08:00 前到达的要求。建议 07:35 从家出发；小雪天气，我会提前温暖座舱，路上更从容。",
    ]);
    const result = await new MiniMaxTripNarrator(client).narrate(makePlan());
    expect(client.requests).toHaveLength(2);
    expect(result).toMatchObject({ provider: "minimax", fallback: false });
  });

  it("固定使用『先确认你最关心的时间』时自动修复为自然表达", async () => {
    const client = new CapturingClient([
      "先确认你最关心的时间：第一站预计 07:55 到达，可以满足 08:00 前到达的要求。建议 07:35 从家出发；小雪天气，我会提前温暖座舱。",
      "放心，第一站预计 07:55 到达，08:00 前来得及。建议 07:35 从家出发；小雪天气，出发前我会提前温暖座舱。",
    ]);

    const result = await new MiniMaxTripNarrator(client).narrate(makePlan());

    expect(client.requests).toHaveLength(2);
    expect(result.text).toMatch(/^放心，第一站预计 07:55 到达/);
    expect(result.text).not.toContain("先确认你最关心的时间");
  });

  it("剥离推理模型混入 content 的思考块", async () => {
    const client = new CapturingClient("<think>这里是不能展示给用户的长推理过程，包含对字段的逐项检查。</think>可以，第一站预计 07:55 到达，满足 08:00 前到达的要求。建议 07:35 从家出发；小雪天气，我会提前温暖座舱。 ");
    const result = await new MiniMaxTripNarrator(client).narrate(makePlan());
    expect(result.text).not.toContain("think");
    expect(result.text).not.toContain("推理过程");
    expect(result).toMatchObject({ provider: "minimax", fallback: false });
  });

  it("模板兜底仍包含规则计算的出发和首站到达时间", () => {
    const narration = buildTemplateNarration(makePlan(), { fallback: true, errorCode: "MINIMAX_TIMEOUT" });
    expect(narration.text).toContain("07:35");
    expect(narration.text).toContain("07:55");
    expect(narration.text).toContain("赶在 08:00 前");
    expect(narration).toMatchObject({ provider: "template", fallback: true, errorCode: "MINIMAX_TIMEOUT" });
  });

  it("拒绝只播报路线时间却不回应显式时间目标的总结", async () => {
    const client = new CapturingClient("建议 07:35 从家出发，预计 07:55 到达第一站；小雪天气，我会提前温暖座舱，路上更从容。");
    await expect(new MiniMaxTripNarrator(client).narrate(makePlan()))
      .rejects.toMatchObject({ code: "MINIMAX_INVALID_NARRATION" });
  });

  it("逐条接受一项满足、一项未满足的显式目标", async () => {
    const client = new CapturingClient("第一站预计 07:55 到达，可以满足 08:00 前到达的要求。第二站预计 09:00 到达，暂时无法满足 08:30 前到达的要求。建议 07:35 从家出发；小雪天气，我会提前温暖座舱。");

    const result = await new MiniMaxTripNarrator(client).narrate(makeMixedConstraintPlan());

    expect(result.text).toContain("第一站预计 07:55");
    expect(result.text).toContain("第二站预计 09:00");
    expect(result.fallback).toBe(false);
  });

  it("拒绝把多目标的满足与失败结论串线", async () => {
    const client = new CapturingClient("第一站预计 07:55 到达，暂时无法满足 08:00 前到达的要求。第二站预计 09:00 到达，可以满足 08:30 前到达的要求。建议 07:35 从家出发；小雪天气，我会提前温暖座舱。");

    await expect(new MiniMaxTripNarrator(client).narrate(makeMixedConstraintPlan()))
      .rejects.toMatchObject({ code: "MINIMAX_INVALID_NARRATION" });
  });

  it("后续追问公司到达时间时只需回答本轮重点，不重复旧目标和车控", async () => {
    const plan = makeMixedConstraintPlan();
    plan.intent.rawText = "老婆明天不用我送了，送完孩子直接去公司，我几点能到公司";
    const client = new CapturingClient("好，那送完孩子就直接去公司，我的公司预计 09:00 到。这一路 07:35 从家出发就合适。");

    const result = await new MiniMaxTripNarrator(client).narrate(plan, {
      mode: "update",
      userText: plan.intent.rawText,
    });

    expect(result.text).toContain("我的公司预计 09:00 到");
    expect(result.text).not.toContain("08:00");
    expect(result.text).not.toContain("暖舱");
    expect(client.request?.messages.at(-1)?.content).toContain('"kind":"stop_arrival"');
  });

  it("后续追问不能拿其他站的正确时间冒充目标站到达时间", async () => {
    const plan = makeMixedConstraintPlan();
    plan.intent.rawText = "送完孩子直接去公司，我几点能到公司";
    const client = new CapturingClient("好，第一站预计 07:55 到，07:35 从家出发就行。");

    await expect(new MiniMaxTripNarrator(client).narrate(plan, {
      mode: "update",
      userText: plan.intent.rawText,
    })).rejects.toMatchObject({ code: "MINIMAX_INVALID_NARRATION" });
  });

  it("后续追问的模板兜底也优先回答当前目标，不复述无关信息", () => {
    const plan = makeMixedConstraintPlan();
    plan.intent.rawText = "送完孩子直接去公司，我几点能到公司";

    const narration = buildTemplateNarration(plan, {
      fallback: true,
      context: { mode: "update", userText: plan.intent.rawText },
    });

    expect(narration.text).toContain("第二站预计 09:00 到");
    expect(narration.text).not.toContain("08:00");
    expect(narration.text).not.toContain("暖舱");
    expect(narration.text).not.toContain("先确认你最关心的时间");
  });

  it("不会把自动车控中的提前误认为时间目标已满足", async () => {
    const client = new CapturingClient("第一站预计 07:55 到达，要求是 08:00 前。建议 07:35 从家出发；小雪天气，我会提前温暖座舱。");

    await expect(new MiniMaxTripNarrator(client).narrate(makePlan()))
      .rejects.toMatchObject({ code: "MINIMAX_INVALID_NARRATION" });
  });

  it("不会把其他字段的正数误用为负数室外温度", async () => {
    const plan = makePlan();
    plan.weather.temperatureC = -8;
    plan.actions = [];
    const client = new CapturingClient("第一站预计 07:55 到达，可以满足 08:00 前到达的要求。建议 07:35 从家出发；室外 8°C，路上注意保暖。");

    await expect(new MiniMaxTripNarrator(client).narrate(plan))
      .rejects.toMatchObject({ code: "MINIMAX_INVALID_NARRATION" });
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

  it("微信模板简洁覆盖关键时间、全部准备和自定义天气提醒", () => {
    const plan = makePlan();
    plan.weather = {
      ...plan.weather,
      condition: "小雨",
      temperatureC: 8,
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
      { id: "preheat", type: "PREHEAT", title: "提前温暖座舱", detail: "自定义气温 8°C，将在出发前开启暖风。", scheduledAt: null, severity: "suggestion" },
      { id: "seat", type: "SEAT_HEAT", title: "开启座椅加热", detail: "将在出发前开启。", scheduledAt: null, severity: "info" },
      { id: "defog", type: "DEFOG", title: "准备除雾", detail: "将在出发前开启前挡除雾。", scheduledAt: null, severity: "suggestion" },
      { id: "umbrella", type: "UMBRELLA", title: "别忘了雨具", detail: "已加入雨具提醒。", scheduledAt: null, severity: "info" },
      { id: "buffer", type: "LEAVE_BUFFER", title: "预留路况缓冲", detail: "增加 5 分钟缓冲。", scheduledAt: null, severity: "info" },
    ];

    const text = buildTemplateNarration(plan).text;
    expect(text).toContain("11:12");
    expect(text).toContain("11:55");
    expect(text).toContain("自定义气温 8°C");
    expect(text).toContain("我会提前温暖座舱、开启座椅加热、准备除雾");
    expect(text).toContain("小雨，记得带雨具");
    expect(text).toContain("5 分钟路况缓冲");
    expect(text).not.toContain("建议提前温暖座舱");
    expect(text.length).toBeLessThanOrEqual(180);
  });
});
