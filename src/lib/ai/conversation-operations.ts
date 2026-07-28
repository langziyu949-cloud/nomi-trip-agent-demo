import { z } from "zod";

import { MiniMaxRawIntentSchema, MiniMaxRawPlaceSchema } from "@/lib/ai/schemas";
import { favoriteKeyForQuery } from "@/lib/favorite-aliases";
import type {
  FavoritePlaceKey,
  PlaceDraft,
  TimeConstraint,
  TripIntentDraft,
} from "@/lib/types";

const CalendarDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  });

const ModelTimeConstraintSchema = z.object({
  type: z.enum(["ARRIVE_BY", "DEPART_AT"]),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  targetStopIndex: z.number().int().min(0).max(2),
  inferred: z.boolean(),
}).strict();

export const ConversationOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("SET_DATE"), date: CalendarDateSchema }).strict(),
  z.object({ op: z.literal("SET_ORIGIN"), place: MiniMaxRawPlaceSchema }).strict(),
  z.object({
    op: z.literal("ADD_STOP"),
    index: z.number().int().min(0).max(3),
    place: MiniMaxRawPlaceSchema,
  }).strict(),
  z.object({ op: z.literal("REMOVE_STOP"), index: z.number().int().min(0).max(2) }).strict(),
  z.object({
    op: z.literal("REPLACE_STOP"),
    index: z.number().int().min(0).max(2),
    place: MiniMaxRawPlaceSchema,
  }).strict(),
  z.object({
    op: z.literal("MOVE_STOP"),
    fromIndex: z.number().int().min(0).max(2),
    toIndex: z.number().int().min(0).max(2),
  }).strict(),
  z.object({
    op: z.literal("SET_TIME_CONSTRAINT"),
    index: z.number().int().min(0).max(2),
    constraint: ModelTimeConstraintSchema,
  }).strict(),
  z.object({
    op: z.literal("REMOVE_TIME_CONSTRAINT"),
    index: z.number().int().min(0).max(2),
  }).strict(),
  z.object({ op: z.literal("SET_PRECONDITION"), enabled: z.boolean() }).strict(),
  z.object({ op: z.literal("REWRITE"), intent: MiniMaxRawIntentSchema }).strict(),
]);

export type ConversationOperation = z.infer<typeof ConversationOperationSchema>;

const ModelResponseTextSchema = z.string().trim().min(1).max(1_000);

export const MiniMaxConversationTurnSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("PLAN_CHANGE"),
    text: ModelResponseTextSchema,
    operations: z.array(ConversationOperationSchema).min(1).max(10),
  }).strict(),
  z.object({
    type: z.literal("ANSWER"),
    text: ModelResponseTextSchema,
  }).strict(),
  z.object({
    type: z.literal("CLARIFY"),
    text: ModelResponseTextSchema,
    reason: z.enum(["MISSING_CONTEXT", "AMBIGUOUS_CHANGE", "INVALID_CHANGE", "UNSUPPORTED"]),
  }).strict(),
  z.object({
    type: z.literal("REFRESH_REQUIRED"),
    text: ModelResponseTextSchema,
    refresh: z.array(z.enum(["route", "weather"])).min(1).max(2),
  }).strict(),
]);

export type MiniMaxConversationTurn = z.infer<typeof MiniMaxConversationTurnSchema>;

const FAVORITE_LABELS: Record<FavoritePlaceKey, string> = {
  home: "家",
  company: "我的公司",
  school: "儿子学校",
  wifeCompany: "老婆公司",
};

type RawPlace = z.infer<typeof MiniMaxRawPlaceSchema>;

function allExistingPlaces(intent: TripIntentDraft): PlaceDraft[] {
  return [intent.origin, ...intent.stops];
}

function changedPlaceDraft(raw: RawPlace, index: number, base: TripIntentDraft): PlaceDraft {
  const favoriteKey = raw.favoriteKey ?? (raw.query ? favoriteKeyForQuery(raw.query) : null);
  if (favoriteKey) {
    const label = FAVORITE_LABELS[favoriteKey];
    const existing = allExistingPlaces(base).find((place) => place.key === favoriteKey);
    return {
      key: favoriteKey,
      label,
      query: label,
      // A favorite may have been customized in this conversation's locked
      // scenario. Reuse that exact resolution when available; never substitute
      // process-wide defaults here.
      resolved: existing?.resolved ? structuredClone(existing.resolved) : null,
    };
  }

  const query = raw.query?.trim() ?? "";
  if (!query) throw new Error("自定义地点缺少查询词");
  return {
    key: `custom-${index}-${query}`,
    label: query,
    query,
    // Changed custom locations always return to POI confirmation, even if the
    // same words happened to resolve elsewhere in the previous plan.
    resolved: null,
  };
}

function normalizedConstraints(intent: TripIntentDraft): TimeConstraint[] {
  return (intent.timeConstraints?.length ? intent.timeConstraints : [intent.timeConstraint])
    .map((constraint) => ({ ...constraint }));
}

function remapForMove(index: number, fromIndex: number, toIndex: number): number {
  if (index === fromIndex) return toIndex;
  if (fromIndex < toIndex && index > fromIndex && index <= toIndex) return index - 1;
  if (fromIndex > toIndex && index >= toIndex && index < fromIndex) return index + 1;
  return index;
}

function validateIntentAfterOperations(intent: TripIntentDraft): void {
  if (intent.stops.length < 1 || intent.stops.length > 3) {
    throw new Error("行程必须保留 1 到 3 个目的地");
  }
  const constraints = normalizedConstraints(intent);
  if (constraints.length < 1 || constraints.length > 3) {
    throw new Error("行程必须保留 1 到 3 个时间约束");
  }
  constraints.forEach((constraint) => {
    if (constraint.targetStopIndex >= intent.stops.length) {
      throw new Error("时间约束指向了不存在的目的地");
    }
    if (constraint.type === "DEPART_AT" && constraint.targetStopIndex !== 0) {
      throw new Error("出发时间的目标站下标必须为 0");
    }
  });
}

export interface ApplyConversationOperationsOptions {
  rawText: string;
  provider: "minimax" | "mock";
  model: string | null;
  fallback: boolean;
}

export function applyConversationOperations(
  currentIntent: TripIntentDraft,
  operations: readonly ConversationOperation[],
  options: ApplyConversationOperationsOptions,
): TripIntentDraft {
  if (operations.length === 0) throw new Error("没有可应用的行程修改");
  if (operations.some((operation) => operation.op === "REWRITE") && operations.length !== 1) {
    throw new Error("REWRITE 必须作为唯一操作");
  }

  const base = structuredClone(currentIntent);
  let draft = structuredClone(currentIntent);
  let constraints = normalizedConstraints(draft);

  for (const operation of operations) {
    switch (operation.op) {
      case "SET_DATE":
        draft.date = operation.date;
        break;
      case "SET_ORIGIN":
        draft.origin = changedPlaceDraft(operation.place, -1, base);
        break;
      case "ADD_STOP": {
        if (draft.stops.length >= 3 || operation.index > draft.stops.length) {
          throw new Error("新增目的地的位置无效或已超过 3 个目的地");
        }
        draft.stops.splice(operation.index, 0, changedPlaceDraft(operation.place, operation.index, base));
        constraints = constraints.map((constraint) => ({
          ...constraint,
          targetStopIndex: constraint.type === "ARRIVE_BY" && constraint.targetStopIndex >= operation.index
            ? constraint.targetStopIndex + 1
            : constraint.targetStopIndex,
        }));
        break;
      }
      case "REMOVE_STOP": {
        if (operation.index >= draft.stops.length) throw new Error("删除的目的地下标不存在");
        draft.stops.splice(operation.index, 1);
        constraints = constraints
          .filter((constraint) => constraint.type === "DEPART_AT" || constraint.targetStopIndex !== operation.index)
          .map((constraint) => ({
            ...constraint,
            targetStopIndex: constraint.type === "ARRIVE_BY" && constraint.targetStopIndex > operation.index
              ? constraint.targetStopIndex - 1
              : constraint.targetStopIndex,
          }));
        break;
      }
      case "REPLACE_STOP":
        if (operation.index >= draft.stops.length) throw new Error("替换的目的地下标不存在");
        draft.stops[operation.index] = changedPlaceDraft(operation.place, operation.index, base);
        break;
      case "MOVE_STOP": {
        if (operation.fromIndex >= draft.stops.length || operation.toIndex >= draft.stops.length) {
          throw new Error("移动的目的地下标不存在");
        }
        const [place] = draft.stops.splice(operation.fromIndex, 1);
        draft.stops.splice(operation.toIndex, 0, place);
        constraints = constraints.map((constraint) => ({
          ...constraint,
          targetStopIndex: constraint.type === "ARRIVE_BY" ? remapForMove(
            constraint.targetStopIndex,
            operation.fromIndex,
            operation.toIndex,
          ) : 0,
        }));
        break;
      }
      case "SET_TIME_CONSTRAINT":
        if (operation.index > constraints.length) throw new Error("时间约束下标不连续");
        if (operation.index === constraints.length) constraints.push({ ...operation.constraint });
        else constraints[operation.index] = { ...operation.constraint };
        break;
      case "REMOVE_TIME_CONSTRAINT":
        if (operation.index >= constraints.length) throw new Error("删除的时间约束下标不存在");
        constraints.splice(operation.index, 1);
        break;
      case "SET_PRECONDITION": {
        const preferences = new Set(draft.preferences);
        if (operation.enabled) preferences.add("precondition_vehicle");
        else preferences.delete("precondition_vehicle");
        draft.preferences = [...preferences];
        break;
      }
      case "REWRITE": {
        const raw = operation.intent;
        const rewriteBase = structuredClone(base);
        const rewriteConstraints = raw.timeConstraints?.length
          ? raw.timeConstraints
          : raw.timeConstraint ? [raw.timeConstraint] : [];
        draft = {
          rawText: options.rawText,
          date: raw.date,
          city: raw.city,
          origin: changedPlaceDraft(raw.origin, -1, rewriteBase),
          stops: raw.stops.map((place, index) => changedPlaceDraft(place, index, rewriteBase)),
          timeConstraint: { ...rewriteConstraints.at(-1)! },
          timeConstraints: rewriteConstraints.map((constraint) => ({ ...constraint })),
          preferences: [...new Set(raw.preferences)],
          confidence: raw.confidence,
          issues: [...new Set(raw.issues)],
        };
        constraints = normalizedConstraints(draft);
        break;
      }
    }
  }

  draft.rawText = options.rawText;
  draft.timeConstraints = constraints;
  if (constraints.length > 0) draft.timeConstraint = { ...constraints.at(-1)! };
  draft.confidence = Math.max(0, Math.min(1, draft.confidence));
  draft.issues = [];
  draft.understanding = {
    provider: options.provider,
    model: options.model,
    fallback: options.fallback,
  };
  validateIntentAfterOperations(draft);
  return draft;
}
