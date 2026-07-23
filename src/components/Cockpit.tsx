"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { AmapMap } from "@/components/AmapMap";
import { ConversationScenario } from "@/components/ConversationScenario";
import {
  ArrowIcon,
  BatteryIcon,
  CloseIcon,
  RouteIcon,
  SettingsIcon,
  WeatherIcon,
} from "@/components/icons";
import { conversationPlanFactsFromPlan } from "@/lib/ai/conversation-context";
import { buildTemplateNarration, type TripNarrationMode } from "@/lib/ai/trip-narrator";
import type {
  ConversationPlanFreshness,
  ConversationTurnResponse,
} from "@/lib/conversation-turn";
import {
  createConversationStore,
  createMemoryConversationStore,
  type ConversationPersistence,
} from "@/lib/conversation-store";
import {
  appendConversationMessage,
  beginConversationTurn,
  clearPendingConversationIntent,
  clipRecentMessages,
  commitConversationPlan,
  createChatMessage,
  createEmptyConversation,
  failConversationTurn,
  lockConversationScenario,
  updateConversationTurnStatus,
  type ChatMessage,
  type Conversation,
} from "@/lib/conversations";
import { DEFAULT_PLACES } from "@/lib/default-places";
import type {
  DemoSettings,
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

const FAVORITE_PLACE_LABELS: Record<FavoritePlaceKey, string> = {
  home: "家",
  company: "我的公司",
  school: "儿子学校",
  wifeCompany: "老婆公司",
};

const FAVORITE_PLACE_KEYS = Object.keys(FAVORITE_PLACE_LABELS) as FavoritePlaceKey[];

const DEFAULT_SCENARIO: DemoSettings = {
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

interface PendingResolution {
  conversationId: string;
  turnId: string;
  assistantMessageId: string;
  intent: TripIntentDraft;
  target: ResolutionTarget;
  candidates: ResolvedPlace[];
  searching: boolean;
  searchError: string;
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
  const body = (await response.json().catch(() => null)) as T | ProviderErrorPayload | null;
  if (!response.ok) {
    const error = body as ProviderErrorPayload | null;
    throw new ApiError(error?.error ?? "请求失败，请稍后重试。", error?.code, error?.retryable);
  }
  return body as T;
}

function newId(prefix: string): string {
  const value = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

function cloneDefaultScenario(): DemoSettings {
  return structuredClone(DEFAULT_SCENARIO);
}

function isFavoritePlaceKey(value: string): value is FavoritePlaceKey {
  return FAVORITE_PLACE_KEYS.includes(value as FavoritePlaceKey);
}

function applyScenarioToIntent(
  intent: TripIntentDraft,
  scenario: DemoSettings,
  applyPreconditionDefault: boolean,
): TripIntentDraft {
  const next = structuredClone(intent);
  const applyFavorite = (place: PlaceDraft) => {
    if (!isFavoritePlaceKey(place.key)) return;
    place.resolved = structuredClone(scenario.favoritePlaces[place.key]);
    place.label = FAVORITE_PLACE_LABELS[place.key];
    place.query = FAVORITE_PLACE_LABELS[place.key];
  };
  applyFavorite(next.origin);
  next.stops.forEach(applyFavorite);
  if (!scenario.preconditionVehicle) {
    next.preferences = next.preferences.filter((item) => item !== "precondition_vehicle");
  } else if (applyPreconditionDefault) {
    next.preferences = [...new Set([...next.preferences, "precondition_vehicle"])];
  }
  return next;
}

function findUnresolved(intent: TripIntentDraft): ResolutionTarget | null {
  if (!intent.origin.resolved) {
    return { type: "origin", index: -1, query: intent.origin.query };
  }
  const index = intent.stops.findIndex((stop) => !stop.resolved);
  return index >= 0
    ? { type: "stop", index, query: intent.stops[index].query }
    : null;
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

function NomiOrb({ active }: { active: boolean }) {
  return (
    <div className={`nomi-orb ${active ? "is-active" : ""}`} aria-hidden="true">
      <span className="nomi-orb-core" />
      <span className="nomi-orb-glow" />
    </div>
  );
}

function recoverInterruptedConversation(conversation: Conversation): Conversation {
  const interrupted = ["pending", "resolving_places", "planning", "answering"].includes(conversation.turn.status);
  if (!interrupted) return conversation;
  const timestamp = new Date().toISOString();
  let lastAssistantIndex = -1;
  for (let index = 0; index < conversation.messages.length; index += 1) {
    const message = conversation.messages[index];
    if (message.turnId === conversation.turn.turnId && message.role === "assistant") {
      lastAssistantIndex = index;
    }
  }
  return {
    ...conversation,
    updatedAt: timestamp,
    messages: conversation.messages.map((message, index) => (
      message.status === "pending"
      || (conversation.turn.status === "resolving_places" && index === lastAssistantIndex)
    )
      ? {
          ...message,
          kind: "error" as const,
          status: "failed" as const,
          content: "上次请求在页面关闭时中断了，你可以重新发送这条需求。",
        }
      : message),
    trip: { ...conversation.trip, pendingIntent: null },
    turn: {
      ...conversation.turn,
      status: "failed",
      updatedAt: timestamp,
      error: { message: "上次请求已中断。", code: "TURN_INTERRUPTED", retryable: true },
    },
  };
}

function replaceMessage(
  conversation: Conversation,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage,
): Conversation {
  const timestamp = new Date().toISOString();
  return {
    ...conversation,
    updatedAt: timestamp,
    messages: conversation.messages.map((message) => message.id === messageId ? updater(message) : message),
  };
}

function narrationRequestBody(plan: TripPlan, mode: TripNarrationMode) {
  return {
    userText: plan.intent.rawText,
    mode,
    plan: {
      intent: {
        date: plan.intent.date,
        origin: {
          label: plan.intent.origin.label,
          query: plan.intent.origin.query,
          resolved: plan.intent.origin.resolved ? { name: plan.intent.origin.resolved.name } : null,
        },
        stops: plan.intent.stops.map((stop) => ({
          label: stop.label,
          query: stop.query,
        })),
        timeConstraint: plan.intent.timeConstraint,
        timeConstraints: plan.intent.timeConstraints,
      },
      departureTime: plan.departureTime,
      planningBufferSec: plan.planningBufferSec,
      stops: plan.stops.map((stop) => ({
        place: { name: stop.place.name },
        eta: stop.eta,
        dateTime: stop.dateTime,
        departureTime: stop.departureTime ?? null,
        dwellSec: stop.dwellSec ?? 0,
      })),
      weather: {
        available: plan.weather.available,
        condition: plan.weather.condition,
        temperatureC: plan.weather.temperatureC,
        source: plan.weather.source,
      },
      vehicle: {
        batteryPercent: plan.vehicle.batteryPercent,
        estimatedArrivalBattery: plan.vehicle.estimatedArrivalBattery,
        cabinTemperatureC: plan.vehicle.cabinTemperatureC,
      },
      actions: plan.actions.map((action) => ({
        type: action.type,
        title: action.title,
        detail: action.detail,
        severity: action.severity,
        scheduledAt: action.scheduledAt,
      })),
    },
  };
}

function historyTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

export function Cockpit() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [storageWarning, setStorageWarning] = useState("");
  const [composer, setComposer] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [scenarioViewOpen, setScenarioViewOpen] = useState(false);
  const [scenarioDrafts, setScenarioDrafts] = useState<Record<string, DemoSettings>>({});
  const [resolutions, setResolutions] = useState<Record<string, PendingResolution>>({});
  const storeRef = useRef<ConversationPersistence | null>(null);
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const conversationsRef = useRef<Conversation[]>([]);
  const messageListRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const mutateConversation = (id: string, updater: (conversation: Conversation) => Conversation) => {
    const next = conversationsRef.current.map((conversation) =>
      conversation.id === id ? updater(conversation) : conversation,
    );
    conversationsRef.current = next;
    setConversations(next);
  };

  const conversationById = (id: string): Conversation | null =>
    conversationsRef.current.find((conversation) => conversation.id === id) ?? null;

  useEffect(() => {
    fetchJson<HealthResponse>("/api/providers/health").then(setHealth).catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const persistentStore = createConversationStore({ defaultDemoSettings: DEFAULT_SCENARIO });
      let store: ConversationPersistence = persistentStore;
      let loaded: Conversation[] = [];
      let restoredActiveId: string | null = null;
      let persistenceWarning = "";
      try {
        await persistentStore.migrateLegacyConversation({ defaultDemoSettings: DEFAULT_SCENARIO });
      } catch (error) {
        persistenceWarning = error instanceof Error
          ? error.message
          : "旧版行程暂未迁移，原记录已保留。";
      }
      try {
        [loaded, restoredActiveId] = await Promise.all([
          persistentStore.loadConversations(),
          persistentStore.getActiveConversationId(),
        ]);
      } catch (error) {
        persistentStore.close();
        store = createMemoryConversationStore();
        persistenceWarning = error instanceof Error
          ? error.message
          : "历史暂未保存，本页内仍可继续使用。";
      }
      if (cancelled) {
        store.close();
        return;
      }

      if (persistenceWarning) setStorageWarning(persistenceWarning);

      loaded = loaded.map(recoverInterruptedConversation);
      if (loaded.length === 0) loaded = [createEmptyConversation()];
      if (!restoredActiveId || !loaded.some((conversation) => conversation.id === restoredActiveId)) {
        restoredActiveId = loaded[0].id;
      }
      storeRef.current = store;
      conversationsRef.current = loaded;
      setConversations(loaded);
      setActiveConversationId(restoredActiveId);
      setScenarioDrafts(Object.fromEntries(
        loaded
          .filter((conversation) => !conversation.scenario.ready)
          .map((conversation) => [conversation.id, cloneDefaultScenario()]),
      ));
      setHydrated(true);
    };
    void hydrate();
    return () => {
      cancelled = true;
      storeRef.current?.close();
      storeRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!hydrated || !storeRef.current) return;
    const store = storeRef.current;
    const snapshot = structuredClone(conversations);
    persistenceQueueRef.current = persistenceQueueRef.current
      .catch(() => undefined)
      .then(() => store.saveConversations(snapshot))
      .catch((error) => {
        setStorageWarning(error instanceof Error ? error.message : "历史暂未保存，本页内仍可继续使用。");
      });
  }, [conversations, hydrated]);

  useEffect(() => {
    if (!hydrated || !activeConversationId || !storeRef.current) return;
    storeRef.current.setActiveConversationId(activeConversationId).catch((error) => {
      setStorageWarning(error instanceof Error ? error.message : "当前会话暂未保存。");
    });
  }, [activeConversationId, hydrated]);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0] ?? null,
    [activeConversationId, conversations],
  );
  const activePlan = activeConversation?.trip.currentPlan ?? null;
  const activeScenario = activeConversation?.scenario.demoSettings ?? null;
  const activeResolution = activeConversation ? resolutions[activeConversation.id] ?? null : null;

  useEffect(() => {
    const container = messageListRef.current;
    if (!container || historyOpen || scenarioViewOpen) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [activeConversation?.messages, historyOpen, scenarioViewOpen]);

  const currentBattery = activePlan
    ? activePlan.vehicle.batteryPercent
    : activeScenario?.batteryPercent ?? DEFAULT_SCENARIO.batteryPercent;

  const failTurn = (
    conversationId: string,
    turnId: string,
    assistantMessageId: string,
    error: unknown,
  ) => {
    const apiError = error instanceof ApiError
      ? error
      : new ApiError(error instanceof Error ? error.message : "这次没有处理成功，请稍后重试。");
    setResolutions((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    mutateConversation(conversationId, (conversation) => {
      if (conversation.turn.turnId !== turnId) return conversation;
      let next = failConversationTurn(conversation, {
        turnId,
        error: { message: apiError.message, code: apiError.code, retryable: apiError.retryable },
      });
      next = clearPendingConversationIntent(next);
      return replaceMessage(next, assistantMessageId, (message) => ({
        ...message,
        kind: "error",
        status: "failed",
        content: apiError.message,
      }));
    });
  };

  const finishAssistantMessage = (
    conversationId: string,
    turnId: string,
    assistantMessageId: string,
    content: string,
    kind: ChatMessage["kind"] = "text",
    planId: string | null = null,
  ) => {
    mutateConversation(conversationId, (conversation) => {
      if (conversation.turn.turnId !== turnId) return conversation;
      let next = updateConversationTurnStatus(conversation, turnId, "complete");
      next = replaceMessage(next, assistantMessageId, (message) => ({
        ...message,
        kind,
        status: "complete",
        planId,
        content,
      }));
      return next;
    });
  };

  const requestPlan = async (intent: TripIntentDraft, scenario: DemoSettings): Promise<TripPlan> =>
    fetchJson<TripPlan>("/api/trips/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent, overrides: scenario }),
    });

  const executePlan = async (
    conversationId: string,
    turnId: string,
    assistantMessageId: string,
    inputIntent: TripIntentDraft,
  ) => {
    const conversation = conversationById(conversationId);
    const scenario = conversation?.scenario.demoSettings;
    if (!conversation || !scenario) {
      failTurn(conversationId, turnId, assistantMessageId, new ApiError("请先设置并锁定本次对话的 Demo Lab 场景。", "SCENARIO_REQUIRED", false));
      return;
    }
    const intent = applyScenarioToIntent(inputIntent, scenario, conversation.trip.currentPlan === null);
    mutateConversation(conversationId, (current) => {
      if (current.turn.turnId !== turnId) return current;
      const next = updateConversationTurnStatus(current, turnId, "planning");
      return replaceMessage(next, assistantMessageId, (message) => ({
        ...message,
        status: "pending",
        content: "正在结合路线、天气和本次对话的车况场景…",
      }));
    });

    try {
      const narrationMode: TripNarrationMode = conversation.trip.currentPlan ? "update" : "initial";
      const plan = await requestPlan(intent, scenario);
      mutateConversation(conversationId, (current) => {
        if (current.turn.turnId !== turnId) return current;
        let next = commitConversationPlan(current, { turnId, intent, plan });
        next = updateConversationTurnStatus(next, turnId, "answering");
        return replaceMessage(next, assistantMessageId, (message) => ({
          ...message,
          status: "pending",
          content: "路线已经更新，正在整理成一条清晰的回复…",
        }));
      });

      let narrationText = buildTemplateNarration(plan, {
        context: { userText: plan.intent.rawText, mode: narrationMode },
      }).text;
      try {
        const narration = await fetchJson<TripNarrationResponse>("/api/trips/narrate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(narrationRequestBody(plan, narrationMode)),
        });
        narrationText = narration.text;
      } catch {
        // The deterministic text above keeps a successful route usable.
      }
      finishAssistantMessage(conversationId, turnId, assistantMessageId, narrationText, "plan", plan.id);
    } catch (error) {
      failTurn(conversationId, turnId, assistantMessageId, error);
    }
  };

  const resolveOrPlan = async (
    conversationId: string,
    turnId: string,
    assistantMessageId: string,
    inputIntent: TripIntentDraft,
  ) => {
    const conversation = conversationById(conversationId);
    const scenario = conversation?.scenario.demoSettings;
    if (!conversation || !scenario) {
      failTurn(conversationId, turnId, assistantMessageId, new ApiError("请先设置本次对话场景。", "SCENARIO_REQUIRED", false));
      return;
    }
    const intent = applyScenarioToIntent(inputIntent, scenario, conversation.trip.currentPlan === null);
    if (intent.stops.length === 0 || intent.issues.length > 0) {
      mutateConversation(conversationId, (current) => {
        if (current.turn.turnId !== turnId) return current;
        const timestamp = new Date().toISOString();
        let next: Conversation = {
          ...current,
          trip: { ...current.trip, pendingIntent: intent },
          turn: { ...current.turn, status: "complete", updatedAt: timestamp },
        };
        next = replaceMessage(next, assistantMessageId, (message) => ({
          ...message,
          kind: "clarification",
          status: "complete",
          content: intent.issues[0] ?? "我还缺少目的地，请告诉我这次要去哪里。",
        }));
        return next;
      });
      return;
    }

    const unresolved = findUnresolved(intent);
    if (!unresolved) {
      await executePlan(conversationId, turnId, assistantMessageId, intent);
      return;
    }
    if (!unresolved.query.trim()) {
      failTurn(conversationId, turnId, assistantMessageId, new ApiError("请告诉我需要搜索的地点名称。", "EMPTY_PLACE", false));
      return;
    }

    mutateConversation(conversationId, (current) => {
      if (current.turn.turnId !== turnId) return current;
      const next = updateConversationTurnStatus(current, turnId, "resolving_places");
      return {
        ...replaceMessage(next, assistantMessageId, (message) => ({
          ...message,
          status: "pending",
          content: `正在确认“${unresolved.query}”的具体地点…`,
        })),
        trip: { ...next.trip, pendingIntent: intent },
      };
    });

    try {
      const result = await fetchJson<PlaceSearchResponse>(
        `/api/places/search?q=${encodeURIComponent(unresolved.query)}&city=${encodeURIComponent(intent.city)}`,
      );
      const resolution: PendingResolution = {
        conversationId,
        turnId,
        assistantMessageId,
        intent,
        target: unresolved,
        candidates: result.candidates,
        searching: false,
        searchError: "",
      };
      setResolutions((current) => ({ ...current, [conversationId]: resolution }));
      mutateConversation(conversationId, (current) => current.turn.turnId !== turnId
        ? current
        : replaceMessage(current, assistantMessageId, (message) => ({
            ...message,
            kind: "clarification",
            status: "complete",
            content: `你指的是哪个“${unresolved.query}”？选择后我再继续规划。`,
          })));
    } catch (error) {
      failTurn(conversationId, turnId, assistantMessageId, error);
    }
  };

  const performRefreshForQuestion = async (
    conversationId: string,
    turnId: string,
    assistantMessageId: string,
    userText: string,
    depth: number,
  ) => {
    const conversation = conversationById(conversationId);
    const intent = conversation?.trip.currentIntent;
    const scenario = conversation?.scenario.demoSettings;
    if (!conversation || !intent || !scenario || depth > 0) {
      failTurn(conversationId, turnId, assistantMessageId, new ApiError("当前没有可以刷新的有效行程。", "REFRESH_UNAVAILABLE", false));
      return;
    }
    mutateConversation(conversationId, (current) => current.turn.turnId !== turnId
      ? current
      : replaceMessage(
          updateConversationTurnStatus(current, turnId, "planning"),
          assistantMessageId,
          (message) => ({ ...message, status: "pending", content: "正在刷新路线和天气…" }),
        ));
    try {
      const plan = await requestPlan(intent, scenario);
      mutateConversation(conversationId, (current) => {
        if (current.turn.turnId !== turnId) return current;
        return {
          ...current,
          turn: { ...current.turn, status: "answering", updatedAt: new Date().toISOString() },
        };
      });
      await runConversationTurn(
        conversationId,
        turnId,
        assistantMessageId,
        userText,
        { status: "FRESH", updatedAt: plan.createdAt, refreshedForTurnId: turnId },
        plan,
        depth + 1,
      );
    } catch (error) {
      failTurn(conversationId, turnId, assistantMessageId, error);
    }
  };

  const runConversationTurn = async (
    conversationId: string,
    turnId: string,
    assistantMessageId: string,
    userText: string,
    freshnessOverride?: ConversationPlanFreshness,
    planOverride?: TripPlan,
    refreshDepth = 0,
  ) => {
    const conversation = conversationById(conversationId);
    if (!conversation || conversation.turn.turnId !== turnId) return;
    const plan = planOverride ?? conversation.trip.currentPlan;
    const history = clipRecentMessages(
      conversation.messages.filter((message) => message.status === "complete" && message.content.trim()),
    ).map((message) => ({ role: message.role, content: message.content }));
    const freshness: ConversationPlanFreshness = freshnessOverride ?? (plan
      ? { status: "SNAPSHOT", updatedAt: conversation.trip.planUpdatedAt ?? plan.createdAt }
      : { status: "MISSING", updatedAt: null });

    try {
      const response = await fetchJson<ConversationTurnResponse>("/api/conversations/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          turnId,
          text: userText,
          currentIntent: conversation.trip.currentIntent,
          pendingIntent: conversation.trip.pendingIntent,
          planFacts: plan ? conversationPlanFactsFromPlan(plan) : null,
          planFreshness: freshness,
          history,
        }),
      });
      if (response.conversationId !== conversationId || response.turnId !== turnId) {
        throw new ApiError("服务返回了不匹配的会话结果。", "TURN_MISMATCH", true);
      }
      if (response.type === "ANSWER") {
        if (
          planOverride
          && freshnessOverride?.status === "FRESH"
          && freshnessOverride.refreshedForTurnId === turnId
        ) {
          mutateConversation(conversationId, (current) => {
            if (current.turn.turnId !== turnId) return current;
            const next = commitConversationPlan(current, {
              turnId,
              intent: planOverride.intent,
              plan: planOverride,
            });
            return replaceMessage(next, assistantMessageId, (message) => ({
              ...message,
              kind: "plan",
              status: "complete",
              planId: planOverride.id,
              content: response.text,
            }));
          });
        } else {
          finishAssistantMessage(conversationId, turnId, assistantMessageId, response.text);
        }
      } else if (response.type === "CLARIFY") {
        if (response.intent) {
          mutateConversation(conversationId, (current) => current.turn.turnId !== turnId
            ? current
            : { ...current, trip: { ...current.trip, pendingIntent: response.intent ?? null } });
        }
        finishAssistantMessage(conversationId, turnId, assistantMessageId, response.text, "clarification");
      } else if (response.type === "REFRESH_REQUIRED") {
        await performRefreshForQuestion(
          conversationId,
          turnId,
          assistantMessageId,
          userText,
          refreshDepth,
        );
      } else {
        const currentScenario = conversationById(conversationId)?.scenario.demoSettings;
        if (
          currentScenario
          && !currentScenario.preconditionVehicle
          && response.intent.preferences.includes("precondition_vehicle")
        ) {
          finishAssistantMessage(
            conversationId,
            turnId,
            assistantMessageId,
            "本次对话的场景没有开放主动备车，而且场景已经锁定。如需开启，请新建对话并在场景设置中允许。",
            "clarification",
          );
          return;
        }
        mutateConversation(conversationId, (current) => current.turn.turnId !== turnId
          ? current
          : { ...current, trip: { ...current.trip, pendingIntent: response.intent } });
        await resolveOrPlan(
          conversationId,
          turnId,
          assistantMessageId,
          response.intent,
        );
      }
    } catch (error) {
      failTurn(conversationId, turnId, assistantMessageId, error);
    }
  };

  const sendMessage = (rawText: string, targetConversationId = activeConversationId) => {
    const text = rawText.trim();
    const conversation = conversationById(targetConversationId);
    if (!text || !conversation || !conversation.scenario.ready) return;
    if (["pending", "resolving_places", "planning", "answering"].includes(conversation.turn.status)) return;

    const turnId = newId("turn");
    const userMessage = createChatMessage({
      conversationId: conversation.id,
      turnId,
      role: "user",
      content: text,
    });
    const assistantMessage = createChatMessage({
      conversationId: conversation.id,
      turnId,
      role: "assistant",
      kind: "status",
      status: "pending",
      content: "我在理解你的安排…",
    });
    let next = beginConversationTurn(conversation, {
      turnId,
      status: "pending",
      pendingIntent: conversation.trip.pendingIntent,
    });
    next = appendConversationMessage(next, userMessage);
    next = appendConversationMessage(next, assistantMessage);
    mutateConversation(conversation.id, () => next);
    if (conversation.id === activeConversationId) setComposer("");
    void runConversationTurn(conversation.id, turnId, assistantMessage.id, text);
  };

  const chooseCandidate = (place: ResolvedPlace) => {
    if (!activeResolution) return;
    const { conversationId, turnId, intent, target } = activeResolution;
    const conversation = conversationById(conversationId);
    if (!conversation || conversation.turn.turnId !== turnId) return;
    const nextIntent = structuredClone(intent);
    if (target.type === "origin") {
      nextIntent.origin = { ...nextIntent.origin, query: place.name, label: place.name, resolved: place };
    } else {
      nextIntent.stops[target.index] = {
        ...nextIntent.stops[target.index],
        query: place.name,
        label: place.name,
        resolved: place,
      };
    }
    const selectionMessage = createChatMessage({
      conversationId,
      turnId,
      role: "user",
      content: `选择地点：${place.name}（${place.district}）`,
    });
    const assistantMessage = createChatMessage({
      conversationId,
      turnId,
      role: "assistant",
      kind: "status",
      status: "pending",
      content: "地点已确认，继续规划…",
    });
    setResolutions((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    mutateConversation(conversationId, (current) => {
      let next = appendConversationMessage(current, selectionMessage);
      next = appendConversationMessage(next, assistantMessage);
      return { ...next, trip: { ...next.trip, pendingIntent: nextIntent } };
    });
    void resolveOrPlan(conversationId, turnId, assistantMessage.id, nextIntent);
  };

  const updateResolutionQuery = (query: string) => {
    if (!activeResolution) return;
    const { conversationId, turnId, target } = activeResolution;
    setResolutions((current) => {
      const resolution = current[conversationId];
      if (!resolution || resolution.turnId !== turnId) return current;
      const intent = structuredClone(resolution.intent);
      if (target.type === "origin") {
        intent.origin = { ...intent.origin, query, label: query, resolved: null };
      } else if (intent.stops[target.index]) {
        intent.stops[target.index] = {
          ...intent.stops[target.index],
          query,
          label: query,
          resolved: null,
        };
      }
      return {
        ...current,
        [conversationId]: {
          ...resolution,
          intent,
          target: { ...resolution.target, query },
          searchError: "",
        },
      };
    });
  };

  const researchResolution = async () => {
    if (!activeResolution || activeResolution.searching) return;
    const { conversationId, turnId, assistantMessageId, target } = activeResolution;
    const query = target.query.trim();
    if (!query) return;
    const conversation = conversationById(conversationId);
    if (!conversation || conversation.turn.turnId !== turnId) return;

    setResolutions((current) => {
      const resolution = current[conversationId];
      return !resolution || resolution.turnId !== turnId
        ? current
        : {
            ...current,
            [conversationId]: {
              ...resolution,
              candidates: [],
              searching: true,
              searchError: "",
            },
          };
    });
    mutateConversation(conversationId, (current) => current.turn.turnId !== turnId
      ? current
      : replaceMessage(current, assistantMessageId, (message) => ({
          ...message,
          status: "pending",
          content: `正在重新搜索“${query}”…`,
        })));

    try {
      const result = await fetchJson<PlaceSearchResponse>(
        `/api/places/search?q=${encodeURIComponent(query)}&city=${encodeURIComponent(conversation.trip.pendingIntent?.city ?? activeResolution.intent.city)}`,
      );
      setResolutions((current) => {
        const resolution = current[conversationId];
        return !resolution || resolution.turnId !== turnId
          ? current
          : {
              ...current,
              [conversationId]: {
                ...resolution,
                candidates: result.candidates,
                searching: false,
                searchError: result.candidates.length ? "" : "没有找到匹配地点，请换个关键词。",
              },
            };
      });
      mutateConversation(conversationId, (current) => current.turn.turnId !== turnId
        ? current
        : replaceMessage(current, assistantMessageId, (message) => ({
            ...message,
            kind: "clarification",
            status: "complete",
            content: result.candidates.length
              ? `我找到了新的“${query}”候选，请选择具体地点。`
              : `没有找到“${query}”，请换个关键词再试。`,
          })));
    } catch (error) {
      const message = error instanceof Error ? error.message : "地点搜索失败，请稍后重试。";
      setResolutions((current) => {
        const resolution = current[conversationId];
        return !resolution || resolution.turnId !== turnId
          ? current
          : {
              ...current,
              [conversationId]: { ...resolution, searching: false, searchError: message },
            };
      });
      mutateConversation(conversationId, (current) => current.turn.turnId !== turnId
        ? current
        : replaceMessage(current, assistantMessageId, (item) => ({
            ...item,
            kind: "clarification",
            status: "complete",
            content: message,
          })));
    }
  };

  const cancelResolution = () => {
    if (!activeResolution) return;
    const { conversationId, turnId, assistantMessageId } = activeResolution;
    setResolutions((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    mutateConversation(conversationId, (conversation) => {
      if (conversation.turn.turnId !== turnId) return conversation;
      const timestamp = new Date().toISOString();
      let next = clearPendingConversationIntent(conversation, timestamp);
      next = {
        ...next,
        turn: { ...next.turn, status: "cancelled", updatedAt: timestamp, error: null },
      };
      return replaceMessage(next, assistantMessageId, (message) => ({
        ...message,
        kind: "clarification",
        status: "complete",
        content: "已取消这次修改，原来的路线保持不变。",
      }));
    });
  };

  const refreshCurrentPlan = () => {
    const conversation = activeConversation;
    const intent = conversation?.trip.currentIntent;
    if (!conversation || !intent || !conversation.scenario.ready) return;
    if (["pending", "resolving_places", "planning", "answering"].includes(conversation.turn.status)) return;
    const turnId = newId("turn");
    const userMessage = createChatMessage({
      conversationId: conversation.id,
      turnId,
      role: "user",
      content: "刷新当前路线和天气",
    });
    const assistantMessage = createChatMessage({
      conversationId: conversation.id,
      turnId,
      role: "assistant",
      kind: "status",
      status: "pending",
      content: "正在刷新路线和天气…",
    });
    let next = beginConversationTurn(conversation, { turnId, status: "planning" });
    next = appendConversationMessage(next, userMessage);
    next = appendConversationMessage(next, assistantMessage);
    mutateConversation(conversation.id, () => next);
    void executePlan(conversation.id, turnId, assistantMessage.id, intent);
  };

  const createNewConversation = () => {
    if (activeConversation && activeConversation.messages.length === 0 && !activeConversation.scenario.ready) {
      setHistoryOpen(false);
      setScenarioViewOpen(false);
      return;
    }
    const conversation = createEmptyConversation();
    const nextConversations = [conversation, ...conversationsRef.current];
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    setScenarioDrafts((current) => ({ ...current, [conversation.id]: cloneDefaultScenario() }));
    setActiveConversationId(conversation.id);
    setHistoryOpen(false);
    setScenarioViewOpen(false);
    setComposer("");
  };

  const selectConversation = (id: string) => {
    setActiveConversationId(id);
    setHistoryOpen(false);
    setScenarioViewOpen(false);
    setComposer("");
  };

  const lockActiveScenario = () => {
    if (!activeConversation || activeConversation.scenario.ready) return;
    const draft = scenarioDrafts[activeConversation.id] ?? cloneDefaultScenario();
    mutateConversation(activeConversation.id, (conversation) => lockConversationScenario(conversation, draft));
    setScenarioDrafts((current) => {
      const next = { ...current };
      delete next[activeConversation.id];
      return next;
    });
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const retryMessage = (message: ChatMessage) => {
    const conversation = conversationById(message.conversationId);
    const userMessage = conversation?.messages.find((item) =>
      item.turnId === message.turnId && item.role === "user" && !item.content.startsWith("选择地点："),
    );
    if (userMessage) sendMessage(userMessage.content, message.conversationId);
  };

  const orderedConversations = useMemo(
    () => [...conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [conversations],
  );
  const busy = activeConversation
    ? ["pending", "resolving_places", "planning", "answering"].includes(activeConversation.turn.status)
    : false;
  const amapReady = health ? Object.values(health.providers).every(Boolean) : false;
  const connectionLabel = health?.ready
    ? "实时服务已连接"
    : amapReady && health?.ai.minimax.selected && !health.ai.minimax.configured
      ? "等待 MiniMax 配置"
      : "等待高德凭证";
  const headerWeatherCondition = activeScenario?.enabled
    ? activeScenario.condition
    : activePlan?.weather.condition;
  const headerTemperatureC = activeScenario?.enabled
    ? activeScenario.cabinTemperatureC
    : activePlan?.weather.temperatureC;

  if (!hydrated || !activeConversation) {
    return (
      <main className="cockpit cockpit-loading">
        <div className="app-loading"><NomiOrb active /><strong>正在恢复对话与行程…</strong></div>
      </main>
    );
  }

  const scenarioDraft = scenarioDrafts[activeConversation.id] ?? cloneDefaultScenario();

  return (
    <main className="cockpit">
      <header className="top-bar">
        <div className="brand-lockup">
          <NomiOrb active={busy} />
          <div><span className="eyebrow">NOMI EVERYWHERE</span><strong>出行代理</strong></div>
        </div>
        <div className="top-center-status">
          <span className={`provider-dot ${health?.ready ? "is-ready" : ""}`} />
          {connectionLabel}
          {activeScenario?.enabled && <em>会话场景</em>}
        </div>
        <div className="system-status">
          <span><WeatherIcon />{headerWeatherCondition && headerTemperatureC !== null && headerTemperatureC !== undefined ? `${headerWeatherCondition} ${headerTemperatureC}°` : "--°"}</span>
          <span><BatteryIcon />{currentBattery.toFixed(currentBattery % 1 ? 1 : 0)}%</span>
          <button
            className="icon-button"
            onClick={() => activeConversation.scenario.ready && setScenarioViewOpen(true)}
            disabled={!activeConversation.scenario.ready}
            aria-label="查看本次对话场景"
          >
            <SettingsIcon />
          </button>
        </div>
      </header>

      <section className="cockpit-main conversation-layout">
        <div className="map-region">
          <AmapMap plan={activePlan} />
          <div className="map-floating-status glass-card">
            <span className="stage-kicker">{activePlan ? "计划已生成" : "等待规划"}</span>
            {activePlan ? (
              <>
                <strong>
                  {activePlan.intent.origin.resolved?.name} <ArrowIcon /> {activePlan.intent.stops.map((stop) => stop.resolved?.name ?? stop.query).join(" · ")}
                </strong>
                <div>
                  <span>{formatDistance(activePlan.totalDistanceM)}</span><i />
                  <span>{formatDuration(activePlan.totalDurationSec)}</span><i />
                  <span>{activePlan.departureTime} 出发</span>
                </div>
                <small className="map-snapshot-time">规划于 {historyTime(activeConversation.trip.planUpdatedAt ?? activePlan.createdAt)}</small>
              </>
            ) : (
              <>
                <strong>{activeConversation.scenario.ready ? "上海 · 等待你的出行安排" : "先设置本次对话场景"}</strong>
                <div><span>路线</span><i /><span>天气</span><i /><span>车况</span></div>
              </>
            )}
          </div>

          {activePlan && (
            <div className="route-stop-strip glass-card">
              <div className="route-stop is-origin"><span>{activePlan.intent.origin.resolved?.name ?? activePlan.intent.origin.query}</span><small>{activePlan.departureTime}</small></div>
              {activePlan.stops.map((stop, index) => (
                <div className="route-stop" key={`${stop.place.id}-${index}`}>
                  <span>{stop.place.name}</span><small>{stop.eta}</small>
                </div>
              ))}
            </div>
          )}
        </div>

        <aside className="agent-panel chat-panel">
          <header className="chat-header">
            <button className="chat-header-button" onClick={() => setHistoryOpen(true)} aria-label="查看历史对话">
              <RouteIcon /><span>历史</span>
            </button>
            <div className="chat-title">
              <span className="eyebrow">ACTIVE CONVERSATION</span>
              <strong>{activeConversation.title}</strong>
            </div>
            <div className="chat-header-actions">
              {activeConversation.scenario.ready && (
                <button onClick={() => setScenarioViewOpen(true)}>场景</button>
              )}
              <button className="new-chat-button" onClick={createNewConversation}>＋ 新对话</button>
            </div>
          </header>

          {storageWarning && (
            <div className="storage-warning" role="status">
              <span>{storageWarning}</span>
              <button onClick={() => setStorageWarning("")} aria-label="关闭存储提示"><CloseIcon /></button>
            </div>
          )}

          {!activeConversation.scenario.ready ? (
            <ConversationScenario
              key={activeConversation.id}
              value={scenarioDraft}
              mode="setup"
              onChange={(value) => setScenarioDrafts((current) => ({ ...current, [activeConversation.id]: value }))}
              onConfirm={lockActiveScenario}
            />
          ) : scenarioViewOpen && activeScenario ? (
            <ConversationScenario
              key={activeConversation.id}
              value={activeScenario}
              mode="view"
              onClose={() => setScenarioViewOpen(false)}
            />
          ) : (
            <>
              <div className="chat-messages" ref={messageListRef} role="log" aria-live="polite">
                {activeConversation.messages.length === 0 && (
                  <div className="chat-welcome">
                    <NomiOrb active={false} />
                    <div>
                      <span className="eyebrow">SCENE LOCKED</span>
                      <h1>你好，我是 NOMI</h1>
                      <p>本次对话的场景已经锁定。告诉我你的出行安排，之后可以继续追问或直接修改路线。</p>
                    </div>
                    <div className="chat-quick-prompts">
                      <button onClick={() => setComposer(SAMPLE_PROMPT)}>送孩子再去公司</button>
                      <button onClick={() => setComposer("明天 7:30 从家出发，先去虹桥火车站，再去公司。")}>规划多站行程</button>
                    </div>
                  </div>
                )}

                {activeConversation.messages.map((message) => {
                  const isCurrentPlan = message.planId !== null && message.planId === activePlan?.id;
                  const messageResolution = activeResolution?.assistantMessageId === message.id
                    ? activeResolution
                    : null;
                  return (
                    <div className={`chat-message-row is-${message.role}`} key={message.id}>
                      {message.role === "assistant" && <div className="chat-avatar"><NomiOrb active={message.status === "pending"} /></div>}
                      <div className="chat-message-stack">
                        <div className={`chat-bubble kind-${message.kind} status-${message.status}`}>
                          <p>{message.content}</p>
                          {message.status === "pending" && <span className="typing-dots"><i /><i /><i /></span>}
                        </div>

                        {messageResolution && (
                          <div className="inline-candidates">
                            <div className="inline-place-search">
                              <input
                                aria-label="重新搜索地点"
                                value={messageResolution.target.query}
                                onChange={(event) => updateResolutionQuery(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                                    event.preventDefault();
                                    void researchResolution();
                                  }
                                }}
                                placeholder="换个地点关键词"
                              />
                              <button
                                onClick={() => void researchResolution()}
                                disabled={messageResolution.searching || !messageResolution.target.query.trim()}
                              >
                                {messageResolution.searching ? "搜索中" : "重新搜索"}
                              </button>
                            </div>
                            {messageResolution.searchError && (
                              <small className="inline-search-error">{messageResolution.searchError}</small>
                            )}
                            {messageResolution.candidates.map((place) => (
                              <button key={place.id} onClick={() => chooseCandidate(place)}>
                                <strong>{place.name}</strong>
                                <small>{place.district} · {place.address}</small>
                              </button>
                            ))}
                            <button className="inline-cancel" onClick={cancelResolution}>取消这次修改</button>
                          </div>
                        )}

                        {message.role === "assistant" && message.kind === "plan" && isCurrentPlan && (
                          <div className="message-actions">
                            <button onClick={refreshCurrentPlan}><RouteIcon />刷新路线</button>
                          </div>
                        )}

                        {message.role === "assistant" && message.status === "failed" && (
                          <div className="message-actions"><button onClick={() => retryMessage(message)}>重试这一轮</button></div>
                        )}

                        {message.role === "assistant" && message.kind === "plan" && (
                          <small className="message-provenance">语义理解 · 规则规划 · 高德数据 · NOMI 表达</small>
                        )}
                        <time>{historyTime(message.createdAt)}</time>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="chat-composer">
                <textarea
                  ref={composerRef}
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      sendMessage(composer);
                    }
                  }}
                  placeholder={activeResolution ? "请先选择或取消地点确认" : "继续告诉 NOMI：修改时间、调整站点，或询问当前计划…"}
                  aria-label="与 NOMI 对话"
                  disabled={busy}
                  maxLength={2000}
                  rows={2}
                />
                <button onClick={() => sendMessage(composer)} disabled={busy || !composer.trim()} aria-label="发送消息">
                  <ArrowIcon />
                </button>
                <small>{busy ? "NOMI 正在处理这一轮" : "Enter 发送 · Shift + Enter 换行"}</small>
              </div>
            </>
          )}

          {historyOpen && (
            <div className="history-drawer" role="dialog" aria-modal="true" aria-label="历史对话">
              <div className="history-heading">
                <div><span className="eyebrow">CONVERSATION HISTORY</span><h2>历史对话</h2></div>
                <button className="icon-button" onClick={() => setHistoryOpen(false)} aria-label="关闭历史对话"><CloseIcon /></button>
              </div>
              <button className="history-new-button" onClick={createNewConversation}>＋ 新建一段行程对话</button>
              <div className="history-list">
                {orderedConversations.map((conversation) => {
                  const lastMessage = conversation.messages.at(-1);
                  return (
                    <button
                      className={conversation.id === activeConversation.id ? "is-active" : ""}
                      key={conversation.id}
                      onClick={() => selectConversation(conversation.id)}
                    >
                      <span><strong>{conversation.title}</strong><time>{historyTime(conversation.updatedAt)}</time></span>
                      <small>{conversation.scenario.ready ? (lastMessage?.content ?? "场景已设置，等待开始对话") : "等待设置本次对话场景"}</small>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}
