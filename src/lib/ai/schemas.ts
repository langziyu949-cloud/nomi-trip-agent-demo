import { z } from "zod";

const CalendarDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期必须使用 YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }, "日期不是有效的日历日期");

const ClockTimeSchema = z.string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间必须使用 24 小时制 HH:mm");

export const MiniMaxRawPlaceSchema = z.object({
  kind: z.enum(["FAVORITE_OR_QUERY", "FAVORITE", "QUERY"])
    .transform(() => "FAVORITE_OR_QUERY" as const),
  favoriteKey: z.enum(["home", "company", "school", "wifeCompany"]).nullable(),
  query: z.string().trim().min(1).max(80).nullable(),
}).strict().superRefine((value, context) => {
  if (value.favoriteKey === null && value.query === null) {
    context.addIssue({
      code: "custom",
      path: ["query"],
      message: "非收藏地点必须保留查询词",
    });
  }
});

const MiniMaxRawTimeConstraintSchema = z.object({
  type: z.enum(["ARRIVE_BY", "DEPART_AT"]),
  time: ClockTimeSchema,
  targetStopIndex: z.number().int().min(0),
  inferred: z.boolean(),
}).strict();

export const MiniMaxRawIntentSchema = z.object({
  date: CalendarDateSchema,
  city: z.literal("上海市"),
  origin: MiniMaxRawPlaceSchema,
  stops: z.array(MiniMaxRawPlaceSchema).max(3),
  timeConstraint: MiniMaxRawTimeConstraintSchema.optional(),
  timeConstraints: z.array(MiniMaxRawTimeConstraintSchema).min(1).max(3).optional(),
  preferences: z.array(z.enum(["precondition_vehicle", "avoid_congestion"])).max(4),
  confidence: z.number().min(0).max(1),
  issues: z.array(z.string().trim().min(1).max(120)).max(6),
}).strict().superRefine((value, context) => {
  const constraints = value.timeConstraints?.length
    ? value.timeConstraints
    : value.timeConstraint ? [value.timeConstraint] : [];
  if (constraints.length === 0) {
    context.addIssue({ code: "custom", path: ["timeConstraints"], message: "至少需要一个时间约束" });
  }
  constraints.forEach((constraint, index) => {
    const pathRoot = value.timeConstraints?.length ? ["timeConstraints", index] : ["timeConstraint"];
    if (value.stops.length > 0 && constraint.targetStopIndex >= value.stops.length) {
      context.addIssue({
        code: "custom",
        path: [...pathRoot, "targetStopIndex"],
        message: "目标站下标超出 stops 范围",
      });
    }
    if (value.stops.length === 0 && constraint.targetStopIndex !== 0) {
      context.addIssue({
        code: "custom",
        path: [...pathRoot, "targetStopIndex"],
        message: "没有站点时目标站下标必须为 0",
      });
    }
    if (constraint.type === "DEPART_AT" && constraint.targetStopIndex !== 0) {
      context.addIssue({
        code: "custom",
        path: [...pathRoot, "targetStopIndex"],
        message: "DEPART_AT 的目标下标必须为 0",
      });
    }
  });
});

export type MiniMaxRawIntent = z.infer<typeof MiniMaxRawIntentSchema>;

export const TripPlanNarrationRequestSchema = z.object({
  userText: z.string().trim().min(1).max(2_000).optional(),
  mode: z.enum(["initial", "update"]).optional(),
  plan: z.object({
    intent: z.object({
      date: CalendarDateSchema,
      origin: z.object({
        label: z.string().min(1).max(80),
        query: z.string().min(1),
        resolved: z.object({ name: z.string().min(1) }).passthrough().nullable(),
      }).passthrough(),
      stops: z.array(z.object({
        label: z.string().min(1).max(80),
        query: z.string().min(1).max(80),
      }).passthrough()).min(1).max(3),
      timeConstraint: MiniMaxRawTimeConstraintSchema,
      timeConstraints: z.array(MiniMaxRawTimeConstraintSchema).min(1).max(3).optional(),
    }).passthrough(),
    departureTime: ClockTimeSchema,
    planningBufferSec: z.number().int().min(0),
    stops: z.array(z.object({
      place: z.object({ name: z.string().min(1) }).passthrough(),
      eta: ClockTimeSchema,
      dateTime: z.string().datetime({ offset: true }),
      departureTime: ClockTimeSchema.nullable().optional(),
      dwellSec: z.number().int().min(0),
    }).passthrough()).min(1).max(3),
    weather: z.object({
      available: z.boolean(),
      condition: z.string(),
      temperatureC: z.number().nullable(),
      source: z.string(),
    }).passthrough(),
    vehicle: z.object({
      batteryPercent: z.number().min(0).max(100),
      estimatedArrivalBattery: z.number().min(0).max(100),
      cabinTemperatureC: z.number(),
    }).passthrough(),
    actions: z.array(z.object({
      type: z.string(),
      title: z.string(),
      detail: z.string(),
      severity: z.enum(["info", "suggestion", "warning", "critical"]),
      scheduledAt: z.string().nullable(),
    }).passthrough()).max(20),
  }).passthrough(),
}).strict();

export function extractJsonObjects(content: string): unknown[] {
  const withoutReasoning = content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .trim();
  const fenced = withoutReasoning.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced ?? withoutReasoning;
  const objects: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          objects.push(JSON.parse(candidate.slice(start, index + 1)));
        } catch {
          // Keep scanning: a later complete object may be the final answer.
        }
        start = -1;
      }
    }
  }

  if (objects.length === 0) throw new Error("没有找到完整、合法的 JSON 对象");
  return objects;
}
