import type { TripNarrationResponse, TripPlan } from "@/lib/types";

export type TripNarrationMode = "initial" | "update";

export interface TripNarrationContext {
  userText?: string;
  mode?: TripNarrationMode;
}

export type TripNarrationFocus =
  | { kind: "stop_arrival"; stopIndex: number }
  | { kind: "departure" }
  | { kind: "constraint"; constraintIndex: number }
  | { kind: "overview" };

export interface TripNarrator {
  narrate(plan: TripPlan, context?: TripNarrationContext): Promise<TripNarrationResponse>;
}

function normalizedMention(value: string): string {
  return value.replace(/[\s，。；、,.!?！？]/g, "").toLocaleLowerCase("zh-CN");
}

function stopAliases(plan: TripPlan, stopIndex: number): string[] {
  const label = plan.intent.stops[stopIndex]?.label ?? "";
  const name = plan.stops[stopIndex]?.place.name ?? "";
  const aliases = new Set([label, name]);
  const combined = `${label}${name}`;
  if (/公司|大厦|园区/.test(combined)) aliases.add("公司");
  if (/学校|中学|小学|幼儿园/.test(combined)) {
    aliases.add("学校");
    aliases.add("到校");
  }
  if (/儿子|孩子/.test(combined)) {
    aliases.add("儿子");
    aliases.add("孩子");
  }
  if (/老婆|妻子/.test(combined)) {
    aliases.add("老婆");
    aliases.add("妻子");
  }
  return [...aliases].map(normalizedMention).filter((alias) => alias.length >= 2);
}

function mentionedStopIndex(plan: TripPlan, userText: string): number | null {
  const normalizedText = normalizedMention(userText);
  const matches = plan.stops.flatMap((_, stopIndex) => {
    const scores = stopAliases(plan, stopIndex)
      .filter((alias) => normalizedText.includes(alias))
      .map((alias) => alias.length);
    return scores.length ? [{ stopIndex, score: Math.max(...scores) }] : [];
  }).sort((left, right) => right.score - left.score);
  if (!matches[0] || matches[0].score === matches[1]?.score) return null;
  return matches[0].stopIndex;
}

function mentionsClock(userText: string, clock: string): boolean {
  const [hour, minute] = clock.split(":");
  const naturalHour = String(Number(hour));
  return userText.includes(clock)
    || userText.includes(`${naturalHour}:${minute}`)
    || userText.includes(`${naturalHour}点${minute}`)
    || (minute === "00" && userText.includes(`${naturalHour}点`))
    || (minute === "30" && userText.includes(`${naturalHour}点半`));
}

export function detectTripNarrationFocus(
  plan: TripPlan,
  context: TripNarrationContext = {},
): TripNarrationFocus {
  const userText = context.userText?.trim() ?? "";
  const arrivalPattern = /(?:几点|什么时候|何时).{0,8}(?:到|抵达)|(?:到|抵达).{0,8}(?:几点|什么时候|何时)|(?:能|会).{0,5}(?:到|抵达)/;
  const arrivalClause = userText
    .split(/[，。；,;!?！？]/)
    .filter((clause) => arrivalPattern.test(clause))
    .at(-1);
  const stopIndex = mentionedStopIndex(plan, userText);
  const arrivalStopIndex = mentionedStopIndex(plan, arrivalClause ?? userText);
  if (arrivalClause && arrivalStopIndex !== null) {
    return { kind: "stop_arrival", stopIndex: arrivalStopIndex };
  }
  if (/(?:几点|什么时候|何时).{0,8}出发|出发.{0,8}(?:几点|什么时候|何时)/.test(userText)) {
    return { kind: "departure" };
  }

  const constraints = plan.intent.timeConstraints?.length
    ? plan.intent.timeConstraints
    : [plan.intent.timeConstraint];
  const mentionsTimeChange = /改成|调整到|提前|推迟|延后|晚一点|早一点|之前|以前|最晚|不迟于/.test(userText);
  const matchingConstraints = constraints.flatMap((constraint, constraintIndex) => {
    if (constraint.inferred) return [];
    const targetMatches = constraint.type === "DEPART_AT"
      ? /出发/.test(userText)
      : stopIndex === constraint.targetStopIndex;
    return mentionsClock(userText, constraint.time) || (mentionsTimeChange && targetMatches)
      ? [{ constraintIndex }]
      : [];
  });
  if (matchingConstraints.length === 1) {
    return { kind: "constraint", constraintIndex: matchingConstraints[0].constraintIndex };
  }
  if ((context.mode ?? "initial") === "initial") {
    const firstExplicitIndex = constraints.findIndex((constraint) => !constraint.inferred);
    if (firstExplicitIndex >= 0) return { kind: "constraint", constraintIndex: firstExplicitIndex };
  }
  return { kind: "overview" };
}

function explicitConstraintText(plan: TripPlan, constraintIndex: number): string {
  const constraints = (plan.intent.timeConstraints?.length
    ? plan.intent.timeConstraints
    : [plan.intent.timeConstraint]);
  const constraint = constraints[constraintIndex];
  if (!constraint || constraint.inferred) return "";
  if (constraint.type === "DEPART_AT") {
    return plan.departureTime === constraint.time
      ? `会按你说的在 ${constraint.time} 出发`
      : `计划在 ${plan.departureTime} 出发，暂时无法满足 ${constraint.time} 出发的要求`;
  }
  const stop = plan.stops[constraint.targetStopIndex];
  if (!stop) return "";
  const label = plan.intent.stops[constraint.targetStopIndex]?.label ?? stop.place.name;
  const deadline = Date.parse(`${plan.intent.date}T${constraint.time}:00+08:00`);
  const plannedArrival = Date.parse(stop.dateTime);
  const satisfied = Number.isFinite(deadline) && Number.isFinite(plannedArrival)
    ? plannedArrival <= deadline
    : stop.eta <= constraint.time;
  return satisfied
    ? `${label}预计 ${stop.eta} 到，可以稳稳赶在 ${constraint.time} 前`
    : `${label}预计 ${stop.eta} 到，暂时赶不上 ${constraint.time} 前的要求`;
}

export function buildTemplateNarration(
  plan: TripPlan,
  options: {
    fallback?: boolean;
    errorCode?: string;
    fallbackReason?: string;
    context?: TripNarrationContext;
  } = {},
): TripNarrationResponse {
  const context = options.context ?? {};
  const mode = context.mode ?? "initial";
  const focus = detectTripNarrationFocus(plan, context);
  const firstStop = plan.stops[0];
  const scheduledIntermediateDeparture = plan.stops
    .slice(0, -1)
    .find((stop) => stop.departureTime && (stop.dwellSec ?? 0) > 5 * 60);
  const intermediateIndex = scheduledIntermediateDeparture
    ? plan.stops.indexOf(scheduledIntermediateDeparture)
    : -1;
  const nextStop = intermediateIndex >= 0 ? plan.stops[intermediateIndex + 1] : null;
  const timingText = scheduledIntermediateDeparture && nextStop
    ? `最晚 ${scheduledIntermediateDeparture.departureTime} 离开${scheduledIntermediateDeparture.place.name}，${nextStop.eta} 到${nextStop.place.name}。`
    : "";
  const actionTypes = new Set(plan.actions.map((action) => action.type));
  const automatedActions = [
    actionTypes.has("PREHEAT") ? "提前温暖座舱" : null,
    actionTypes.has("PRECOOL") ? "提前为座舱降温" : null,
    actionTypes.has("SEAT_HEAT") ? "开启座椅加热" : null,
    actionTypes.has("DEFOG") ? "准备除雾" : null,
  ].filter((value): value is string => value !== null);
  const hasClimateAction = actionTypes.has("PREHEAT") || actionTypes.has("PRECOOL");
  const climateContext = hasClimateAction
    ? plan.weather.source === "override"
      ? `当前座舱 ${plan.vehicle.cabinTemperatureC}°C，`
      : plan.weather.temperatureC !== null
        ? `室外 ${plan.weather.temperatureC}°C，`
        : ""
    : "";
  const automationText = automatedActions.length
    ? `${climateContext}我会${automatedActions.join("、")}。`
    : "";
  const umbrellaText = actionTypes.has("UMBRELLA")
    ? `${plan.weather.condition}，记得带雨具。`
    : "";
  const energyAction = plan.actions.find((action) =>
    action.type === "ENERGY_LOW" || action.type === "ENERGY_CRITICAL",
  );
  const energyText = energyAction ? `${energyAction.detail}` : "";
  const bufferText = actionTypes.has("LEAVE_BUFFER")
    ? `路线已预留 ${Math.round(plan.planningBufferSec / 60)} 分钟路况缓冲。`
    : "";
  const origin = plan.intent.origin.resolved?.name ?? plan.intent.origin.query;
  let lead = "";
  if (focus.kind === "stop_arrival") {
    const stop = plan.stops[focus.stopIndex];
    const label = plan.intent.stops[focus.stopIndex]?.label ?? stop.place.name;
    lead = `好，路线已经重新顺好了，${label}预计 ${stop.eta} 到。建议 ${plan.departureTime} 从${origin}出发。`;
  } else if (focus.kind === "departure") {
    lead = `按现在的安排，${plan.departureTime} 从${origin}出发最合适，第一站预计 ${firstStop.eta} 到。`;
  } else if (focus.kind === "constraint") {
    const constraintText = explicitConstraintText(plan, focus.constraintIndex);
    lead = `${constraintText ? `${constraintText}。` : ""}建议 ${plan.departureTime} 从${origin}出发。`;
  } else {
    lead = `${mode === "initial" ? "我把路线排好了" : "路线已经按你的新安排更新好了"}：${plan.departureTime} 从${origin}出发，${firstStop.eta} 到${firstStop.place.name}。`;
  }
  const detailText = mode === "initial"
    ? `${timingText}${automationText}${umbrellaText}${energyText}${bufferText}`
    : `${timingText}${energyText}`;

  return {
    text: `${lead}${detailText}`,
    provider: "template",
    model: null,
    generatedAt: new Date().toISOString(),
    fallback: options.fallback ?? false,
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    ...(options.fallbackReason ? { fallbackReason: options.fallbackReason } : {}),
  };
}

export class TemplateTripNarrator implements TripNarrator {
  async narrate(plan: TripPlan, context: TripNarrationContext = {}): Promise<TripNarrationResponse> {
    return buildTemplateNarration(plan, { context });
  }
}
