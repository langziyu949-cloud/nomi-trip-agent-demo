import { describe, expect, it } from "vitest";

import { DEFAULT_PLACES, favoriteDraft } from "@/lib/default-places";
import { buildTripPlan } from "@/lib/planner";
import type { RouteLeg, TripIntentDraft, WeatherContext } from "@/lib/types";

function makeLeg(
  from: keyof typeof DEFAULT_PLACES,
  to: keyof typeof DEFAULT_PLACES,
  durationSec: number,
  distanceM: number,
): RouteLeg {
  return {
    from: DEFAULT_PLACES[from],
    to: DEFAULT_PLACES[to],
    durationSec,
    distanceM,
    polyline: [DEFAULT_PLACES[from].location, DEFAULT_PLACES[to].location],
    steps: [],
  };
}

function makeIntent(type: "ARRIVE_BY" | "DEPART_AT" = "ARRIVE_BY"): TripIntentDraft {
  return {
    rawText: "测试行程",
    date: "2026-07-15",
    city: "上海市",
    origin: favoriteDraft("home"),
    stops: [favoriteDraft("school"), favoriteDraft("company")],
    timeConstraint: { type, time: "08:00", targetStopIndex: 0, inferred: false },
    preferences: ["precondition_vehicle"],
    confidence: 1,
    issues: [],
  };
}

const normalWeather: WeatherContext = {
  available: true,
  condition: "晴",
  temperatureC: 24,
  humidity: 50,
  reportTime: "2026-07-14T08:00:00+08:00",
  source: "forecast",
};

describe("buildTripPlan", () => {
  const legs = [
    makeLeg("home", "school", 20 * 60, 8_000),
    makeLeg("school", "company", 30 * 60, 20_000),
  ];

  it("按时到达会反推出包含缓冲的出发时间", () => {
    const plan = buildTripPlan(makeIntent("ARRIVE_BY"), legs, normalWeather);
    expect(plan.departureTime).toBe("07:35");
    expect(plan.stops[0].eta).toBe("07:55");
    expect(plan.stops[1].eta).toBe("08:30");
    expect(plan.planningBufferSec).toBe(5 * 60);
  });

  it("按时到达可以约束中间或后续站点", () => {
    const intent = makeIntent("ARRIVE_BY");
    intent.timeConstraint.targetStopIndex = 1;
    const plan = buildTripPlan(intent, legs, normalWeather);

    expect(plan.departureTime).toBe("07:00");
    expect(plan.stops[0].eta).toBe("07:20");
    expect(plan.stops[1].eta).toBe("07:55");
  });

  it("多个到达约束会倒推出途经点的最晚出发时间", () => {
    const intent = makeIntent("ARRIVE_BY");
    intent.timeConstraints = [
      { type: "ARRIVE_BY", time: "10:00", targetStopIndex: 0, inferred: false },
      { type: "ARRIVE_BY", time: "12:00", targetStopIndex: 1, inferred: false },
    ];
    intent.timeConstraint = intent.timeConstraints[1];

    const plan = buildTripPlan(intent, legs, normalWeather);

    expect(plan.departureTime).toBe("09:35");
    expect(plan.stops[0]).toMatchObject({ eta: "09:55", departureTime: "11:25", dwellSec: 90 * 60 });
    expect(plan.stops[1]).toMatchObject({ eta: "11:55", departureTime: null });
    expect(plan.totalDurationSec).toBe(140 * 60);
  });

  it("准时出发会从用户指定时间顺推 ETA", () => {
    const plan = buildTripPlan(makeIntent("DEPART_AT"), legs, normalWeather);
    expect(plan.departureTime).toBe("08:00");
    expect(plan.stops[0].eta).toBe("08:20");
    expect(plan.stops[1].eta).toBe("08:55");
  });

  it("低温雨雪会生成预热、座椅和除雾提醒", () => {
    const plan = buildTripPlan(makeIntent(), legs, {
      ...normalWeather,
      condition: "小雪",
      temperatureC: -5,
    });
    const types = plan.actions.map((item) => item.type);
    expect(types).toEqual(expect.arrayContaining(["PREHEAT", "SEAT_HEAT", "DEFOG", "UMBRELLA"]));
  });

  it("演示场景使用座舱温度触发预热，不覆盖高德室外温度", () => {
    const plan = buildTripPlan(makeIntent(), legs, normalWeather, {
      enabled: true,
      condition: "小雪",
      batteryPercent: 42,
      cabinTemperatureC: -5,
    });
    expect(plan.weather.temperatureC).toBe(24);
    expect(plan.actions.some((item) => item.type === "PREHEAT")).toBe(true);
    expect(plan.actions.find((item) => item.type === "PREHEAT")?.detail).toContain("当前座舱 -5°C");
  });

  it("炎热座舱触发制冷，关闭主动备车时不触发温控动作", () => {
    const hotPlan = buildTripPlan(makeIntent(), legs, normalWeather, {
      enabled: true,
      condition: "晴",
      batteryPercent: 42,
      cabinTemperatureC: 35,
    });
    expect(hotPlan.actions.some((item) => item.type === "PRECOOL")).toBe(true);

    const disabledIntent = makeIntent();
    disabledIntent.preferences = [];
    const disabledPlan = buildTripPlan(disabledIntent, legs, normalWeather, {
      enabled: true,
      condition: "晴",
      batteryPercent: 42,
      cabinTemperatureC: -5,
    });
    expect(disabledPlan.actions.some((item) => ["PREHEAT", "PRECOOL", "SEAT_HEAT"].includes(item.type))).toBe(false);
  });

  it("预计到达电量低于 10% 时给出高风险提醒", () => {
    const longLegs = [
      makeLeg("home", "school", 60 * 60, 100_000),
      makeLeg("school", "company", 30 * 60, 40_000),
    ];
    const plan = buildTripPlan(makeIntent(), longLegs, normalWeather, {
      enabled: true,
      condition: "晴",
      batteryPercent: 25,
      cabinTemperatureC: 5,
    });
    expect(plan.vehicle.estimatedArrivalBattery).toBeLessThan(10);
    expect(plan.actions.some((item) => item.type === "ENERGY_CRITICAL")).toBe(true);
  });
});
