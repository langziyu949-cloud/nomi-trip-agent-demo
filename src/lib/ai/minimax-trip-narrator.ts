import { MiniMaxError, type MiniMaxCompletionClient } from "@/lib/ai/minimax-client";
import {
  buildNarrationRepairPrompt,
  buildNarrationSystemPrompt,
  buildNarrationUserPrompt,
  type NarrationFacts,
  type NarrationTurnGuidance,
} from "@/lib/ai/prompts";
import {
  detectTripNarrationFocus,
  type TripNarrationContext,
  type TripNarrationFocus,
  type TripNarrationMode,
  type TripNarrator,
} from "@/lib/ai/trip-narrator";
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
  const constraints = plan.intent.timeConstraints?.length
    ? plan.intent.timeConstraints
    : [plan.intent.timeConstraint];
  return {
    tripDate: plan.intent.date,
    origin: plan.intent.origin.resolved?.name ?? plan.intent.origin.query,
    departureTime: plan.departureTime,
    stops: plan.stops.map((stop, index) => ({
      name: stop.place.name,
      label: plan.intent.stops[index]?.label ?? stop.place.name,
      eta: stop.eta,
      departureTime: stop.departureTime ?? null,
      dwellMinutes: Math.round((stop.dwellSec ?? 0) / 60),
    })),
    timeConstraints: constraints.flatMap((constraint): NarrationFacts["timeConstraints"] => {
      if (constraint.type === "DEPART_AT") {
        return [{
          type: constraint.type,
          time: constraint.time,
          targetName: plan.intent.origin.resolved?.name ?? plan.intent.origin.query,
          targetLabel: plan.intent.origin.label,
          plannedTime: plan.departureTime,
          inferred: constraint.inferred,
          satisfied: plan.departureTime === constraint.time,
        }];
      }
      const stop = plan.stops[constraint.targetStopIndex];
      if (!stop) return [];
      const deadline = Date.parse(`${plan.intent.date}T${constraint.time}:00+08:00`);
      const plannedArrival = Date.parse(stop.dateTime);
      const plannedMinutes = Number(stop.eta.slice(0, 2)) * 60 + Number(stop.eta.slice(3));
      const deadlineMinutes = Number(constraint.time.slice(0, 2)) * 60 + Number(constraint.time.slice(3));
      return [{
        type: constraint.type,
        time: constraint.time,
        targetName: stop.place.name,
        targetLabel: plan.intent.stops[constraint.targetStopIndex]?.label ?? stop.place.name,
        plannedTime: stop.eta,
        inferred: constraint.inferred,
        satisfied: Number.isFinite(deadline) && Number.isFinite(plannedArrival)
          ? plannedArrival <= deadline
          : plannedMinutes <= deadlineMinutes,
      }];
    }),
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

function numericTokens(value: string): string[] {
  return value.match(/(?<![\d.])-?\d+(?:\.\d+)?/g) ?? [];
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

function validateActionCoverage(text: string, facts: NarrationFacts, requireAll: boolean): void {
  const requiredActionTypes = [...new Set(facts.actions.map((action) => action.type))];
  if (requireAll) {
    const missingAction = requiredActionTypes.find((type) => {
      const marker = ACTION_MARKERS[type];
      return marker ? !marker.test(text) : false;
    });
    if (missingAction) throw new Error(`总结遗漏主动服务 ${missingAction}`);
  }

  const unsupportedAction = Object.entries(ACTION_MARKERS).find(([type, marker]) =>
    marker.test(text) && !requiredActionTypes.includes(type),
  );
  if (unsupportedAction) throw new Error(`总结提到了计划中不存在的主动服务 ${unsupportedAction[0]}`);

  const automatedTypes = new Set(["PREHEAT", "PRECOOL", "SEAT_HEAT", "DEFOG"]);
  const mentionsAutomatedAction = requiredActionTypes.some((type) => {
    const marker = ACTION_MARKERS[type];
    return automatedTypes.has(type) && marker?.test(text);
  });
  if (mentionsAutomatedAction) {
    if (!/我会|将于|将提前|出发前会/.test(text)) {
      throw new Error("自动车控动作必须使用未来执行语气");
    }
    if (/(?:建议|可以|可)(?:提前)?(?:开启|准备|温暖|制冷|暖舱|座椅加热|除雾)/.test(text)) {
      throw new Error("自动车控动作不能使用建议语气");
    }
  }
}

const POSITIVE_CONSTRAINT_MARKERS = [
  /(?:^|[，,\s])满足(?=\s|了|要求|目标|\d)/,
  /(?:可以|能够|能|会|已|已经)满足/,
  /来得及/,
  /(?:可以|能够|能)按时/,
  /(?:可以|能够|能)在[^，,。；;！？!?]{0,30}(?:前|之前)/,
  /不(?:会)?耽误/,
  /符合[^，,。；;！？!?]{0,12}(?:要求|目标)/,
  /提前(?:到达|抵达)/,
];

const NEGATIVE_CONSTRAINT_MARKERS = [
  /(?:未|无法|不能)满足/,
  /来不及|赶不上/,
  /(?:无法|不能)(?:在|按时)/,
  /(?:存在)?(?:时间)?冲突/,
  /(?:会|将)?迟到/,
  /晚于[^，,。；;！？!?]{0,12}(?:要求|目标|截止)/,
];

function targetAliases(constraint: NarrationFacts["timeConstraints"][number]): string[] {
  return [...new Set([constraint.targetLabel, constraint.targetName].filter(Boolean))];
}

function localConstraintFragments(
  text: string,
  constraint: NarrationFacts["timeConstraints"][number],
  explicitConstraints: NarrationFacts["timeConstraints"],
): string[] {
  const aliases = targetAliases(constraint);
  const otherAliases = explicitConstraints
    .filter((item) => item !== constraint)
    .flatMap(targetAliases);
  return aliases.flatMap((alias) => {
    const fragments: string[] = [];
    let cursor = 0;
    while (cursor < text.length) {
      const targetIndex = text.indexOf(alias, cursor);
      if (targetIndex < 0) break;
      const before = text.slice(0, targetIndex);
      const delimiterIndex = Math.max(
        before.lastIndexOf("。"),
        before.lastIndexOf("！"),
        before.lastIndexOf("？"),
        before.lastIndexOf("!"),
        before.lastIndexOf("?"),
        before.lastIndexOf("；"),
        before.lastIndexOf(";"),
        before.lastIndexOf("\n"),
      );
      let start = delimiterIndex + 1;
      const nextDelimiterOffset = text.slice(targetIndex).search(/[。！？!?；;\n]/);
      let end = nextDelimiterOffset < 0 ? text.length : targetIndex + nextDelimiterOffset;

      const previousOtherTarget = otherAliases.reduce((latest, otherAlias) => {
        const index = before.lastIndexOf(otherAlias);
        return index >= start ? Math.max(latest, index) : latest;
      }, -1);
      if (previousOtherTarget >= start) start = targetIndex;
      otherAliases.forEach((otherAlias) => {
        const index = text.indexOf(otherAlias, targetIndex + alias.length);
        if (index >= 0 && index < end) end = index;
      });

      fragments.push(text.slice(start, end));
      cursor = targetIndex + alias.length;
    }
    return fragments;
  });
}

function fragmentHasExpectedConclusion(
  fragment: string,
  satisfied: boolean,
): boolean {
  const hasPositive = POSITIVE_CONSTRAINT_MARKERS.some((marker) => marker.test(fragment));
  const hasNegative = NEGATIVE_CONSTRAINT_MARKERS.some((marker) => marker.test(fragment));
  return satisfied ? hasPositive && !hasNegative : hasNegative && !hasPositive;
}

function fragmentCoversConstraint(
  fragment: string,
  constraint: NarrationFacts["timeConstraints"][number],
): boolean {
  return targetAliases(constraint).some((alias) => fragment.includes(alias))
    && fragment.includes(constraint.time)
    && fragment.includes(constraint.plannedTime)
    && fragmentHasExpectedConclusion(fragment, constraint.satisfied);
}

function validateConstraintCoverage(
  text: string,
  facts: NarrationFacts,
  constraintIndexes: number[],
): void {
  const explicitConstraints = facts.timeConstraints.filter((constraint) => !constraint.inferred);
  constraintIndexes.forEach((constraintIndex) => {
    const constraint = facts.timeConstraints[constraintIndex];
    if (!constraint || constraint.inferred) return;
    const covered = localConstraintFragments(text, constraint, explicitConstraints)
      .some((fragment) => fragmentCoversConstraint(fragment, constraint));
    if (!covered) {
      throw new Error(`总结没有在同一局部语句中正确核对 ${constraint.targetLabel} 的时间目标`);
    }
  });
}

function stopFocusAliases(stop: NarrationFacts["stops"][number]): string[] {
  const aliases = new Set([stop.label, stop.name]);
  const combined = `${stop.label}${stop.name}`;
  if (/公司|大厦|园区/.test(combined)) aliases.add("公司");
  if (/学校|中学|小学|幼儿园/.test(combined)) aliases.add("学校");
  return [...aliases].filter(Boolean);
}

function validateFocusCoverage(
  text: string,
  facts: NarrationFacts,
  focus: TripNarrationFocus,
  mode: TripNarrationMode,
): void {
  if (mode === "initial") {
    const explicitIndexes = facts.timeConstraints.flatMap((constraint, index) =>
      constraint.inferred ? [] : [index],
    );
    validateConstraintCoverage(text, facts, explicitIndexes);
  }
  if (focus.kind === "stop_arrival") {
    const stop = facts.stops[focus.stopIndex];
    if (!stop || !stopFocusAliases(stop).some((alias) => text.includes(alias)) || !text.includes(stop.eta)) {
      throw new Error("回复没有准确回答用户本轮询问的到达地点和时间");
    }
    return;
  }
  if (focus.kind === "departure") {
    if (!text.includes(facts.departureTime)) throw new Error("回复没有准确回答本轮出发时间");
    return;
  }
  if (focus.kind === "constraint") {
    validateConstraintCoverage(text, facts, [focus.constraintIndex]);
    return;
  }
  if (mode === "initial") return;
  if (!text.includes(facts.departureTime) && !facts.stops.some((stop) => text.includes(stop.eta))) {
    throw new Error("行程修改回复缺少受影响的计划时间");
  }
}

function validateTypedQuantities(text: string, facts: NarrationFacts): void {
  for (const match of text.matchAll(/-?\d+(?:\.\d+)?\s*(?:°C|度|°)/g)) {
    const value = Number(match[0].match(/-?\d+(?:\.\d+)?/)?.[0]);
    const index = match.index ?? 0;
    const context = text.slice(Math.max(0, index - 12), Math.min(text.length, index + match[0].length + 8));
    const allowed = /座舱|车内|舱内/.test(context)
      ? [facts.vehicle.cabinTemperatureC]
      : /室外|气温|天气|外面/.test(context)
        ? [facts.weather.temperatureC]
        : [facts.vehicle.cabinTemperatureC, facts.weather.temperatureC];
    if (!allowed.some((candidate) => candidate !== null && candidate === value)) {
      throw new Error(`总结把温度 ${match[0]} 用在了错误的语义字段`);
    }
  }

  for (const match of text.matchAll(/-?\d+(?:\.\d+)?\s*%/g)) {
    const value = Number(match[0].match(/-?\d+(?:\.\d+)?/)?.[0]);
    if (![facts.vehicle.batteryPercent, facts.vehicle.estimatedArrivalBattery].includes(value)) {
      throw new Error(`总结包含不存在的电量 ${match[0]}`);
    }
  }

  for (const match of text.matchAll(/-?\d+(?:\.\d+)?\s*分钟(?:的)?(?:路况)?缓冲/g)) {
    const value = Number(match[0].match(/-?\d+(?:\.\d+)?/)?.[0]);
    if (value !== facts.planningBufferMinutes) {
      throw new Error(`总结包含错误的路况缓冲 ${match[0]}`);
    }
  }
}

function validateNarration(
  text: string,
  facts: NarrationFacts,
  focus: TripNarrationFocus,
  mode: TripNarrationMode,
): void {
  if (text.length < 12 || text.length > 220) {
    throw new Error(`总结长度 ${text.length} 不符合要求`);
  }
  if (/先确认你最关心的(?:时间|问题|信息)/.test(text)) {
    throw new Error("回复使用了重复、生硬的固定开场");
  }
  const firstStop = facts.stops[0];
  if (mode === "initial" && (!firstStop || !text.includes(facts.departureTime) || !text.includes(firstStop.eta))) {
    throw new Error("总结缺少出发时间或第一站到达时间");
  }
  validateFocusCoverage(text, facts, focus, mode);
  if (mode === "initial") {
    const missingIntermediateDeparture = facts.stops.find(
      (stop) => stop.departureTime && stop.dwellMinutes > 5 && !text.includes(stop.departureTime),
    );
    if (missingIntermediateDeparture) {
      throw new Error(`总结缺少从${missingIntermediateDeparture.name}出发的时间`);
    }
  }
  validateActionCoverage(text, facts, mode === "initial");

  const hasClimateAction = facts.actions.some((action) =>
    ["PREHEAT", "PRECOOL"].includes(action.type),
  );
  const mentionsClimateAction = /暖舱|温暖座舱|预热|清凉座舱|制冷|降温/.test(text);
  if (hasClimateAction && mentionsClimateAction && facts.weather.source === "override" && (
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
  validateTypedQuantities(text, facts);

  const allowedNumbers = new Set(numericTokens(JSON.stringify(facts)));
  const invented = numericTokens(text).find((number) => !allowedNumbers.has(number));
  if (invented !== undefined) throw new Error(`总结包含输入中不存在的数字 ${invented}`);
}

function narrationGuidance(
  facts: NarrationFacts,
  focus: TripNarrationFocus,
  mode: TripNarrationMode,
): NarrationTurnGuidance {
  if (focus.kind === "stop_arrival") {
    const stop = facts.stops[focus.stopIndex];
    return {
      mode,
      focus: {
        kind: "stop_arrival",
        targetLabel: stop.label,
        targetName: stop.name,
        plannedTime: stop.eta,
      },
    };
  }
  if (focus.kind === "departure") {
    return { mode, focus: { kind: "departure", plannedTime: facts.departureTime } };
  }
  if (focus.kind === "constraint") {
    const constraint = facts.timeConstraints[focus.constraintIndex];
    return {
      mode,
      focus: {
        kind: "constraint",
        targetLabel: constraint.targetLabel,
        targetName: constraint.targetName,
        requestedTime: constraint.time,
        plannedTime: constraint.plannedTime,
        satisfied: constraint.satisfied,
      },
    };
  }
  return { mode, focus: { kind: "overview" } };
}

export class MiniMaxTripNarrator implements TripNarrator {
  constructor(private readonly client: MiniMaxCompletionClient) {}

  async narrate(
    plan: TripPlan,
    context: TripNarrationContext = {},
  ): Promise<TripNarrationResponse> {
    const facts = narrationFactsFromPlan(plan);
    const mode = context.mode ?? "initial";
    const focus = detectTripNarrationFocus(plan, { ...context, mode });
    const guidance = narrationGuidance(facts, focus, mode);
    let previousOutput = "";
    let previousIssue = "";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const userPrompt = attempt === 0
        ? buildNarrationUserPrompt(facts, context.userText, guidance)
        : buildNarrationRepairPrompt(facts, previousOutput, previousIssue, context.userText, guidance);
      const output = await this.client.complete({
        messages: [
          { role: "system", content: buildNarrationSystemPrompt() },
          { role: "user", content: userPrompt },
        ],
        maxCompletionTokens: 1_024,
        temperature: 0.45,
      });
      let text = normalizeNarration(output);
      text = canonicalizeClock(text, facts.departureTime);
      facts.stops.forEach((stop) => {
        text = canonicalizeClock(text, stop.eta);
        if (stop.departureTime) text = canonicalizeClock(text, stop.departureTime);
      });
      facts.timeConstraints.forEach((constraint) => {
        text = canonicalizeClock(text, constraint.time);
        text = canonicalizeClock(text, constraint.plannedTime);
      });

      try {
        validateNarration(text, facts, focus, mode);
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
