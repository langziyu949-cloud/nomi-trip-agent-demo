import { formatClock, toShanghaiDate } from "@/lib/date-utils";
import type {
  DemoOverrides,
  ProactiveAction,
  RouteLeg,
  TripIntentDraft,
  TripPlan,
  TripStopPlan,
  WeatherContext,
} from "@/lib/types";

const DWELL_TIME_SEC = 5 * 60;
const BATTERY_CAPACITY_KWH = 100;
const BASE_CONSUMPTION_KWH_PER_100KM = 20;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function action(
  type: ProactiveAction["type"],
  title: string,
  detail: string,
  severity: ProactiveAction["severity"],
  scheduledAt: Date | null = null,
): ProactiveAction {
  return {
    id: `${type.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    title,
    detail,
    severity,
    scheduledAt: scheduledAt?.toISOString() ?? null,
  };
}

export function buildTripPlan(
  intent: TripIntentDraft,
  legs: RouteLeg[],
  rawWeather: WeatherContext,
  overrides?: DemoOverrides,
): TripPlan {
  if (legs.length !== intent.stops.length) {
    throw new Error("路线分段数量与目的地数量不一致。 ");
  }

  const weather: WeatherContext = overrides?.enabled
    ? {
        available: true,
        condition: overrides.condition,
        temperatureC: rawWeather.temperatureC,
        humidity: rawWeather.humidity,
        reportTime: new Date().toISOString(),
        source: "override",
      }
    : rawWeather;

  const constraints = intent.timeConstraints?.length
    ? intent.timeConstraints
    : [intent.timeConstraint];
  const arrivalConstraints = constraints
    .filter((constraint) => constraint.type === "ARRIVE_BY")
    .map((constraint) => ({
      ...constraint,
      targetStopIndex: clamp(constraint.targetStopIndex, 0, Math.max(0, legs.length - 1)),
    }))
    .sort((left, right) => left.targetStopIndex - right.targetStopIndex || left.time.localeCompare(right.time))
    .filter((constraint, index, all) => index === all.findIndex(
      (candidate) => candidate.targetStopIndex === constraint.targetStopIndex,
    ));
  const explicitDeparture = constraints.find((constraint) => constraint.type === "DEPART_AT");
  const arrivalsMs = new Array<number>(legs.length).fill(0);
  const departuresMs = new Array<number | null>(legs.length).fill(null);
  const scheduleConflicts: string[] = [];

  const segmentTravelSec = (startLeg: number, targetLeg: number) => legs
    .slice(startLeg, targetLeg + 1)
    .reduce((total, leg) => total + leg.durationSec, 0);
  const segmentBufferSec = (startLeg: number, targetLeg: number) => Math.max(
    5 * 60,
    Math.ceil(segmentTravelSec(startLeg, targetLeg) * 0.1 / 60) * 60,
  );
  const scheduleRange = (startLeg: number, targetLeg: number, startMs: number) => {
    let cursorMs = startMs;
    for (let index = startLeg; index <= targetLeg; index += 1) {
      cursorMs += legs[index].durationSec * 1_000;
      arrivalsMs[index] = cursorMs;
      if (index < targetLeg) {
        cursorMs += DWELL_TIME_SEC * 1_000;
        departuresMs[index] = cursorMs;
      }
    }
  };

  const planningBufferSec = segmentBufferSec(0, Math.max(0, arrivalConstraints[0]?.targetStopIndex ?? 0));
  let departureMs: number;

  if (arrivalConstraints.length > 0) {
    const first = arrivalConstraints[0];
    const firstTarget = first.targetStopIndex;
    const firstDeadlineMs = toShanghaiDate(intent.date, first.time).getTime();
    const firstRouteSec = segmentTravelSec(0, firstTarget) + firstTarget * DWELL_TIME_SEC;
    const latestDepartureMs = firstDeadlineMs - (firstRouteSec + planningBufferSec) * 1_000;
    departureMs = explicitDeparture
      ? toShanghaiDate(intent.date, explicitDeparture.time).getTime()
      : latestDepartureMs;
    scheduleRange(0, firstTarget, departureMs);
    if (arrivalsMs[firstTarget] > firstDeadlineMs) {
      scheduleConflicts.push(`${first.time} 前无法到达第 ${firstTarget + 1} 站`);
    }

    let previousTarget = firstTarget;
    for (const constraint of arrivalConstraints.slice(1)) {
      if (constraint.targetStopIndex <= previousTarget) continue;
      const target = constraint.targetStopIndex;
      const bufferSec = segmentBufferSec(previousTarget + 1, target);
      const internalDwellSec = Math.max(0, target - previousTarget - 1) * DWELL_TIME_SEC;
      const deadlineMs = toShanghaiDate(intent.date, constraint.time).getTime();
      let segmentDepartureMs = deadlineMs -
        (segmentTravelSec(previousTarget + 1, target) + internalDwellSec + bufferSec) * 1_000;
      const earliestSegmentDepartureMs = arrivalsMs[previousTarget] + DWELL_TIME_SEC * 1_000;

      if (segmentDepartureMs < earliestSegmentDepartureMs) {
        const shiftMs = earliestSegmentDepartureMs - segmentDepartureMs;
        if (!explicitDeparture) {
          departureMs -= shiftMs;
          for (let index = 0; index <= previousTarget; index += 1) {
            arrivalsMs[index] -= shiftMs;
            if (departuresMs[index] !== null) departuresMs[index]! -= shiftMs;
          }
        } else {
          segmentDepartureMs = earliestSegmentDepartureMs;
          scheduleConflicts.push(`${constraint.time} 前无法到达第 ${target + 1} 站`);
        }
      }

      departuresMs[previousTarget] = segmentDepartureMs;
      scheduleRange(previousTarget + 1, target, segmentDepartureMs);
      previousTarget = target;
    }

    if (previousTarget < legs.length - 1) {
      const continuationMs = arrivalsMs[previousTarget] + DWELL_TIME_SEC * 1_000;
      departuresMs[previousTarget] = continuationMs;
      scheduleRange(previousTarget + 1, legs.length - 1, continuationMs);
    }
  } else {
    departureMs = toShanghaiDate(intent.date, explicitDeparture?.time ?? intent.timeConstraint.time).getTime();
    scheduleRange(0, legs.length - 1, departureMs);
  }

  const departure = new Date(departureMs);
  const stops: TripStopPlan[] = legs.map((leg, index) => {
    const departureAfterStop = departuresMs[index];
    return {
      place: leg.to,
      eta: formatClock(new Date(arrivalsMs[index])),
      dateTime: new Date(arrivalsMs[index]).toISOString(),
      departureTime: departureAfterStop === null ? null : formatClock(new Date(departureAfterStop)),
      departureDateTime: departureAfterStop === null ? null : new Date(departureAfterStop).toISOString(),
      dwellSec: departureAfterStop === null
        ? 0
        : Math.max(0, Math.round((departureAfterStop - arrivalsMs[index]) / 1_000)),
    };
  });

  const totalDistanceM = legs.reduce((total, leg) => total + leg.distanceM, 0);
  const totalDurationSec = Math.max(
    0,
    Math.round(((arrivalsMs.at(-1) ?? departureMs) - departureMs) / 1_000),
  );
  const outsideTemperatureC = weather.temperatureC;
  const outsideExtremeTemperature =
    outsideTemperatureC !== null && (outsideTemperatureC <= 10 || outsideTemperatureC >= 30);
  const cabinTemperatureC = overrides?.enabled ? overrides.cabinTemperatureC : 24;
  const climateTemperatureC = overrides?.enabled ? cabinTemperatureC : outsideTemperatureC;
  const climateNeedsPreparation =
    climateTemperatureC !== null && (climateTemperatureC <= 10 || climateTemperatureC >= 30);
  const preconditioningEnabled = intent.preferences.includes("precondition_vehicle");
  const consumption = BASE_CONSUMPTION_KWH_PER_100KM * (outsideExtremeTemperature ? 1.15 : 1);
  const preconditioningKwh = preconditioningEnabled && climateNeedsPreparation ? 1.5 : 0;
  const energyUsedKwh = (totalDistanceM / 1000 / 100) * consumption + preconditioningKwh;
  const batteryPercent = clamp(overrides?.enabled ? overrides.batteryPercent : 42, 0, 100);
  const estimatedArrivalBattery = clamp(
    Math.round((batteryPercent - (energyUsedKwh / BATTERY_CAPACITY_KWH) * 100) * 10) / 10,
    0,
    100,
  );
  const actions: ProactiveAction[] = [];
  const temperatureLabel = overrides?.enabled ? "当前座舱" : "室外";
  if (preconditioningEnabled && climateTemperatureC !== null && climateTemperatureC <= 10) {
    const scheduled = new Date(departure.getTime() - 15 * 60 * 1000);
    actions.push(
      action("PREHEAT", "提前温暖座舱", `${temperatureLabel} ${climateTemperatureC}°C，将在出发前 15 分钟开启暖风。`, "suggestion", scheduled),
      action("SEAT_HEAT", "开启座椅加热", "将在出发前开启，上车后自动调低。", "info", scheduled),
    );
  } else if (preconditioningEnabled && climateTemperatureC !== null && climateTemperatureC >= 30) {
    const scheduled = new Date(departure.getTime() - 12 * 60 * 1000);
    actions.push(
      action("PRECOOL", "提前清凉座舱", `${temperatureLabel} ${climateTemperatureC}°C，将在出发前 12 分钟开启制冷。`, "suggestion", scheduled),
    );
  }

  if (/雨|雪|雷/.test(weather.condition)) {
    actions.push(
      action("DEFOG", "准备除雾", `${weather.condition}天气，将在出发前开启前挡除雾。`, "suggestion", new Date(departure.getTime() - 8 * 60 * 1000)),
      action("UMBRELLA", "别忘了雨具", "已在出发清单中加入雨具提醒。", "info", new Date(departure.getTime() - 20 * 60 * 1000)),
    );
  }

  actions.push(
    action(
      "LEAVE_BUFFER",
      "预留路况缓冲",
      `基于当前路线增加 ${Math.round(planningBufferSec / 60)} 分钟缓冲。`,
      "info",
      departure,
    ),
  );

  if (estimatedArrivalBattery < 10) {
    actions.push(action("ENERGY_CRITICAL", "电量无法覆盖行程", "建议出发前补能或调整路线。", "critical"));
  } else if (estimatedArrivalBattery < 20) {
    actions.push(action("ENERGY_LOW", "建议安排补能", "预计到达电量低于 20%，可在行程后安排充换电。", "warning"));
  }

  const notes = ["路线耗时基于高德当前推荐路线，不代表未来实时路况。"];
  if (constraints.length > 1) notes.push("已根据多个到达时间倒推各段最晚出发时间。 ");
  notes.push(...scheduleConflicts.map((message) => `时间约束冲突：${message}。`));
  if (!weather.available) notes.push("目标日期暂无可靠天气，未基于温度生成空调建议。 ");
  if (weather.source === "override") notes.push("天气状况、座舱温度与车况使用 Demo Lab 演示数据；室外温度仍来自高德。 ");

  return {
    id: `trip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    intent,
    departureAt: departure.toISOString(),
    departureTime: formatClock(departure),
    totalDistanceM,
    totalDurationSec,
    planningBufferSec,
    legs,
    stops,
    weather,
    vehicle: {
      batteryPercent,
      estimatedArrivalBattery,
      cabinTemperatureC,
      consumptionKwhPer100Km: consumption,
      batteryCapacityKwh: BATTERY_CAPACITY_KWH,
      source: overrides?.enabled ? "override" : "mock",
    },
    actions,
    notes,
  };
}
