import { NextResponse } from "next/server";
import { z } from "zod";

import { getWeather, planRouteLeg, ProviderError } from "@/lib/amap";
import { buildTripPlan } from "@/lib/planner";
import type { DemoOverrides, TripIntentDraft } from "@/lib/types";

const RequestSchema = z.object({
  intent: z.object({
    date: z.string(),
    city: z.string(),
    origin: z.object({ resolved: z.object({ location: z.object({ lng: z.number(), lat: z.number() }) }).passthrough() }).passthrough(),
    stops: z.array(z.object({ resolved: z.object({ location: z.object({ lng: z.number(), lat: z.number() }) }).passthrough() }).passthrough()).min(1).max(3),
    timeConstraint: z.object({ type: z.enum(["ARRIVE_BY", "DEPART_AT"]), time: z.string(), targetStopIndex: z.number() }).passthrough(),
  }).passthrough(),
  overrides: z.object({
    weatherOverrideEnabled: z.boolean(),
    condition: z.string(),
    temperatureC: z.number(),
    batteryOverrideEnabled: z.boolean(),
    batteryPercent: z.number(),
  }).optional(),
});

export async function POST(request: Request) {
  const payload = RequestSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json(
      { error: "行程信息不完整，请确认所有地点。", code: "INVALID_TRIP", retryable: false },
      { status: 400 },
    );
  }

  const intent = payload.data.intent as unknown as TripIntentDraft;
  const overrides = payload.data.overrides as DemoOverrides | undefined;
  try {
    const points = [intent.origin.resolved!, ...intent.stops.map((stop) => stop.resolved!)];
    const legs = await Promise.all(
      points.slice(0, -1).map((from, index) => planRouteLeg(from, points[index + 1])),
    );
    const weather = await getWeather(
      intent.origin.resolved!.adcode,
      intent.date,
      intent.timeConstraint.time,
    );
    return NextResponse.json(buildTripPlan(intent, legs, weather, overrides));
  } catch (error) {
    if (error instanceof ProviderError) {
      return NextResponse.json(
        { error: error.message, code: error.code, retryable: error.retryable },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成行程时发生未知错误。", code: "PLAN_UNKNOWN", retryable: true },
      { status: 500 },
    );
  }
}
