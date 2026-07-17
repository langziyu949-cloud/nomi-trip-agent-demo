"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AmapMap } from "@/components/AmapMap";
import {
  ArrowIcon,
  BatteryIcon,
  ClockIcon,
  CloseIcon,
  EditIcon,
  RouteIcon,
  SettingsIcon,
  SparkIcon,
  WeatherIcon,
} from "@/components/icons";
import { formatChineseDate } from "@/lib/date-utils";
import { DEFAULT_PLACES } from "@/lib/default-places";
import type {
  Coordinates,
  DemoSettings,
  DemoStage,
  FavoritePlaceKey,
  PlaceDraft,
  PlaceSearchResponse,
  ProviderErrorPayload,
  ResolvedPlace,
  TripIntentDraft,
  TripNarrationResponse,
  TripPlan,
} from "@/lib/types";

const SAMPLE_PROMPT = "明早 8 点送孩子到学校，然后去公司，提前准备一下。";
const SIMULATION_DURATION_SEC = 15;

const FAVORITE_PLACE_LABELS: Record<FavoritePlaceKey, string> = {
  home: "家",
  company: "我的公司",
  school: "儿子学校",
  wifeCompany: "老婆公司",
};

const FAVORITE_PLACE_KEYS = Object.keys(FAVORITE_PLACE_LABELS) as FavoritePlaceKey[];

const DEFAULT_SETTINGS: DemoSettings = {
  enabled: false,
  condition: "小雪",
  batteryPercent: 42,
  cabinTemperatureC: 8,
  preconditionVehicle: true,
  favoritePlaces: DEFAULT_PLACES,
};

interface HealthResponse {
  ready: boolean;
  providers: {
    amapWebService: boolean;
    amapJsApi: boolean;
    amapSecurityCode: boolean;
  };
  ai: {
    intentParserProvider: "mock" | "minimax" | "invalid";
    tripNarratorProvider: "template" | "minimax" | "invalid";
    minimax: {
      selected: boolean;
      configured: boolean;
      model: string | null;
      missing: string[];
    };
  };
}

interface ResolutionTarget {
  type: "origin" | "stop";
  index: number;
  query: string;
}

interface SimulationSnapshot {
  stage: DemoStage;
  activeLegIndex: number;
  position: Coordinates | null;
  driveProgress: number;
  arrivedStopIndex: number | null;
}

function isFavoritePlaceKey(value: string): value is FavoritePlaceKey {
  return FAVORITE_PLACE_KEYS.includes(value as FavoritePlaceKey);
}

function normalizeSettings(value: Partial<DemoSettings> | null): DemoSettings {
  const legacyTemperature = (value as Partial<DemoSettings> & { temperatureC?: number } | null)?.temperatureC;
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    cabinTemperatureC: value?.cabinTemperatureC ?? legacyTemperature ?? DEFAULT_SETTINGS.cabinTemperatureC,
    preconditionVehicle: value?.preconditionVehicle ?? true,
    favoritePlaces: {
      ...DEFAULT_PLACES,
      ...(value?.favoritePlaces ?? {}),
    },
  };
}

function applySettingsToIntent(intent: TripIntentDraft, settings: DemoSettings): TripIntentDraft {
  const next = structuredClone(intent);
  const applyFavorite = (place: PlaceDraft) => {
    if (!isFavoritePlaceKey(place.key)) return;
    place.resolved = settings.favoritePlaces[place.key];
    place.label = FAVORITE_PLACE_LABELS[place.key];
    place.query = FAVORITE_PLACE_LABELS[place.key];
  };
  applyFavorite(next.origin);
  next.stops.forEach(applyFavorite);
  next.preferences = settings.preconditionVehicle
    ? [...new Set([...next.preferences, "precondition_vehicle"])]
    : next.preferences.filter((item) => item !== "precondition_vehicle");
  return next;
}

class ApiError extends Error {
  constructor(
    message: string,
    public readonly code = "UNKNOWN",
    public readonly retryable = true,
  ) {
    super(message);
  }
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json()) as T | ProviderErrorPayload;
  if (!response.ok) {
    const error = body as ProviderErrorPayload;
    throw new ApiError(error.error ?? "请求失败，请稍后重试。", error.code, error.retryable);
  }
  return body as T;
}

function findUnresolved(intent: TripIntentDraft): ResolutionTarget | null {
  if (!intent.origin.resolved) {
    return { type: "origin", index: -1, query: intent.origin.query };
  }
  const index = intent.stops.findIndex((stop) => !stop.resolved);
  if (index >= 0) return { type: "stop", index, query: intent.stops[index].query };
  return null;
}

function updatePlaceDraft(place: PlaceDraft, query: string): PlaceDraft {
  if (place.resolved && query === place.resolved.name) return { ...place, query, label: query };
  return {
    ...place,
    key: `custom-${Date.now()}-${query}`,
    label: query,
    query,
    resolved: null,
  };
}

function updatePrimaryTimeConstraint(
  draft: TripIntentDraft,
  updater: (constraint: TripIntentDraft["timeConstraint"]) => void,
) {
  updater(draft.timeConstraint);
  if (draft.timeConstraints?.length) {
    draft.timeConstraints[draft.timeConstraints.length - 1] = { ...draft.timeConstraint };
  }
}

function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

function interpolate(points: Coordinates[], progress: number): Coordinates | null {
  if (points.length === 0) return null;
  if (points.length === 1) return points[0];
  const value = Math.min(1, Math.max(0, progress)) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(value));
  const local = value - index;
  return {
    lng: points[index].lng + (points[index + 1].lng - points[index].lng) * local,
    lat: points[index].lat + (points[index + 1].lat - points[index].lat) * local,
  };
}

function getSimulationSnapshot(plan: TripPlan | null, progress: number): SimulationSnapshot {
  if (!plan) return { stage: "DRAFT", activeLegIndex: 0, position: null, driveProgress: 0, arrivedStopIndex: null };
  const first = plan.legs[0]?.polyline[0] ?? plan.intent.origin.resolved?.location ?? null;
  if (progress <= 0) return { stage: "CONFIRMED", activeLegIndex: 0, position: first, driveProgress: 0, arrivedStopIndex: null };
  const hasPreparationAction = plan.actions.some((item) =>
    ["PREHEAT", "PRECOOL", "SEAT_HEAT", "DEFOG"].includes(item.type),
  );
  if (progress < 0.16) return { stage: hasPreparationAction ? "PRECONDITIONING" : "CONFIRMED", activeLegIndex: 0, position: first, driveProgress: 0, arrivedStopIndex: null };
  if (progress < 0.24) return { stage: "READY", activeLegIndex: 0, position: first, driveProgress: 0, arrivedStopIndex: null };
  if (progress >= 0.96) {
    const lastLeg = plan.legs.at(-1);
    return {
      stage: "COMPLETED",
      activeLegIndex: Math.max(0, plan.legs.length - 1),
      position: lastLeg?.polyline.at(-1) ?? lastLeg?.to.location ?? first,
      driveProgress: 1,
      arrivedStopIndex: plan.legs.length - 1,
    };
  }

  const driveProgress = Math.min(1, Math.max(0, (progress - 0.24) / 0.72));
  const totalRouteDuration = plan.legs.reduce((sum, leg) => sum + Math.max(1, leg.durationSec), 0);
  const targetDuration = driveProgress * totalRouteDuration;
  let elapsed = 0;
  let activeLegIndex = 0;
  let localProgress = 0;
  for (let index = 0; index < plan.legs.length; index += 1) {
    const duration = Math.max(1, plan.legs[index].durationSec);
    if (targetDuration <= elapsed + duration || index === plan.legs.length - 1) {
      activeLegIndex = index;
      localProgress = Math.min(1, Math.max(0, (targetDuration - elapsed) / duration));
      break;
    }
    elapsed += duration;
  }
  const isAtIntermediateStop = localProgress > 0.94 && activeLegIndex < plan.legs.length - 1;
  return {
    stage: isAtIntermediateStop ? "AT_STOP" : "EN_ROUTE",
    activeLegIndex,
    position: interpolate(plan.legs[activeLegIndex].polyline, localProgress),
    driveProgress,
    arrivedStopIndex: isAtIntermediateStop ? activeLegIndex : null,
  };
}

function getSimulatedTime(plan: TripPlan | null, progress: number | null): Date | null {
  if (!plan || progress === null) return null;
  const departureMs = new Date(plan.departureAt).getTime();
  const finalArrivalMs = plan.stops.at(-1)?.dateTime
    ? new Date(plan.stops.at(-1)!.dateTime).getTime()
    : departureMs + plan.totalDurationSec * 1000;
  const scheduledTimes = plan.actions
    .flatMap((item) => item.scheduledAt ? [new Date(item.scheduledAt).getTime()] : [])
    .filter(Number.isFinite);
  const preparationStartMs = scheduledTimes.length
    ? Math.min(departureMs, ...scheduledTimes)
    : departureMs;

  if (progress <= 0.24) {
    const prepProgress = Math.max(0, progress) / 0.24;
    return new Date(preparationStartMs + (departureMs - preparationStartMs) * prepProgress);
  }
  const routeProgress = Math.min(1, Math.max(0, (progress - 0.24) / 0.72));
  return new Date(departureMs + (finalArrivalMs - departureMs) * routeProgress);
}

const STAGE_LABELS: Record<DemoStage, string> = {
  DRAFT: "等待规划",
  PLANNED: "计划已生成",
  CONFIRMED: "行程已确认",
  PRECONDITIONING: "正在准备座舱",
  READY: "车辆已就绪",
  EN_ROUTE: "导航进行中",
  AT_STOP: "已到达途经点",
  COMPLETED: "行程已完成",
};

function NomiOrb({ active }: { active: boolean }) {
  return (
    <div className={`nomi-orb ${active ? "is-active" : ""}`} aria-hidden="true">
      <span className="nomi-orb-core" />
      <span className="nomi-orb-glow" />
    </div>
  );
}

export function Cockpit() {
  const [prompt, setPrompt] = useState(SAMPLE_PROMPT);
  const [intent, setIntent] = useState<TripIntentDraft | null>(null);
  const [plan, setPlan] = useState<TripPlan | null>(null);
  const [narration, setNarration] = useState<TripNarrationResponse | null>(null);
  const [narrating, setNarrating] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState<"parse" | "places" | "plan" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [showLab, setShowLab] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [resolution, setResolution] = useState<ResolutionTarget | null>(null);
  const [candidates, setCandidates] = useState<ResolvedPlace[]>([]);
  const [simulationProgress, setSimulationProgress] = useState<number | null>(null);
  const animationRef = useRef<number | null>(null);
  const narrationRequestRef = useRef(0);

  useEffect(() => {
    fetchJson<HealthResponse>("/api/providers/health").then(setHealth).catch(() => setHealth(null));
    const restoreStorage = window.setTimeout(() => {
      try {
        const savedIntent = window.localStorage.getItem("nomi-demo-intent");
        const savedPlan = window.localStorage.getItem("nomi-demo-plan");
        const savedOverrides = window.localStorage.getItem("nomi-demo-overrides");
        if (savedIntent) setIntent(JSON.parse(savedIntent) as TripIntentDraft);
        if (savedPlan) setPlan(JSON.parse(savedPlan) as TripPlan);
        if (savedOverrides) setSettings(normalizeSettings(JSON.parse(savedOverrides) as Partial<DemoSettings>));
      } catch {
        window.localStorage.removeItem("nomi-demo-plan");
        window.localStorage.removeItem("nomi-demo-intent");
      }
    }, 0);
    return () => {
      window.clearTimeout(restoreStorage);
    };
  }, []);

  useEffect(() => {
    if (intent) window.localStorage.setItem("nomi-demo-intent", JSON.stringify(intent));
  }, [intent]);

  useEffect(() => {
    if (plan) window.localStorage.setItem("nomi-demo-plan", JSON.stringify(plan));
  }, [plan]);

  useEffect(() => {
    window.localStorage.setItem("nomi-demo-overrides", JSON.stringify(settings));
  }, [settings]);

  const requestNarration = useCallback(async (tripPlan: TripPlan) => {
    const requestId = narrationRequestRef.current + 1;
    narrationRequestRef.current = requestId;
    setNarration(null);
    setNarrating(true);
    try {
      const result = await fetchJson<TripNarrationResponse>("/api/trips/narrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: {
            intent: {
              date: tripPlan.intent.date,
              origin: {
                query: tripPlan.intent.origin.query,
                resolved: tripPlan.intent.origin.resolved
                  ? { name: tripPlan.intent.origin.resolved.name }
                  : null,
              },
            },
            departureTime: tripPlan.departureTime,
            planningBufferSec: tripPlan.planningBufferSec,
            stops: tripPlan.stops.map((stop) => ({
              place: { name: stop.place.name },
              eta: stop.eta,
              departureTime: stop.departureTime ?? null,
              dwellSec: stop.dwellSec ?? 0,
            })),
            weather: {
              available: tripPlan.weather.available,
              condition: tripPlan.weather.condition,
              temperatureC: tripPlan.weather.temperatureC,
              source: tripPlan.weather.source,
            },
            vehicle: {
              batteryPercent: tripPlan.vehicle.batteryPercent,
              estimatedArrivalBattery: tripPlan.vehicle.estimatedArrivalBattery,
              cabinTemperatureC: tripPlan.vehicle.cabinTemperatureC,
            },
            actions: tripPlan.actions.map((action) => ({
              type: action.type,
              title: action.title,
              detail: action.detail,
              severity: action.severity,
              scheduledAt: action.scheduledAt,
            })),
          },
        }),
      });
      if (narrationRequestRef.current === requestId) setNarration(result);
    } catch {
      // The deterministic in-page template remains available when narration fails.
      if (narrationRequestRef.current === requestId) setNarration(null);
    } finally {
      if (narrationRequestRef.current === requestId) setNarrating(false);
    }
  }, []);

  const requestPlan = useCallback(async (readyIntent: TripIntentDraft) => {
    const configuredIntent = applySettingsToIntent(readyIntent, settings);
    setLoading("plan");
    setError(null);
    try {
      const result = await fetchJson<TripPlan>("/api/trips/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: configuredIntent, overrides: settings }),
      });
      setIntent(configuredIntent);
      setPlan(result);
      setIsEditing(false);
      setSimulationProgress(null);
      void requestNarration(result);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError : new ApiError("生成计划失败。"));
      setIsEditing(true);
    } finally {
      setLoading(null);
    }
  }, [requestNarration, settings]);

  const resolveOrPlan = useCallback(async (nextIntent: TripIntentDraft) => {
    setIntent(nextIntent);
    const unresolved = findUnresolved(nextIntent);
    if (!unresolved) {
      if (nextIntent.stops.length === 0) {
        setError(new ApiError("请至少添加一个目的地。", "NO_STOPS", false));
        setIsEditing(true);
        return;
      }
      await requestPlan(nextIntent);
      return;
    }
    if (!unresolved.query.trim()) {
      setError(new ApiError("请填写需要搜索的地点名称。", "EMPTY_PLACE", false));
      setIsEditing(true);
      return;
    }
    setLoading("places");
    setError(null);
    try {
      const result = await fetchJson<PlaceSearchResponse>(
        `/api/places/search?q=${encodeURIComponent(unresolved.query)}&city=${encodeURIComponent(nextIntent.city)}`,
      );
      setResolution(unresolved);
      setCandidates(result.candidates);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError : new ApiError("地点搜索失败。"));
      setIsEditing(true);
    } finally {
      setLoading(null);
    }
  }, [requestPlan]);

  const analyzePrompt = async () => {
    if (!prompt.trim()) return;
    setLoading("parse");
    setError(null);
    setIntent(null);
    setPlan(null);
    setNarration(null);
    window.localStorage.removeItem("nomi-demo-intent");
    window.localStorage.removeItem("nomi-demo-plan");
    narrationRequestRef.current += 1;
    setNarrating(false);
    setSimulationProgress(null);
    try {
      const rawParsed = await fetchJson<TripIntentDraft>("/api/intents/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt }),
      });
      const parsed = applySettingsToIntent(rawParsed, settings);
      setIntent(parsed);
      setIsEditing(parsed.issues.length > 0 || parsed.stops.length === 0);
      if (parsed.stops.length > 0 && parsed.issues.length === 0) await resolveOrPlan(parsed);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError : new ApiError("自然语言解析失败。"));
    } finally {
      setLoading((current) => (current === "parse" ? null : current));
    }
  };

  const chooseCandidate = async (place: ResolvedPlace) => {
    if (!intent || !resolution) return;
    const nextIntent = structuredClone(intent);
    if (resolution.type === "origin") {
      nextIntent.origin = { ...nextIntent.origin, query: place.name, label: place.name, resolved: place };
    } else {
      nextIntent.stops[resolution.index] = {
        ...nextIntent.stops[resolution.index],
        query: place.name,
        label: place.name,
        resolved: place,
      };
    }
    setResolution(null);
    setCandidates([]);
    await resolveOrPlan(nextIntent);
  };

  const replaySimulation = () => {
    if (!plan) return;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    const startedAt = performance.now();
    const durationMs = SIMULATION_DURATION_SEC * 1000;
    setSimulationProgress(0);

    const tick = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / durationMs);
      setSimulationProgress(progress);
      if (progress < 1) animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
  }, []);

  const simulation = useMemo(
    () => getSimulationSnapshot(plan, simulationProgress ?? 0),
    [plan, simulationProgress],
  );
  const displayStage: DemoStage = simulationProgress === null ? (plan ? "PLANNED" : "DRAFT") : simulation.stage;
  const currentBattery = plan
    ? Math.max(
        plan.vehicle.estimatedArrivalBattery,
        Math.round((plan.vehicle.batteryPercent - (plan.vehicle.batteryPercent - plan.vehicle.estimatedArrivalBattery) * simulation.driveProgress) * 10) / 10,
      )
    : settings.batteryPercent;

  const nomiMessage = useMemo(() => {
    if (!plan) return "告诉我你的出行安排，我来把时间、路线、天气和车况放在一起。";
    if (displayStage === "PLANNED") {
      if (narration?.text) return narration.text;
      const proactiveCount = plan.actions.filter((item) => item.type !== "LEAVE_BUFFER").length || 1;
      return `计划好了。建议 ${plan.departureTime} 出发，我还准备了 ${proactiveCount} 项主动服务。`;
    }
    if (displayStage === "CONFIRMED") return "行程已确认，我会按计划照顾好出发前的准备。";
    if (displayStage === "PRECONDITIONING") {
      const climate = plan.actions.find((item) => item.type === "PREHEAT" || item.type === "PRECOOL");
      return climate ? `${climate.title}已开始，上车时会刚刚好。` : "正在检查座舱与行程状态。";
    }
    if (displayStage === "READY") return `车辆已经准备好，建议 ${plan.departureTime} 出发。`;
    if (displayStage === "AT_STOP") return `已经到达${plan.legs[simulation.activeLegIndex].to.name}，接下来继续前往下一站。`;
    if (displayStage === "COMPLETED") return `已到达${plan.legs.at(-1)?.to.name}。今天的行程完成了。`;
    return `正在前往${plan.legs[simulation.activeLegIndex]?.to.name ?? "下一站"}，预计 ${plan.stops[simulation.activeLegIndex]?.eta} 到达。`;
  }, [displayStage, narration, plan, simulation.activeLegIndex]);

  const mapWeather = plan?.weather;
  const headerWeatherCondition = settings.enabled ? settings.condition : mapWeather?.condition;
  const headerTemperatureC = settings.enabled ? settings.cabinTemperatureC : mapWeather?.temperatureC;
  const simulatedTime = getSimulatedTime(plan, simulationProgress);
  const simulatedClock = simulatedTime ? new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(simulatedTime) : null;

  const changeIntent = (updater: (draft: TripIntentDraft) => void) => {
    if (!intent) return;
    const next = structuredClone(intent);
    updater(next);
    setIntent(next);
    setPlan(null);
    setNarration(null);
    narrationRequestRef.current += 1;
    setNarrating(false);
    setSimulationProgress(null);
  };

  const amapReady = health
    ? Object.values(health.providers).every(Boolean)
    : false;
  const connectionLabel = health?.ready
    ? "实时服务已连接"
    : amapReady && health?.ai.minimax.selected && !health.ai.minimax.configured
      ? "等待 MiniMax 配置"
      : "等待高德凭证";
  const understandingLabel = intent?.understanding?.provider === "minimax"
    ? "MiniMax 理解"
    : intent?.understanding?.fallback
      ? "规则理解 · 回退"
      : "规则理解";
  const narrationLabel = narrating
    ? "表达生成中"
    : narration?.provider === "minimax"
      ? "MiniMax 表达"
      : narration?.fallback
        ? "模板表达 · 回退"
        : "模板表达";

  return (
    <main className="cockpit">
      <header className="top-bar">
        <div className="brand-lockup">
          <NomiOrb active={loading !== null || narrating || (simulationProgress !== null && simulationProgress < 1)} />
          <div>
            <span className="eyebrow">NOMI EVERYWHERE</span>
            <strong>出行代理</strong>
          </div>
        </div>
        <div className="top-center-status">
          <span className={`provider-dot ${health?.ready ? "is-ready" : ""}`} />
          {connectionLabel}
          {settings.enabled && <em>演示数据</em>}
        </div>
        <div className="system-status">
          <span><WeatherIcon />{headerWeatherCondition && headerTemperatureC !== null && headerTemperatureC !== undefined ? `${headerWeatherCondition} ${headerTemperatureC}°` : "--°"}</span>
          <span><BatteryIcon />{currentBattery.toFixed(currentBattery % 1 ? 1 : 0)}%</span>
          {simulatedClock && <strong className="simulated-clock"><small>模拟</small>{simulatedClock}</strong>}
          <button className="icon-button" onClick={() => setShowLab(true)} aria-label="打开 Demo Lab"><SettingsIcon /></button>
        </div>
      </header>

      <section className="cockpit-main">
        <div className="map-region">
          <AmapMap plan={plan} vehiclePosition={simulation.position} activeLegIndex={simulation.activeLegIndex} />
          <div className="map-floating-status glass-card">
            <span className="stage-kicker">{STAGE_LABELS[displayStage]}</span>
            {plan ? (
              <>
                <strong>{plan.intent.origin.resolved?.name} <ArrowIcon /> {plan.intent.stops.map((stop) => stop.resolved?.name ?? stop.query).join(" · ")}</strong>
                <div><span>{formatDistance(plan.totalDistanceM)}</span><i /><span>{formatDuration(plan.totalDurationSec)}</span><i /><span>{plan.departureTime} 出发</span></div>
              </>
            ) : (
              <>
                <strong>上海 · 智能出行准备中</strong>
                <div><span>路线</span><i /><span>天气</span><i /><span>车况</span></div>
              </>
            )}
          </div>

          {plan && (
            <div className="route-stop-strip glass-card">
              <div className="route-stop is-origin"><span>{plan.intent.origin.resolved?.name ?? plan.intent.origin.query}</span><small>{plan.departureTime}</small></div>
              {plan.stops.map((stop, index) => (
                <div className={`route-stop ${simulation.activeLegIndex === index && displayStage === "EN_ROUTE" ? "is-active" : ""}`} key={stop.place.id}>
                  <span>{stop.place.name}</span><small>{stop.eta}</small>
                </div>
              ))}
            </div>
          )}
        </div>

        <aside className="agent-panel">
          <div className="agent-heading">
            <div>
              <span className="eyebrow">ACTIVE COMPANION</span>
              <h1>早上好，我是 NOMI</h1>
            </div>
            {plan && <span className="plan-state-pill">{STAGE_LABELS[displayStage]}</span>}
          </div>

          <section className="nomi-message-card">
            <div className="message-orb"><NomiOrb active={loading !== null || narrating || displayStage === "PRECONDITIONING" || displayStage === "EN_ROUTE"} /></div>
            <div className="message-content">
              <p>{loading ? (loading === "parse" ? "我在理解你的安排…" : loading === "places" ? "正在确认地点…" : "正在结合路线、天气和车况…") : nomiMessage}</p>
              {intent && (
                <div className="data-provenance" aria-label="数据来源">
                  <span>{understandingLabel}</span>
                  {plan && <span>规则规划</span>}
                  {plan && <span>高德数据</span>}
                  {plan && <span>{narrationLabel}</span>}
                </div>
              )}
            </div>
          </section>

          {error && (
            <section className="error-card" role="alert">
              <div><strong>{error.code === "AMAP_KEY_MISSING" ? "还差一步配置" : "这次没有规划成功"}</strong><p>{error.message}</p></div>
              <button onClick={() => setError(null)} aria-label="关闭错误"><CloseIcon /></button>
            </section>
          )}

          {!plan && !intent && (
            <section className="welcome-stack">
              <div className="welcome-card accent-mint"><SparkIcon /><div><strong>一句话生成完整行程</strong><p>我会区分出发和到达时间，并主动确认不明确的地点。</p></div></div>
              <div className="welcome-card"><RouteIcon /><div><strong>真实路线与天气</strong><p>行程时间、里程和环境建议来自确定性服务。</p></div></div>
              <div className="scenario-hint"><span>可以试试</span><button onClick={() => setPrompt("明天 7:30 从家出发，先去虹桥火车站，再去公司。")}>多站行程</button><button onClick={() => { setPrompt(SAMPLE_PROMPT); setShowLab(true); }}>低温送娃</button></div>
            </section>
          )}

          {intent && (isEditing || !plan) && (
            <IntentEditor
              intent={intent}
              onChange={changeIntent}
              onCancel={() => setIsEditing(false)}
              onPlan={() => resolveOrPlan(intent)}
              loading={loading !== null}
            />
          )}

          {plan && !isEditing && (
            <PlanDetails
              plan={plan}
              displayStage={displayStage}
              activeLegIndex={simulation.activeLegIndex}
              onEdit={() => setIsEditing(true)}
              onStart={replaySimulation}
              simulationProgress={simulationProgress}
            />
          )}
        </aside>
      </section>

      <div className="command-dock">
        <span className="command-spark"><SparkIcon /></span>
        <input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) analyzePrompt();
          }}
          placeholder="告诉 NOMI：什么时候出发、先去哪里、再去哪里…"
          aria-label="自然语言出行需求"
        />
        <button onClick={analyzePrompt} disabled={loading !== null || !prompt.trim()}>
          {loading === "parse" ? "理解中" : "规划行程"}<ArrowIcon />
        </button>
      </div>

      {showLab && (
        <DemoLab
          value={settings}
          onChange={setSettings}
          onClose={() => setShowLab(false)}
          onApply={() => {
            setShowLab(false);
            if (intent) {
              const configuredIntent = applySettingsToIntent(intent, settings);
              setIntent(configuredIntent);
              if (!findUnresolved(configuredIntent)) requestPlan(configuredIntent);
            }
          }}
        />
      )}

      {resolution && (
        <PlaceCandidateModal
          target={resolution}
          candidates={candidates}
          onChoose={chooseCandidate}
          onClose={() => { setResolution(null); setCandidates([]); setIsEditing(true); }}
        />
      )}
    </main>
  );
}

function IntentEditor({
  intent,
  onChange,
  onCancel,
  onPlan,
  loading,
}: {
  intent: TripIntentDraft;
  onChange: (updater: (draft: TripIntentDraft) => void) => void;
  onCancel: () => void;
  onPlan: () => void;
  loading: boolean;
}) {
  const timeConstraints = intent.timeConstraints?.length
    ? intent.timeConstraints
    : [intent.timeConstraint];
  return (
    <section className="intent-editor panel-card">
      <div className="card-title-row">
        <div><span className="eyebrow">STRUCTURED INTENT</span><h2>我理解的行程</h2></div>
        <span className="confidence">{Math.round(intent.confidence * 100)}% 置信度</span>
      </div>
      {intent.issues.length > 0 && <div className="intent-issue">{intent.issues[0]}</div>}
      {intent.issues.length === 0 && intent.timeConstraint.inferred && (
        <div className="intent-assumption">
          时间未完全指定，已暂按 {intent.timeConstraint.time}{intent.timeConstraint.type === "DEPART_AT" ? " 出发" : " 到达"}规划，可直接修改。
        </div>
      )}
      {timeConstraints.length > 1 && (
        <div className="intent-constraints-summary">
          {timeConstraints.map((constraint, index) => (
            <span key={`${constraint.type}-${constraint.time}-${constraint.targetStopIndex}-${index}`}>
              {constraint.time} {constraint.type === "DEPART_AT"
                ? "从起点出发"
                : `到达${intent.stops[constraint.targetStopIndex]?.query ?? `第 ${constraint.targetStopIndex + 1} 站`}`}
            </span>
          ))}
        </div>
      )}
      <div className="form-grid two-columns">
        <label><span>日期</span><input type="date" value={intent.date} onChange={(event) => onChange((draft) => { draft.date = event.target.value; })} /></label>
        <label><span>{timeConstraints.length > 1 ? "最后一个时间锚点" : "时间"}</span><input type="time" value={intent.timeConstraint.time} onChange={(event) => onChange((draft) => { updatePrimaryTimeConstraint(draft, (constraint) => { constraint.time = event.target.value; }); })} /></label>
      </div>
      <div className="constraint-switch" role="group" aria-label="时间约束">
        <button className={intent.timeConstraint.type === "ARRIVE_BY" ? "is-selected" : ""} onClick={() => onChange((draft) => { updatePrimaryTimeConstraint(draft, (constraint) => { constraint.type = "ARRIVE_BY"; constraint.targetStopIndex = 0; constraint.inferred = false; }); })}>按时到达</button>
        <button className={intent.timeConstraint.type === "DEPART_AT" ? "is-selected" : ""} onClick={() => onChange((draft) => { updatePrimaryTimeConstraint(draft, (constraint) => { constraint.type = "DEPART_AT"; constraint.targetStopIndex = 0; constraint.inferred = false; }); })}>准时出发</button>
      </div>
      {intent.timeConstraint.type === "ARRIVE_BY" && intent.stops.length > 1 && (
        <label className="target-stop-select">
          <span>按时到达</span>
          <select value={intent.timeConstraint.targetStopIndex} onChange={(event) => onChange((draft) => { updatePrimaryTimeConstraint(draft, (constraint) => { constraint.targetStopIndex = Number(event.target.value); }); })}>
            {intent.stops.map((stop, index) => <option value={index} key={stop.key}>{stop.query || `第 ${index + 1} 站`}</option>)}
          </select>
        </label>
      )}
      <div className="place-edit-list">
        <label className="place-field"><span className="place-index is-home">家</span><div><small>出发地</small><input value={intent.origin.query} onChange={(event) => onChange((draft) => { draft.origin = updatePlaceDraft(draft.origin, event.target.value); })} /></div></label>
        {intent.stops.map((stop, index) => (
          <label className="place-field" key={stop.key}>
            <span className="place-index">{index + 1}</span>
            <div><small>{intent.timeConstraint.type === "ARRIVE_BY" && intent.timeConstraint.targetStopIndex === index ? "准时到达这里" : `第 ${index + 1} 站`}</small><input value={stop.query} onChange={(event) => onChange((draft) => { draft.stops[index] = updatePlaceDraft(draft.stops[index], event.target.value); })} /></div>
            <button className="remove-stop" onClick={(event) => { event.preventDefault(); onChange((draft) => { draft.stops.splice(index, 1); draft.timeConstraint.targetStopIndex = Math.min(draft.timeConstraint.targetStopIndex, Math.max(0, draft.stops.length - 1)); }); }} aria-label={`删除${stop.query}`}><CloseIcon /></button>
          </label>
        ))}
        {intent.stops.length < 3 && <button className="add-stop" onClick={() => onChange((draft) => { draft.stops.push({ key: `new-${Date.now()}`, label: "", query: "", resolved: null }); })}>＋ 添加途经点</button>}
      </div>
      <div className="editor-actions">
        <button className="secondary-button" onClick={onCancel}>稍后再说</button>
        <button className="primary-button" onClick={onPlan} disabled={loading || intent.stops.length === 0}>{loading ? "正在规划" : "确认并生成计划"}<ArrowIcon /></button>
      </div>
    </section>
  );
}

function PlanDetails({
  plan,
  displayStage,
  activeLegIndex,
  onEdit,
  onStart,
  simulationProgress,
}: {
  plan: TripPlan;
  displayStage: DemoStage;
  activeLegIndex: number;
  onEdit: () => void;
  onStart: () => void;
  simulationProgress: number | null;
}) {
  const severityRank = { critical: 0, warning: 1, suggestion: 2, info: 3 } as const;
  const proactiveActions = plan.actions
    .filter((item) => item.type !== "LEAVE_BUFFER")
    .sort((left, right) => severityRank[left.severity] - severityRank[right.severity]);
  const displayedActions = proactiveActions.length
    ? proactiveActions
    : plan.actions.filter((item) => item.type === "LEAVE_BUFFER");
  return (
    <div className="plan-details">
      <section className="trip-summary panel-card">
        <div className="card-title-row">
          <div><span className="eyebrow">TRIP PLAN</span><h2>{formatChineseDate(plan.intent.date)} · {plan.departureTime} 出发</h2></div>
          <button className="text-icon-button" onClick={onEdit}><EditIcon />调整</button>
        </div>
        <div className="summary-metrics">
          <div><RouteIcon /><span><small>总里程</small><strong>{formatDistance(plan.totalDistanceM)}</strong></span></div>
          <div><ClockIcon /><span><small>预计用时</small><strong>{formatDuration(plan.totalDurationSec)}</strong></span></div>
          <div><BatteryIcon /><span><small>到达电量</small><strong>{plan.vehicle.estimatedArrivalBattery}%</strong></span></div>
        </div>
      </section>

      <section className="timeline-card panel-card">
        <div className="section-label"><span>行程时间轴</span><em>{plan.weather.source === "override" ? "演示数据" : "实时规划"}</em></div>
        <div className="timeline-list">
          {plan.actions.find((item) => item.type === "PREHEAT" || item.type === "PRECOOL") && (
            <div className={`timeline-row ${displayStage === "PRECONDITIONING" ? "is-current" : ""}`}><span className="timeline-time">{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }).format(new Date(plan.actions.find((item) => item.type === "PREHEAT" || item.type === "PRECOOL")!.scheduledAt!))}</span><i /><div><strong>开始备车</strong><small>{plan.actions.find((item) => item.type === "PREHEAT" || item.type === "PRECOOL")!.title}</small></div></div>
          )}
          <div className={`timeline-row ${displayStage === "READY" || (displayStage === "EN_ROUTE" && activeLegIndex === 0) ? "is-current" : ""}`}><span className="timeline-time">{plan.departureTime}</span><i /><div><strong>从{plan.intent.origin.resolved?.name}出发</strong><small>已包含 {Math.round(plan.planningBufferSec / 60)} 分钟路况缓冲</small></div></div>
          {plan.stops.map((stop, index) => (
            <Fragment key={stop.place.id}>
              <div className={`timeline-row ${activeLegIndex === index && (displayStage === "EN_ROUTE" || displayStage === "AT_STOP") ? "is-current" : ""}`}><span className="timeline-time">{stop.eta}</span><i /><div><strong>到达{stop.place.name}</strong><small>{index < plan.stops.length - 1 ? `计划停留约 ${Math.round((stop.dwellSec ?? 300) / 60)} 分钟` : "本次行程终点"}</small></div></div>
              {index < plan.stops.length - 1 && stop.departureTime && (
                <div className="timeline-row"><span className="timeline-time">{stop.departureTime}</span><i /><div><strong>{(stop.dwellSec ?? 0) > 300 ? "最晚" : "继续"}从{stop.place.name}出发</strong><small>前往{plan.stops[index + 1].place.name}</small></div></div>
              )}
            </Fragment>
          ))}
        </div>
      </section>

      <section className="active-service-card panel-card">
        <div className="section-label"><span>NOMI 主动服务</span><em>{displayedActions.length} 项</em></div>
        <div className="service-list">
          {displayedActions.map((item) => (
            <div className={`service-item severity-${item.severity}`} key={item.id}><span><SparkIcon /></span><div><strong>{item.title}</strong><p>{item.detail}</p></div></div>
          ))}
        </div>
      </section>

      <button className="start-demo-button" onClick={onStart}>
        <span>{simulationProgress === null ? "确认计划并开始 15 秒演示" : simulationProgress >= 1 ? "重新播放 15 秒演示" : "从头播放演示"}</span>
        <ArrowIcon />
      </button>
      <p className="data-note">{plan.notes[0]}</p>
    </div>
  );
}

function DemoLab({
  value,
  onChange,
  onClose,
  onApply,
}: {
  value: DemoSettings;
  onChange: (value: DemoSettings) => void;
  onClose: () => void;
  onApply: () => void;
}) {
  const [editingPlace, setEditingPlace] = useState<FavoritePlaceKey | null>(null);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeCandidates, setPlaceCandidates] = useState<ResolvedPlace[]>([]);
  const [placeSearchState, setPlaceSearchState] = useState<"idle" | "loading" | "empty" | "error">("idle");

  const beginPlaceEdit = (key: FavoritePlaceKey) => {
    setEditingPlace(key);
    setPlaceQuery(value.favoritePlaces[key].address || value.favoritePlaces[key].name);
    setPlaceCandidates([]);
    setPlaceSearchState("idle");
  };

  const searchFavoritePlace = async () => {
    if (!placeQuery.trim()) return;
    setPlaceSearchState("loading");
    setPlaceCandidates([]);
    try {
      const result = await fetchJson<PlaceSearchResponse>(
        `/api/places/search?q=${encodeURIComponent(placeQuery)}&city=${encodeURIComponent("上海市")}`,
      );
      setPlaceCandidates(result.candidates);
      setPlaceSearchState(result.candidates.length ? "idle" : "empty");
    } catch {
      setPlaceSearchState("error");
    }
  };

  const chooseFavoritePlace = (place: ResolvedPlace) => {
    if (!editingPlace) return;
    onChange({
      ...value,
      favoritePlaces: { ...value.favoritePlaces, [editingPlace]: place },
    });
    setEditingPlace(null);
    setPlaceCandidates([]);
    setPlaceSearchState("idle");
  };

  return (
    <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="demo-lab">
        <div className="drawer-heading"><div><span className="eyebrow">SCENARIO OVERRIDE</span><h2>Demo Lab</h2></div><button className="icon-button" onClick={onClose}><CloseIcon /></button></div>
        <p className="drawer-intro">集中管理默认地点与主动服务偏好；演示场景固定用 15 秒播放完整行程。</p>
        <section className="lab-section">
          <div className="lab-section-title"><strong>默认偏好</strong><small>应用于每次新规划</small></div>
          <label className="toggle-row"><div><strong>允许 NOMI 根据天气主动备车</strong><small>按座舱温度判断预热或制冷</small></div><input type="checkbox" checked={value.preconditionVehicle} onChange={(event) => onChange({ ...value, preconditionVehicle: event.target.checked })} /><span /></label>
        </section>

        <section className="lab-section">
          <div className="lab-section-title"><strong>常用地点</strong><small>输入地址后从高德候选中确认</small></div>
          <div className="favorite-place-list">
            {FAVORITE_PLACE_KEYS.map((key) => {
              const place = value.favoritePlaces[key];
              return (
                <div className="favorite-place-item" key={key}>
                  <div><span>{FAVORITE_PLACE_LABELS[key]}</span><strong>{place.name}</strong><small>{place.district} · {place.address}</small></div>
                  <button onClick={() => beginPlaceEdit(key)}>修改</button>
                </div>
              );
            })}
          </div>
          {editingPlace && (
            <div className="favorite-place-editor">
              <div className="place-search-row">
                <input value={placeQuery} onChange={(event) => setPlaceQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) searchFavoritePlace(); }} placeholder={`搜索${FAVORITE_PLACE_LABELS[editingPlace]}的具体地址`} autoFocus />
                <button onClick={searchFavoritePlace} disabled={placeSearchState === "loading"}>{placeSearchState === "loading" ? "搜索中" : "搜索"}</button>
              </div>
              {(placeSearchState === "empty" || placeSearchState === "error") && <p className="place-search-error">{placeSearchState === "empty" ? "没有找到匹配地点，请换个关键词。" : "地点搜索失败，请稍后重试。"}</p>}
              {placeCandidates.length > 0 && (
                <div className="favorite-place-candidates">
                  {placeCandidates.map((place) => <button key={place.id} onClick={() => chooseFavoritePlace(place)}><strong>{place.name}</strong><small>{place.district} · {place.address}</small></button>)}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="lab-section">
          <div className="lab-section-title"><strong>演示场景</strong><small>关闭时使用高德天气与默认模拟车况</small></div>
        <label className="toggle-row"><div><strong>启用场景覆盖</strong><small>用于稳定触发低温、雨雪和低电量建议</small></div><input type="checkbox" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} /><span /></label>
        <div className={`lab-controls ${value.enabled ? "" : "is-disabled"}`}>
          <label><span>天气状况</span><select value={value.condition} onChange={(event) => onChange({ ...value, condition: event.target.value })}><option>晴</option><option>多云</option><option>小雨</option><option>暴雨</option><option>小雪</option></select></label>
          <label><span>当前电量 <strong>{value.batteryPercent}%</strong></span><input type="range" min="5" max="100" value={value.batteryPercent} onChange={(event) => onChange({ ...value, batteryPercent: Number(event.target.value) })} /></label>
          <label><span>座舱温度 <strong>{value.cabinTemperatureC}°C</strong></span><input type="range" min="-5" max="45" value={value.cabinTemperatureC} onChange={(event) => onChange({ ...value, cabinTemperatureC: Number(event.target.value) })} /></label>
        </div>
        </section>
        <button className="primary-button full-width" onClick={onApply}>应用并重新规划<ArrowIcon /></button>
      </aside>
    </div>
  );
}

function PlaceCandidateModal({
  target,
  candidates,
  onChoose,
  onClose,
}: {
  target: ResolutionTarget;
  candidates: ResolvedPlace[];
  onChoose: (place: ResolvedPlace) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <section className="candidate-modal" role="dialog" aria-modal="true" aria-labelledby="candidate-title">
        <div className="drawer-heading"><div><span className="eyebrow">PLACE CONFIRMATION</span><h2 id="candidate-title">你指的是哪个“{target.query}”？</h2></div><button className="icon-button" onClick={onClose}><CloseIcon /></button></div>
        <p>选择准确地点后，我再继续计算路线和到达时间。</p>
        <div className="candidate-list">
          {candidates.map((place, index) => (
            <button onClick={() => onChoose(place)} key={place.id}>
              <span>{index + 1}</span><div><strong>{place.name}</strong><small>{place.district} · {place.address}</small></div><ArrowIcon />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
