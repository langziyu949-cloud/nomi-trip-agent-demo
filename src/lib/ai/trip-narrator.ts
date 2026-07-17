import type { TripNarrationResponse, TripPlan } from "@/lib/types";

export interface TripNarrator {
  narrate(plan: TripPlan): Promise<TripNarrationResponse>;
}

export function buildTemplateNarration(
  plan: TripPlan,
  options: { fallback?: boolean; errorCode?: string; fallbackReason?: string } = {},
): TripNarrationResponse {
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

  return {
    text: `建议 ${plan.departureTime} 从${plan.intent.origin.resolved?.name ?? plan.intent.origin.query}出发，${firstStop.eta} 到${firstStop.place.name}。${timingText}${automationText}${umbrellaText}${energyText}${bufferText}`,
    provider: "template",
    model: null,
    generatedAt: new Date().toISOString(),
    fallback: options.fallback ?? false,
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    ...(options.fallbackReason ? { fallbackReason: options.fallbackReason } : {}),
  };
}

export class TemplateTripNarrator implements TripNarrator {
  async narrate(plan: TripPlan): Promise<TripNarrationResponse> {
    return buildTemplateNarration(plan);
  }
}
