import { MiniMaxError, type MiniMaxCompletionClient } from "@/lib/ai/minimax-client";
import {
  buildNarrationRepairPrompt,
  buildNarrationSystemPrompt,
  buildNarrationUserPrompt,
  type NarrationFacts,
} from "@/lib/ai/prompts";
import type { TripNarrator } from "@/lib/ai/trip-narrator";
import type { TripNarrationResponse, TripPlan } from "@/lib/types";

function scheduledClock(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

export function narrationFactsFromPlan(plan: TripPlan): NarrationFacts {
  return {
    tripDate: plan.intent.date,
    origin: plan.intent.origin.resolved?.name ?? plan.intent.origin.query,
    departureTime: plan.departureTime,
    stops: plan.stops.map((stop) => ({
      name: stop.place.name,
      eta: stop.eta,
      departureTime: stop.departureTime ?? null,
      dwellMinutes: Math.round((stop.dwellSec ?? 0) / 60),
    })),
    weather: {
      available: plan.weather.available,
      condition: plan.weather.condition,
      temperatureC: plan.weather.temperatureC,
      source: plan.weather.source,
    },
    vehicle: {
      batteryPercent: plan.vehicle.batteryPercent,
      estimatedArrivalBattery: plan.vehicle.estimatedArrivalBattery,
      cabinTemperatureC: plan.vehicle.cabinTemperatureC,
    },
    planningBufferMinutes: Math.round(plan.planningBufferSec / 60),
    actions: plan.actions.map((action) => ({
      type: action.type,
      title: action.title,
      detail: action.detail,
      severity: action.severity,
      scheduledTime: scheduledClock(action.scheduledAt),
    })),
  };
}

function normalizeNarration(content: string): string {
  const trimmed = content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { text?: unknown };
      if (typeof parsed.text === "string") return parsed.text.replace(/\s+/g, " ").trim();
    } catch {
      // Continue with plain-text normalization.
    }
  }
  return trimmed
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/^(["“])|(["”])$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeClock(text: string, clock: string): string {
  const [hour, minute] = clock.split(":");
  const naturalHour = String(Number(hour));
  return text
    .replace(new RegExp(`(^|\\D)${naturalHour}:${minute}(?!\\d)`, "g"), `$1${clock}`)
    .replace(new RegExp(`(^|\\D)${naturalHour}[点时]${minute}分?`, "g"), `$1${clock}`);
}

function numericValues(value: string): number[] {
  return (value.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

const ACTION_MARKERS: Record<string, RegExp> = {
  PREHEAT: /暖舱|温暖座舱|预热/,
  PRECOOL: /清凉座舱|制冷|降温/,
  SEAT_HEAT: /座椅加热/,
  DEFOG: /除雾/,
  UMBRELLA: /(?:带|准备)(?:好)?(?:雨具|雨伞)|(?:雨具|雨伞).*(?:带|准备)/,
  LEAVE_BUFFER: /缓冲/,
  ENERGY_LOW: /补能|充电|电量/,
  ENERGY_CRITICAL: /补能|充电|电量|调整路线/,
};

function validateActionCoverage(text: string, facts: NarrationFacts): void {
  const requiredActionTypes = [...new Set(facts.actions.map((action) => action.type))];
  const missingAction = requiredActionTypes.find((type) => {
    const marker = ACTION_MARKERS[type];
    return marker ? !marker.test(text) : false;
  });
  if (missingAction) throw new Error(`总结遗漏主动服务 ${missingAction}`);

  const automatedTypes = new Set(["PREHEAT", "PRECOOL", "SEAT_HEAT", "DEFOG"]);
  if (requiredActionTypes.some((type) => automatedTypes.has(type))) {
    if (!/我会|将于|将提前|出发前会/.test(text)) {
      throw new Error("自动车控动作必须使用未来执行语气");
    }
    if (/(?:建议|可以|可)(?:提前)?(?:开启|准备|温暖|制冷|暖舱|座椅加热|除雾)/.test(text)) {
      throw new Error("自动车控动作不能使用建议语气");
    }
  }
}

function validateNarration(text: string, facts: NarrationFacts): void {
  if (text.length < 20 || text.length > 180) {
    throw new Error(`总结长度 ${text.length} 不符合要求`);
  }
  const firstStop = facts.stops[0];
  if (!firstStop || !text.includes(facts.departureTime) || !text.includes(firstStop.eta)) {
    throw new Error("总结缺少出发时间或第一站到达时间");
  }
  const missingIntermediateDeparture = facts.stops.find(
    (stop) => stop.departureTime && stop.dwellMinutes > 5 && !text.includes(stop.departureTime),
  );
  if (missingIntermediateDeparture) {
    throw new Error(`总结缺少从${missingIntermediateDeparture.name}出发的时间`);
  }
  const missingStopArrival = facts.stops.find((stop) => !text.includes(stop.eta));
  if (missingStopArrival) throw new Error(`总结缺少到达${missingStopArrival.name}的时间`);
  validateActionCoverage(text, facts);

  const hasClimateAction = facts.actions.some((action) =>
    ["PREHEAT", "PRECOOL"].includes(action.type),
  );
  if (hasClimateAction && facts.weather.source === "override" && (
    !text.includes(String(facts.vehicle.cabinTemperatureC)) || !text.includes("座舱")
  )) {
    throw new Error("温控动作必须说明座舱温度");
  }
  if (
    facts.weather.source === "override" &&
    facts.weather.temperatureC !== null &&
    facts.weather.temperatureC !== facts.vehicle.cabinTemperatureC &&
    new RegExp(`${facts.weather.temperatureC}(?:\\.0+)?\\s*(?:°C|度|°)`).test(text)
  ) {
    throw new Error("演示场景不得把实时室外温度与覆盖天气混合表达");
  }

  const allowedNumbers = numericValues(JSON.stringify(facts));
  const invented = numericValues(text).find(
    (number) => !allowedNumbers.some((allowed) => Math.abs(allowed - number) < Number.EPSILON),
  );
  if (invented !== undefined) throw new Error(`总结包含输入中不存在的数字 ${invented}`);
}

export class MiniMaxTripNarrator implements TripNarrator {
  constructor(private readonly client: MiniMaxCompletionClient) {}

  async narrate(plan: TripPlan): Promise<TripNarrationResponse> {
    const facts = narrationFactsFromPlan(plan);
    let previousOutput = "";
    let previousIssue = "";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const userPrompt = attempt === 0
        ? buildNarrationUserPrompt(facts)
        : buildNarrationRepairPrompt(facts, previousOutput, previousIssue);
      const output = await this.client.complete({
        messages: [
          { role: "system", content: buildNarrationSystemPrompt() },
          { role: "user", content: userPrompt },
        ],
        maxCompletionTokens: 1_024,
        temperature: 0.1,
      });
      let text = normalizeNarration(output);
      text = canonicalizeClock(text, facts.departureTime);
      facts.stops.forEach((stop) => {
        text = canonicalizeClock(text, stop.eta);
        if (stop.departureTime) text = canonicalizeClock(text, stop.departureTime);
      });

      try {
        validateNarration(text, facts);
        return {
          text,
          provider: "minimax",
          model: this.client.model,
          generatedAt: new Date().toISOString(),
          fallback: false,
        };
      } catch (error) {
        previousOutput = output;
        previousIssue = error instanceof Error ? error.message : "未知事实校验错误";
      }
    }

    throw new MiniMaxError(
      `MiniMax 总结没有通过事实校验：${previousIssue}。`,
      "MINIMAX_INVALID_NARRATION",
      502,
      true,
    );
  }
}
