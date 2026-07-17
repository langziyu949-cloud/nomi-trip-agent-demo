import { favoriteDraft, unresolvedDraft } from "@/lib/default-places";
import { resolveRelativeDate } from "@/lib/date-utils";
import { favoriteKeyForQuery } from "@/lib/favorite-aliases";
import { hasExplicitClock, inferredDepartureTime } from "@/lib/time-constraint-defaults";
import type { PlaceDraft, TripIntentDraft } from "@/lib/types";

export interface IntentParser {
  parse(text: string, now?: Date): Promise<TripIntentDraft>;
}

function normalize(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[！!？?]/g, "。")
    .replace(/[、]/g, "，")
    .trim();
}

function resolveAlias(query: string, index: number): PlaceDraft {
  const cleaned = query
    .replace(/^(一下|一趟)/, "")
    .replace(/(提前准备(?:一下)?|帮我安排(?:一下)?|顺便|一下|吧|附近)$/g, "")
    .replace(/^(孩子|小孩|乐乐)/, "")
    .trim();

  const favoriteKey = favoriteKeyForQuery(cleaned);
  return favoriteKey ? favoriteDraft(favoriteKey) : unresolvedDraft(cleaned, index);
}

function parseOrigin(text: string): PlaceDraft {
  const match = text.match(/从(.+?)(?:出发|先去|去)/);
  return match ? resolveAlias(match[1], -1) : favoriteDraft("home");
}

function extractDestinations(text: string): PlaceDraft[] {
  const candidates: string[] = [];
  const patterns = [
    /(?:先去|再去|然后去|接着去|随后去|去|送(?:孩子|小孩|乐乐)?到)([^，。；]+?)(?=先去|再去|然后去|接着去|随后去|，|。|；|$)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      let place = match[1]
        .replace(/^从.+?出发/, "")
        .replace(/(?:然后|接着|随后)$/, "")
        .replace(/(?:上班|办事)$/, "公司")
        .replace(/(?:上学|上课)$/, "学校")
        .replace(/(?:提前准备.*|帮我安排.*)$/g, "")
        .trim();
      if (/^(孩子|小孩|乐乐)?学校$/.test(place)) place = "学校";
      if (place && !candidates.includes(place)) candidates.push(place);
    }
  }

  if (candidates.length === 0 && /送(?:孩子|小孩|乐乐).*(?:上学|学校)/.test(text)) {
    candidates.push("学校");
  }
  if (/然后.*(?:公司|上班)|再.*(?:公司|上班)/.test(text) && !candidates.includes("公司")) {
    candidates.push("公司");
  }

  return candidates.slice(0, 3).map(resolveAlias);
}

function parseTime(text: string): string {
  const halfMatch = text.match(/(\d{1,2})点半/);
  if (halfMatch) return `${halfMatch[1].padStart(2, "0")}:30`;

  const match = text.match(/(\d{1,2})(?:[:：点时])(\d{1,2})?分?/);
  if (!match) return "08:00";
  const hour = Math.min(23, Number(match[1]));
  const minute = Math.min(59, Number(match[2] ?? 0));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parsePreferences(text: string): string[] {
  const preferences = new Set<string>();
  if (/提前准备|备车|热车|预热|开空调|天气冷|天气热/.test(text)) {
    preferences.add("precondition_vehicle");
  }
  if (/躲避拥堵|别堵|最快/.test(text)) preferences.add("avoid_congestion");
  return [...preferences];
}

export class MockIntentParser implements IntentParser {
  async parse(rawText: string, now = new Date()): Promise<TripIntentDraft> {
    const text = normalize(rawText);
    const issues: string[] = [];
    const stops = extractDestinations(text);
    if (stops.length === 0) issues.push("没有识别到目的地，请在结构化行程中补充。 ");

    const hasClock = hasExplicitClock(text);
    const explicitDepart = hasClock && (/(点|时|:|：).{0,8}(出发|动身)|(?:出发|动身).{0,8}(点|时|:|：)/.test(text));
    const explicitArrive = /(前到|到达|送(?:孩子|小孩|乐乐)?到|到学校)/.test(text);
    const type = !hasClock || explicitDepart ? "DEPART_AT" : "ARRIVE_BY";
    const inferred = !hasClock || (!explicitDepart && !explicitArrive);

    const date = resolveRelativeDate(text, now);
    const time = hasClock ? parseTime(text) : inferredDepartureTime(text, date, now);
    const targetStopIndex = type === "ARRIVE_BY" ? 0 : 0;

    const timeConstraint: TripIntentDraft["timeConstraint"] = {
      type,
      time,
      targetStopIndex,
      inferred,
    };
    return {
      rawText,
      date,
      city: "上海市",
      origin: parseOrigin(text),
      stops,
      timeConstraint,
      timeConstraints: [timeConstraint],
      preferences: parsePreferences(text),
      confidence: Math.max(0.45, 0.96 - issues.length * 0.18 - stops.filter((stop) => !stop.resolved).length * 0.08),
      issues,
      understanding: { provider: "mock", model: null, fallback: false },
    };
  }
}
