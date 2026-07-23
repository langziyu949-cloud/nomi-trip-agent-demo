import type {
  ConversationHistoryItem,
  ConversationPlanFacts,
} from "@/lib/conversation-turn";
import type { PlaceDraft, TripIntentDraft, TripPlan } from "@/lib/types";

function scheduledClock(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Returns only facts that the conversation model is allowed to quote. Route
 * geometry, coordinates, provider identifiers, and navigation steps stay out
 * of the model boundary.
 */
export function conversationPlanFactsFromPlan(plan: TripPlan): ConversationPlanFacts {
  return {
    tripDate: plan.intent.date,
    plannedAt: plan.createdAt,
    origin: plan.intent.origin.resolved?.name ?? plan.intent.origin.label ?? plan.intent.origin.query,
    departureTime: plan.departureTime,
    stops: plan.stops.map((stop) => ({
      name: stop.place.name,
      eta: stop.eta,
      departureTime: stop.departureTime ?? null,
      dwellMinutes: Math.round((stop.dwellSec ?? 0) / 60),
    })),
    totalDistanceKm: roundTo(plan.totalDistanceM / 1_000, 1),
    totalDurationMinutes: Math.round(plan.totalDurationSec / 60),
    planningBufferMinutes: Math.round(plan.planningBufferSec / 60),
    weather: {
      available: plan.weather.available,
      condition: plan.weather.condition,
      temperatureC: plan.weather.temperatureC,
      humidity: plan.weather.humidity,
      reportTime: plan.weather.reportTime,
      source: plan.weather.source,
    },
    vehicle: {
      batteryPercent: plan.vehicle.batteryPercent,
      estimatedArrivalBattery: plan.vehicle.estimatedArrivalBattery,
      cabinTemperatureC: plan.vehicle.cabinTemperatureC,
    },
    actions: plan.actions.map((action) => ({
      type: action.type,
      title: action.title,
      detail: action.detail,
      scheduledTime: scheduledClock(action.scheduledAt),
    })),
    notes: [...plan.notes],
  };
}

export interface ModelPlaceContext {
  key: string;
  label: string;
  query: string;
  resolvedName: string | null;
  resolution: "RESOLVED" | "UNRESOLVED";
}

export interface ModelIntentContext {
  date: string;
  city: string;
  origin: ModelPlaceContext;
  stops: ModelPlaceContext[];
  timeConstraints: TripIntentDraft["timeConstraints"];
  preferences: string[];
  issues: string[];
}

function placeForModel(place: PlaceDraft): ModelPlaceContext {
  return {
    key: place.key,
    label: place.label,
    query: place.query,
    resolvedName: place.resolved?.name ?? null,
    resolution: place.resolved ? "RESOLVED" : "UNRESOLVED",
  };
}

/** Never expose a ResolvedPlace (and therefore coordinates) to MiniMax. */
export function intentForConversationModel(intent: TripIntentDraft | null | undefined): ModelIntentContext | null {
  if (!intent) return null;
  return {
    date: intent.date,
    city: intent.city,
    origin: placeForModel(intent.origin),
    stops: intent.stops.map(placeForModel),
    timeConstraints: intent.timeConstraints?.length
      ? intent.timeConstraints.map((constraint) => ({ ...constraint }))
      : [{ ...intent.timeConstraint }],
    preferences: [...intent.preferences],
    issues: [...intent.issues],
  };
}

export function pruneConversationHistory(
  history: readonly ConversationHistoryItem[],
  maxMessages = 20,
  maxCharacters = 12_000,
): ConversationHistoryItem[] {
  const selected: ConversationHistoryItem[] = [];
  let characters = 0;

  for (let index = history.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const message = history[index];
    if (!message?.content.trim()) continue;
    const remaining = maxCharacters - characters;
    if (remaining <= 0) break;
    const content = message.content.length <= remaining
      ? message.content
      : message.content.slice(message.content.length - remaining);
    selected.push({ role: message.role, content });
    characters += content.length;
  }

  return selected.reverse();
}

function numericValues(value: string): number[] {
  return [...value.matchAll(/(?<![\d.])[-+]?\d+(?:\.\d+)?/g)]
    .map((match) => Number(match[0]));
}

function clockValues(value: string): string[] {
  return [...value.matchAll(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g)]
    .map((match) => `${match[1].padStart(2, "0")}:${match[2]}`);
}

type MeasurementKind = "temperature" | "percent" | "distance" | "minutes";

interface MeasurementValue {
  kind: MeasurementKind;
  value: number;
  unit: string;
}

function measurementValues(value: string): MeasurementValue[] {
  return [...value.matchAll(
    /(?<![\d.])([-+]?\d+(?:\.\d+)?)\s*(°\s*C|℃|摄氏度|公里|千米|km|分钟|%|度|分)/gi,
  )].map((match) => {
    const unit = match[2].replace(/\s/g, "").toLowerCase();
    const kind: MeasurementKind = unit === "%"
      ? "percent"
      : ["公里", "千米", "km"].includes(unit)
        ? "distance"
        : ["分钟", "分"].includes(unit)
          ? "minutes"
          : "temperature";
    return { kind, value: Number(match[1]), unit: match[2] };
  });
}

function allowedMeasurementValues(
  kind: MeasurementKind,
  userText: string,
  facts: ConversationPlanFacts | null | undefined,
): number[] {
  const allowed = measurementValues(userText)
    .filter((measurement) => measurement.kind === kind)
    .map((measurement) => measurement.value);
  if (!facts) return allowed;

  allowed.push(...measurementValues(JSON.stringify(facts))
    .filter((measurement) => measurement.kind === kind)
    .map((measurement) => measurement.value));
  if (kind === "temperature") {
    if (facts.weather.temperatureC !== null) allowed.push(facts.weather.temperatureC);
    allowed.push(facts.vehicle.cabinTemperatureC);
  } else if (kind === "percent") {
    allowed.push(facts.vehicle.batteryPercent, facts.vehicle.estimatedArrivalBattery);
    if (facts.weather.humidity !== null) allowed.push(facts.weather.humidity);
  } else if (kind === "distance") {
    allowed.push(facts.totalDistanceKm);
  } else {
    allowed.push(
      facts.totalDurationMinutes,
      facts.planningBufferMinutes,
      ...facts.stops.map((stop) => stop.dwellMinutes),
    );
  }
  return allowed;
}

export function validateGroundedAnswer(
  answer: string,
  userText: string,
  facts: ConversationPlanFacts | null | undefined,
): void {
  const groundingText = JSON.stringify({ userText, facts: facts ?? null });
  const inventedMeasurement = measurementValues(answer).find((measurement) => {
    const allowed = allowedMeasurementValues(measurement.kind, userText, facts);
    return !allowed.some((value) => Math.abs(value - measurement.value) < Number.EPSILON);
  });
  if (inventedMeasurement) {
    throw new Error(
      `回答包含当前计划和用户问题中不存在的带单位数字 ${inventedMeasurement.value}${inventedMeasurement.unit}`,
    );
  }

  const allowedClocks = new Set(clockValues(groundingText));
  const inventedClock = clockValues(answer).find((clock) => !allowedClocks.has(clock));
  if (inventedClock !== undefined) {
    throw new Error(`回答包含当前计划和用户问题中不存在的时间 ${inventedClock}`);
  }

  const allowedNumbers = numericValues(groundingText);
  const invented = numericValues(answer).find(
    (number) => !allowedNumbers.some((allowed) => Math.abs(allowed - number) < Number.EPSILON),
  );
  if (invented !== undefined) {
    throw new Error(`回答包含当前计划和用户问题中不存在的数字 ${invented}`);
  }
}
