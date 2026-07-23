import { z } from "zod";

import type { TripIntentDraft } from "@/lib/types";

const CalendarDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期必须使用 YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day;
  }, "日期不是有效的日历日期");

const ClockTimeSchema = z.string().regex(
  /^([01]\d|2[0-3]):[0-5]\d$/,
  "时间必须使用 24 小时制 HH:mm",
);

export const ResolvedPlaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  address: z.string(),
  district: z.string(),
  adcode: z.string(),
  location: z.object({
    lng: z.number().finite(),
    lat: z.number().finite(),
  }).strict(),
  source: z.enum(["FAVORITE", "AMAP"]),
}).strict();

export const PlaceDraftSchema = z.object({
  key: z.string().min(1).max(160),
  label: z.string().min(1).max(160),
  query: z.string().min(1).max(160),
  resolved: ResolvedPlaceSchema.nullable(),
}).strict();

export const TimeConstraintSchema = z.object({
  type: z.enum(["ARRIVE_BY", "DEPART_AT"]),
  time: ClockTimeSchema,
  targetStopIndex: z.number().int().min(0).max(2),
  inferred: z.boolean(),
}).strict();

const IntentUnderstandingSchema = z.object({
  provider: z.enum(["mock", "minimax"]),
  model: z.string().nullable(),
  fallback: z.boolean(),
}).strict();

export const TripIntentDraftSchema = z.object({
  rawText: z.string().max(4_000),
  date: CalendarDateSchema,
  city: z.string().trim().min(1).max(40),
  origin: PlaceDraftSchema,
  stops: z.array(PlaceDraftSchema).max(3),
  timeConstraint: TimeConstraintSchema,
  timeConstraints: z.array(TimeConstraintSchema).min(1).max(3).optional(),
  preferences: z.array(z.string().trim().min(1).max(80)).max(12),
  confidence: z.number().min(0).max(1),
  issues: z.array(z.string().trim().min(1).max(240)).max(12),
  understanding: IntentUnderstandingSchema.optional(),
}).strict().superRefine((intent, context) => {
  const constraints = intent.timeConstraints?.length
    ? intent.timeConstraints
    : [intent.timeConstraint];
  constraints.forEach((constraint, index) => {
    if (intent.stops.length === 0 && constraint.targetStopIndex !== 0) {
      context.addIssue({
        code: "custom",
        path: ["timeConstraints", index, "targetStopIndex"],
        message: "没有站点时目标站下标必须为 0",
      });
    }
    if (intent.stops.length > 0 && constraint.targetStopIndex >= intent.stops.length) {
      context.addIssue({
        code: "custom",
        path: ["timeConstraints", index, "targetStopIndex"],
        message: "目标站下标超出 stops 范围",
      });
    }
    if (constraint.type === "DEPART_AT" && constraint.targetStopIndex !== 0) {
      context.addIssue({
        code: "custom",
        path: ["timeConstraints", index, "targetStopIndex"],
        message: "DEPART_AT 的目标站下标必须为 0",
      });
    }
  });
});

export const ConversationPlanFactsSchema = z.object({
  tripDate: CalendarDateSchema,
  plannedAt: z.string().datetime(),
  origin: z.string().min(1).max(160),
  departureTime: ClockTimeSchema,
  stops: z.array(z.object({
    name: z.string().min(1).max(160),
    eta: ClockTimeSchema,
    departureTime: ClockTimeSchema.nullable(),
    dwellMinutes: z.number().int().min(0).max(1_440),
  }).strict()).min(1).max(3),
  totalDistanceKm: z.number().finite().min(0),
  totalDurationMinutes: z.number().int().min(0),
  planningBufferMinutes: z.number().int().min(0),
  weather: z.object({
    available: z.boolean(),
    condition: z.string().max(80),
    temperatureC: z.number().finite().nullable(),
    humidity: z.number().finite().nullable(),
    reportTime: z.string().nullable(),
    source: z.enum(["live", "forecast", "override", "unavailable"]),
  }).strict(),
  vehicle: z.object({
    batteryPercent: z.number().finite().min(0).max(100),
    estimatedArrivalBattery: z.number().finite().min(0).max(100),
    cabinTemperatureC: z.number().finite(),
  }).strict(),
  actions: z.array(z.object({
    type: z.string().min(1).max(80),
    title: z.string().min(1).max(160),
    detail: z.string().max(500),
    scheduledTime: ClockTimeSchema.nullable(),
  }).strict()).max(20),
  notes: z.array(z.string().max(500)).max(20),
}).strict();

export type ConversationPlanFacts = z.infer<typeof ConversationPlanFactsSchema>;

export const ConversationPlanFreshnessSchema = z.object({
  status: z.enum(["MISSING", "SNAPSHOT", "FRESH"]),
  updatedAt: z.string().datetime().nullable(),
  refreshedForTurnId: z.string().min(1).max(120).nullable().optional(),
}).strict();

export type ConversationPlanFreshness = z.infer<typeof ConversationPlanFreshnessSchema>;

export const ConversationHistoryItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(4_000),
}).strict();

export type ConversationHistoryItem = z.infer<typeof ConversationHistoryItemSchema>;

export const ConversationTurnRequestSchema = z.object({
  conversationId: z.string().trim().min(1).max(120),
  turnId: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1).max(2_000),
  now: z.string().datetime().optional(),
  currentIntent: TripIntentDraftSchema.nullable().optional(),
  pendingIntent: TripIntentDraftSchema.nullable().optional(),
  planFacts: ConversationPlanFactsSchema.nullable().optional(),
  planFreshness: ConversationPlanFreshnessSchema.optional(),
  history: z.array(ConversationHistoryItemSchema).max(20).default([]),
}).strict().superRefine((request, context) => {
  const characterCount = request.history.reduce(
    (sum, message) => sum + message.content.length,
    0,
  );
  if (characterCount > 12_000) {
    context.addIssue({
      code: "custom",
      path: ["history"],
      message: "最近消息总长度不能超过 12000 字符",
    });
  }
});

export type ConversationTurnRequest = z.infer<typeof ConversationTurnRequestSchema>;

export const ConversationTurnMetaSchema = z.object({
  provider: z.enum(["minimax", "rules", "mock"]),
  model: z.string().nullable(),
  fallback: z.boolean(),
}).strict();

export type ConversationTurnMeta = z.infer<typeof ConversationTurnMetaSchema>;

const ConversationResponseBaseSchema = z.object({
  conversationId: z.string(),
  turnId: z.string(),
  text: z.string().trim().min(1).max(2_000),
  meta: ConversationTurnMetaSchema,
});

export const PlanChangeTurnResponseSchema = ConversationResponseBaseSchema.extend({
  type: z.literal("PLAN_CHANGE"),
  intent: TripIntentDraftSchema,
}).strict();

export const AnswerTurnResponseSchema = ConversationResponseBaseSchema.extend({
  type: z.literal("ANSWER"),
}).strict();

export const ClarifyTurnResponseSchema = ConversationResponseBaseSchema.extend({
  type: z.literal("CLARIFY"),
  intent: TripIntentDraftSchema.optional(),
  reason: z.enum([
    "MISSING_CONTEXT",
    "AMBIGUOUS_CHANGE",
    "INVALID_CHANGE",
    "UNSUPPORTED",
  ]),
}).strict();

export const RefreshRequiredTurnResponseSchema = ConversationResponseBaseSchema.extend({
  type: z.literal("REFRESH_REQUIRED"),
  refresh: z.object({
    route: z.boolean(),
    weather: z.boolean(),
  }).strict(),
}).strict();

export const ConversationTurnResponseSchema = z.discriminatedUnion("type", [
  PlanChangeTurnResponseSchema,
  AnswerTurnResponseSchema,
  ClarifyTurnResponseSchema,
  RefreshRequiredTurnResponseSchema,
]);

export type ConversationTurnResponse = z.infer<typeof ConversationTurnResponseSchema>;

// Keep the public type tied to the domain interface without forcing callers to
// import Zod internals.
const _tripIntentCompatibility: TripIntentDraft = {} as z.infer<typeof TripIntentDraftSchema>;
void _tripIntentCompatibility;
