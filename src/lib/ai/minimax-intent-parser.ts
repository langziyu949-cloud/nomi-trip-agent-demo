import { favoriteDraft, unresolvedDraft } from "@/lib/default-places";
import { favoriteKeyForQuery } from "@/lib/favorite-aliases";
import type { IntentParser } from "@/lib/intent-parser";
import type { TripIntentDraft } from "@/lib/types";
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
  if (countExplicitClocks(rawText) > 1 && modelConstraints.length < 2) {
    throw new Error("原始需求包含多个明确时刻，timeConstraints 必须逐一保留并绑定对应站点");
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
          const repairedCandidate = repairOmittedKnownFavoriteStop(candidate, rawText);
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
