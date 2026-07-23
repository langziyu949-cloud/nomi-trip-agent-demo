import { DEFAULT_PLACES, favoriteDraft, unresolvedDraft } from "@/lib/default-places";
import { favoriteKeyForQuery } from "@/lib/favorite-aliases";
import type { IntentParser } from "@/lib/intent-parser";
import type { FavoritePlaceKey, TripIntentDraft } from "@/lib/types";
import {
  buildIntentRepairPrompt,
  buildIntentSystemPrompt,
  buildIntentUserPrompt,
} from "@/lib/ai/prompts";
import { MiniMaxError, type MiniMaxCompletionClient } from "@/lib/ai/minimax-client";
import { extractJsonObjects, MiniMaxRawIntentSchema, type MiniMaxRawIntent } from "@/lib/ai/schemas";
import { countExplicitClocks, hasExplicitClock, inferredDepartureTime } from "@/lib/time-constraint-defaults";

function validationSummary(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "输出不是有效的行程 JSON";
}

function isNonBlockingTimeQuestion(issue: string): boolean {
  if (/(冲突|矛盾|多个时间|两个时间)/.test(issue)) return false;
  return /(?:时间|几点|出发|到达|送到|上班|上学)/.test(issue) &&
    /(?:未明确|不明确|未说明|未提及|没有(?:给出|说明|提到)?|请确认|需要确认)/.test(issue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EXPLICIT_CLOCK_CONTEXT_PATTERN = /(?:[01]?\d|2[0-3])[:：][0-5]?\d|[零〇一二两三四五六七八九十0-9]{1,3}(?:点|时)(?:半|[零〇一二两三四五六七八九十0-9]{1,3}分)?/g;
const CLAUSE_SEPARATORS = new Set(["，", ",", "。", ".", "；", ";", "！", "!", "？", "?"]);

interface ExplicitClockMention {
  time: string;
  clause: string;
}

function parseChineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value.includes("十")) {
    const [tensText, unitsText] = value.split("十");
    const tens = tensText ? digits[tensText] : 1;
    const units = unitsText ? digits[unitsText] : 0;
    return tens === undefined || units === undefined ? null : tens * 10 + units;
  }
  const converted = [...value].map((character) => digits[character]);
  if (converted.some((digit) => digit === undefined)) return null;
  return Number(converted.join(""));
}

function normalizeClockMention(value: string): string | null {
  const colonClock = value.match(/^([01]?\d|2[0-3])[:：]([0-5]?\d)$/);
  if (colonClock) {
    return `${colonClock[1].padStart(2, "0")}:${colonClock[2].padStart(2, "0")}`;
  }
  const wordClock = value.match(/^([零〇一二两三四五六七八九十0-9]{1,3})(?:点|时)(半|([零〇一二两三四五六七八九十0-9]{1,3})分)?$/);
  if (!wordClock) return null;
  const hour = parseChineseNumber(wordClock[1]);
  const minute = wordClock[2] === "半" ? 30 : wordClock[3] ? parseChineseNumber(wordClock[3]) : 0;
  if (hour === null || minute === null || hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function explicitClockMentions(rawText: string): ExplicitClockMention[] {
  const normalized = rawText.replace(/\s+/g, "");
  return [...normalized.matchAll(EXPLICIT_CLOCK_CONTEXT_PATTERN)].flatMap((match) => {
    const time = normalizeClockMention(match[0]);
    if (!time) return [];
    const matchStart = match.index ?? 0;
    const matchEnd = matchStart + match[0].length;
    let clauseStart = matchStart;
    let clauseEnd = matchEnd;
    while (clauseStart > 0 && !CLAUSE_SEPARATORS.has(normalized[clauseStart - 1])) clauseStart -= 1;
    while (clauseEnd < normalized.length && !CLAUSE_SEPARATORS.has(normalized[clauseEnd])) clauseEnd += 1;
    return [{ time, clause: normalized.slice(clauseStart, clauseEnd) }];
  });
}

function rawPlaceLabel(place: unknown): string | null {
  if (!isRecord(place)) return null;
  if (typeof place.query === "string" && place.query.trim()) return place.query.trim();
  if (typeof place.favoriteKey !== "string" || !(place.favoriteKey in DEFAULT_PLACES)) return null;
  return DEFAULT_PLACES[place.favoriteKey as FavoritePlaceKey].name;
}

function normalizeSemanticText(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, "").toLocaleLowerCase("zh-CN");
}

function placeAffinityScore(clause: string, label: string): number {
  const normalizedClause = normalizeSemanticText(clause);
  const normalizedLabel = normalizeSemanticText(label);
  if (!normalizedLabel) return 0;
  if (normalizedClause.includes(normalizedLabel)) return normalizedLabel.length * 10;

  let score = 0;
  const matchedFragments = new Set<string>();
  for (let size = Math.min(3, normalizedLabel.length); size >= 2; size -= 1) {
    for (let index = 0; index <= normalizedLabel.length - size; index += 1) {
      const fragment = normalizedLabel.slice(index, index + size);
      if (normalizedClause.includes(fragment) && !matchedFragments.has(fragment)) {
        matchedFragments.add(fragment);
        score += size;
      }
    }
  }
  return score;
}

type OrdinalTarget =
  | { kind: "none" }
  | { kind: "unique"; index: number }
  | { kind: "ambiguous" };

function ordinalTargetIndex(clause: string, stopCount: number): OrdinalTarget {
  const normalized = normalizeSemanticText(clause);
  const indexes = new Set<number>();
  if (/(?:首站|首个(?:站点|目的地))/.test(normalized)) indexes.add(0);
  if (/(?:末站|最后一站|最后一个(?:站点|目的地))/.test(normalized)) indexes.add(stopCount - 1);
  for (const match of normalized.matchAll(/第([零〇一二两三四五六七八九十0-9]{1,3})(?:个)?(?:站|站点|目的地)/g)) {
    const ordinal = parseChineseNumber(match[1]);
    if (ordinal === null) return { kind: "ambiguous" };
    indexes.add(ordinal - 1);
  }
  if (indexes.size === 0) return { kind: "none" };
  if (indexes.size !== 1) return { kind: "ambiguous" };
  const [index] = indexes;
  return index >= 0 && index < stopCount
    ? { kind: "unique", index }
    : { kind: "ambiguous" };
}

function lexicalTargetIndex(clause: string, stops: unknown[]): number | null {
  const candidates = stops
    .map((stop, index) => ({ index, label: rawPlaceLabel(stop) }))
    .filter((candidate): candidate is { index: number; label: string } => candidate.label !== null);
  const normalizedClause = normalizeSemanticText(clause);
  const exactMatches = candidates.filter(({ label }) => normalizedClause.includes(normalizeSemanticText(label)));
  if (exactMatches.length === 1) return exactMatches[0].index;
  if (exactMatches.length > 1) return null;

  const ranked = candidates
    .map(({ index, label }) => ({ index, score: placeAffinityScore(clause, label) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best || best.score < 2 || best.score - (runnerUp?.score ?? 0) < 2) return null;
  return best.index;
}

function semanticTargetIndex(clause: string, stops: unknown[]): number | null {
  const ordinal = ordinalTargetIndex(clause, stops.length);
  if (ordinal.kind === "ambiguous") return null;
  const lexical = lexicalTargetIndex(clause, stops);
  if (ordinal.kind === "unique") {
    return lexical !== null && lexical !== ordinal.index ? null : ordinal.index;
  }
  return lexical;
}

/**
 * Guard against an otherwise structurally valid one-based or semantically
 * misbound model index. This only changes an arrival constraint when the
 * clause containing its explicit clock uniquely identifies one stop; an
 * ambiguous clause deliberately remains model-owned.
 */
function repairArrivalConstraintBindings(candidate: unknown, rawText: string): unknown {
  if (!isRecord(candidate) || !Array.isArray(candidate.stops)) return candidate;
  const repaired = structuredClone(candidate);
  const constraints = Array.isArray(repaired.timeConstraints)
    ? repaired.timeConstraints
    : isRecord(repaired.timeConstraint) ? [repaired.timeConstraint] : [];
  const mentions = explicitClockMentions(rawText);
  const arrivalConstraints = constraints.filter(
    (constraint): constraint is Record<string, unknown> =>
      isRecord(constraint) && constraint.type === "ARRIVE_BY" && typeof constraint.time === "string",
  );
  const times = new Set(arrivalConstraints.map((constraint) => constraint.time as string));

  times.forEach((time) => {
    const matchingConstraints = arrivalConstraints.filter((constraint) => constraint.time === time);
    const matchingMentions = mentions.filter((mention) => mention.time === time);
    if (matchingConstraints.length !== matchingMentions.length) return;
    const targetIndexes = matchingMentions.map((mention) =>
      semanticTargetIndex(mention.clause, repaired.stops as unknown[]));
    if (targetIndexes.some((index) => index === null)) return;
    matchingConstraints.forEach((constraint, index) => {
      constraint.targetStopIndex = targetIndexes[index];
    });
  });
  return repaired;
}

interface ExplicitStopMention {
  index: number;
  key: string;
  place: Record<string, unknown>;
}

function explicitStopMentions(rawText: string): ExplicitStopMention[] {
  const mentions: ExplicitStopMention[] = [];
  const customPattern = /(?:到|去)([^，。；]+?)(?=然后|再|接着|随后|，|。|；|$)/g;
  for (const match of rawText.matchAll(customPattern)) {
    const query = match[1].trim();
    if (!query || /^(?:接|送).*(?:放学|上学|上班)/.test(query)) continue;
    const favoriteKey = favoriteKeyForQuery(query);
    mentions.push({
      index: match.index ?? 0,
      key: favoriteKey ?? `query:${query}`,
      place: {
        kind: "FAVORITE_OR_QUERY",
        favoriteKey,
        query,
      },
    });
  }

  const knownMentions = [
    {
      key: "school",
      pattern: /接(?:我)?(?:儿子|孩子|小孩).*?放学|送(?:我)?(?:儿子|孩子|小孩).*?(?:上学|学校)/,
    },
    { key: "wifeCompany", pattern: /送(?:我)?(?:老婆|妻子).*?上班/ },
    { key: "company", pattern: /(?:去|到)(?:我|我的)公司/ },
  ];
  knownMentions.forEach((mention) => {
    const index = rawText.search(mention.pattern);
    if (index >= 0) {
      mentions.push({
        index,
        key: mention.key,
        place: { kind: "FAVORITE_OR_QUERY", favoriteKey: mention.key, query: null },
      });
    }
  });

  return mentions
    .sort((left, right) => left.index - right.index)
    .filter((mention, index, all) => index === all.findIndex((candidate) => candidate.key === mention.key));
}

function repairOmittedKnownFavoriteStop(candidate: unknown, rawText: string): unknown {
  if (!isRecord(candidate) || !Array.isArray(candidate.stops)) return candidate;
  const repaired = structuredClone(candidate);
  const repairedStops = repaired.stops as unknown[];
  const repairedConstraints = Array.isArray(repaired.timeConstraints)
    ? repaired.timeConstraints
    : isRecord(repaired.timeConstraint) ? [repaired.timeConstraint] : [];
  const arrivalConstraints = repairedConstraints.filter(
    (constraint) => isRecord(constraint) && constraint.type === "ARRIVE_BY",
  ) as Array<Record<string, unknown>>;

  const origin = isRecord(repaired.origin) ? repaired.origin : null;
  const firstStop = isRecord(repairedStops[0]) ? repairedStops[0] : null;
  const repeatsOrigin = origin !== null && firstStop !== null && (
    (typeof origin.favoriteKey === "string" && origin.favoriteKey === firstStop.favoriteKey) ||
    (typeof origin.query === "string" && origin.query === firstStop.query)
  );
  if (repeatsOrigin) {
    repairedStops.shift();
    arrivalConstraints.forEach((constraint) => {
      if (typeof constraint.targetStopIndex === "number" && constraint.targetStopIndex > 0) {
        constraint.targetStopIndex -= 1;
      }
    });
  }

  const targetIndexes = repairedConstraints
    .filter(isRecord)
    .map((constraint) => constraint.targetStopIndex)
    .filter((value): value is number => Number.isInteger(value) && Number(value) >= 0);
  let maximumTargetIndex = Math.max(-1, ...targetIndexes);
  if (maximumTargetIndex < repairedStops.length) return repaired;
  const usesOneBasedStopIndexes = arrivalConstraints.length > 0 &&
    arrivalConstraints.every((constraint) =>
      typeof constraint.targetStopIndex === "number" && constraint.targetStopIndex >= 1,
    ) && maximumTargetIndex === repairedStops.length;
  if (usesOneBasedStopIndexes) {
    arrivalConstraints.forEach((constraint) => {
      constraint.targetStopIndex = Number(constraint.targetStopIndex) - 1;
    });
    maximumTargetIndex -= 1;
    if (maximumTargetIndex < repairedStops.length) return repaired;
  }

  const orderedExplicitStops = explicitStopMentions(rawText);
  if (orderedExplicitStops.length > maximumTargetIndex) {
    repaired.stops = orderedExplicitStops.slice(0, 3).map((mention) => mention.place);
    return repaired;
  }

  const mentions = [
    {
      key: "school",
      pattern: /接(?:我)?(?:儿子|孩子|小孩).*?放学|送(?:我)?(?:儿子|孩子|小孩).*?(?:上学|学校)/,
    },
    { key: "wifeCompany", pattern: /送(?:我)?(?:老婆|妻子).*?上班/ },
    { key: "company", pattern: /(?:去|到)(?:我|我的)公司/ },
  ]
    .map((mention) => ({ ...mention, index: rawText.search(mention.pattern) }))
    .filter((mention) => mention.index >= 0)
    .sort((left, right) => left.index - right.index);
  const stops = repairedStops;

  for (const mention of mentions) {
    const exists = stops.some((stop) => isRecord(stop) && (
      stop.favoriteKey === mention.key ||
      (typeof stop.query === "string" && favoriteKeyForQuery(stop.query) === mention.key)
    ));
    if (!exists && stops.length <= maximumTargetIndex && stops.length < 3) {
      stops.push({ kind: "FAVORITE_OR_QUERY", favoriteKey: mention.key, query: null });
    }
  }
  return repaired;
}

function toDraft(rawText: string, raw: MiniMaxRawIntent, model: string, now: Date): TripIntentDraft {
  const toPlaceDraft = (place: MiniMaxRawIntent["origin"], index: number) => {
    if (place.favoriteKey && place.query === null) return favoriteDraft(place.favoriteKey);
    const query = place.query ?? "";
    const aliasFromQuery = favoriteKeyForQuery(query);
    const favoriteKey = aliasFromQuery && (!place.favoriteKey || place.favoriteKey === aliasFromQuery)
      ? aliasFromQuery
      : null;
    return favoriteKey ? favoriteDraft(favoriteKey) : unresolvedDraft(query, index);
  };

  const issues = [...new Set(raw.issues)].filter((issue) => !isNonBlockingTimeQuestion(issue));
  const modelConstraints = raw.timeConstraints?.length
    ? raw.timeConstraints
    : raw.timeConstraint ? [raw.timeConstraint] : [];
  const explicitClockCount = countExplicitClocks(rawText);
  const explicitModelConstraintCount = modelConstraints.filter((constraint) => !constraint.inferred).length;
  if (explicitClockCount > 0 && explicitClockCount !== explicitModelConstraintCount) {
    throw new Error(
      `原始需求包含 ${explicitClockCount} 个明确时刻，timeConstraints 必须恰好保留 ${explicitClockCount} 个非推断约束，当前为 ${explicitModelConstraintCount} 个`,
    );
  }
  const timeConstraints = hasExplicitClock(rawText)
    ? modelConstraints
    : [{
        type: "DEPART_AT" as const,
        time: inferredDepartureTime(rawText, raw.date, now),
        targetStopIndex: 0,
        inferred: true,
      }];
  const timeConstraint = timeConstraints.at(-1)!;
  if (raw.stops.length === 0 && !issues.some((issue) => issue.includes("目的地"))) {
    issues.push("没有识别到目的地，请在结构化行程中补充。 ");
  }

  return {
    rawText,
    date: raw.date,
    city: raw.city,
    origin: toPlaceDraft(raw.origin, -1),
    stops: raw.stops.map(toPlaceDraft),
    timeConstraint,
    timeConstraints,
    preferences: [...new Set(raw.preferences)],
    confidence: raw.confidence,
    issues,
    understanding: { provider: "minimax", model, fallback: false },
  };
}

export class MiniMaxIntentParser implements IntentParser {
  readonly model: string;

  constructor(private readonly client: MiniMaxCompletionClient) {
    this.model = client.model;
  }

  async parse(rawText: string, now = new Date()): Promise<TripIntentDraft> {
    const systemPrompt = buildIntentSystemPrompt(now);
    let previousOutput = "";
    let previousIssue = "";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const userPrompt = attempt === 0
        ? buildIntentUserPrompt(rawText)
        : buildIntentRepairPrompt(rawText, previousOutput, previousIssue);
      const output = await this.client.complete({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxCompletionTokens: 2_048,
        temperature: 0,
      });

      try {
        const candidates = extractJsonObjects(output);
        const validationIssues: string[] = [];
        for (const candidate of candidates.toReversed()) {
          const repairedCandidate = repairArrivalConstraintBindings(
            repairOmittedKnownFavoriteStop(candidate, rawText),
            rawText,
          );
          const parsed = MiniMaxRawIntentSchema.safeParse(repairedCandidate);
          if (parsed.success) return toDraft(rawText, parsed.data, this.model, now);
          validationIssues.push(parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
            .join("；"));
        }
        throw new Error(validationIssues[0] || "JSON 对象不符合行程结构");
      } catch (error) {
        previousOutput = output;
        previousIssue = validationSummary(error);
      }
    }

    throw new MiniMaxError(
      `MiniMax 连续返回了无效的行程结构：${previousIssue.slice(0, 160) || "未知校验错误"}。`,
      "MINIMAX_INVALID_INTENT",
      502,
      true,
    );
  }
}
