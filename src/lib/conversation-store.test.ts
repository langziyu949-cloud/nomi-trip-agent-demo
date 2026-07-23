import { describe, expect, it } from "vitest";

import {
  buildLegacyConversation,
  ConversationStoreError,
  createConversationStore,
  createMemoryConversationStore,
  isConversation,
  LEGACY_DEMO_SETTINGS_STORAGE_KEY,
  LEGACY_INTENT_STORAGE_KEY,
  LEGACY_PLAN_STORAGE_KEY,
  readLegacyConversationSnapshot,
} from "@/lib/conversation-store";
import {
  createEmptyConversation,
  lockConversationScenario,
  type Conversation,
} from "@/lib/conversations";
import { DEFAULT_PLACES, favoriteDraft } from "@/lib/default-places";
import { buildTripPlan } from "@/lib/planner";
import type { DemoSettings, RouteLeg, TripIntentDraft, WeatherContext } from "@/lib/types";

const timestamp = "2026-07-17T08:00:00.000Z";

function makeIntent(): TripIntentDraft {
  return {
    rawText: "明早八点从家出发去公司",
    date: "2026-07-18",
    city: "上海市",
    origin: favoriteDraft("home"),
    stops: [favoriteDraft("company")],
    timeConstraint: { type: "DEPART_AT", time: "08:00", targetStopIndex: 0, inferred: false },
    preferences: ["precondition_vehicle"],
    confidence: 1,
    issues: [],
  };
}

const weather: WeatherContext = {
  available: true,
  condition: "晴",
  temperatureC: 24,
  humidity: 50,
  reportTime: timestamp,
  source: "forecast",
};

function makePlan(intent = makeIntent()) {
  const leg: RouteLeg = {
    from: DEFAULT_PLACES.home,
    to: DEFAULT_PLACES.company,
    distanceM: 20_000,
    durationSec: 1_800,
    polyline: [DEFAULT_PLACES.home.location, DEFAULT_PLACES.company.location],
    steps: [],
  };
  return buildTripPlan(intent, [leg], weather);
}

const settings: DemoSettings = {
  enabled: true,
  condition: "小雪",
  batteryPercent: 42,
  cabinTemperatureC: 8,
  preconditionVehicle: true,
  favoritePlaces: DEFAULT_PLACES,
};

function makePersistedConversation(): Conversation {
  const conversation = buildLegacyConversation({
    intentJson: JSON.stringify(makeIntent()),
    planJson: JSON.stringify(makePlan()),
    demoSettingsJson: JSON.stringify(settings),
  }, { now: timestamp });
  if (!conversation) throw new Error("Expected a legacy conversation fixture.");
  return conversation;
}

const nestedPlanCorruptors: Array<[
  string,
  (conversation: Conversation) => void,
]> = [
  ["leg", (conversation) => {
    conversation.trip.currentPlan!.legs[0].distanceM = Number.NaN;
  }],
  ["polyline", (conversation) => {
    conversation.trip.currentPlan!.legs[0].polyline[0].lng = "invalid" as unknown as number;
  }],
  ["stop", (conversation) => {
    conversation.trip.currentPlan!.stops[0].eta = 800 as unknown as string;
  }],
  ["weather", (conversation) => {
    conversation.trip.currentPlan!.weather.source = "cached" as unknown as WeatherContext["source"];
  }],
  ["vehicle", (conversation) => {
    conversation.trip.currentPlan!.vehicle.batteryPercent = Number.POSITIVE_INFINITY;
  }],
  ["action", (conversation) => {
    conversation.trip.currentPlan!.actions[0].severity = "urgent" as unknown as "info";
  }],
];

describe("MemoryConversationStore", () => {
  it("sorts history, persists the active id and returns defensive clones", async () => {
    const older = lockConversationScenario(
      createEmptyConversation({ id: "older", now: "2026-07-17T07:00:00.000Z" }),
      settings,
      "2026-07-17T07:00:00.000Z",
    );
    const newer = lockConversationScenario(
      createEmptyConversation({ id: "newer", now: "2026-07-17T08:00:00.000Z" }),
      settings,
      "2026-07-17T08:00:00.000Z",
    );
    const store = createMemoryConversationStore();
    await store.saveConversations([older, newer]);
    await store.setActiveConversationId("newer");

    const loaded = await store.loadConversations();
    expect(loaded.map((conversation) => conversation.id)).toEqual(["newer", "older"]);
    expect(await store.getActiveConversationId()).toBe("newer");
    loaded[0].title = "mutated outside store";
    expect((await store.loadConversation("newer"))?.title).toBe("新行程");

    await store.deleteConversation("newer");
    expect(await store.getActiveConversationId()).toBeNull();
  });

  it.each(nestedPlanCorruptors)("rejects a conversation with a damaged nested plan %s", async (_, corrupt) => {
    const conversation = makePersistedConversation();
    corrupt(conversation);

    expect(isConversation(conversation)).toBe(false);
    await expect(createMemoryConversationStore().saveConversation(conversation)).rejects.toMatchObject({
      name: "ConversationStoreError",
      code: "INVALID_DATA",
      operation: "saveConversations",
    });
  });

  it("rejects Demo Lab settings when any required favorite place is missing", async () => {
    const conversation = makePersistedConversation();
    const favorites = conversation.scenario.demoSettings!.favoritePlaces as Partial<
      DemoSettings["favoritePlaces"]
    >;
    delete favorites.school;

    expect(isConversation(conversation)).toBe(false);
    await expect(createMemoryConversationStore().saveConversation(conversation)).rejects.toMatchObject({
      code: "INVALID_DATA",
    });
  });

  it("rejects a message whose conversationId belongs to another conversation", async () => {
    const conversation = makePersistedConversation();
    conversation.messages[0].conversationId = "another-conversation";

    expect(isConversation(conversation)).toBe(false);
    await expect(createMemoryConversationStore().saveConversation(conversation)).rejects.toMatchObject({
      code: "INVALID_DATA",
    });
  });
});

describe("legacy localStorage migration helpers", () => {
  it("copies intent, latest plan and locked Demo Lab settings into one conversation", () => {
    const intent = makeIntent();
    const plan = makePlan(intent);
    let sequence = 0;
    const conversation = buildLegacyConversation({
      intentJson: JSON.stringify(intent),
      planJson: JSON.stringify(plan),
      demoSettingsJson: JSON.stringify(settings),
    }, {
      now: timestamp,
      idFactory: (prefix) => `${prefix}-${++sequence}`,
    });

    expect(conversation).toMatchObject({
      id: "conversation-1",
      title: "2026-07-18 · 家→我的公司",
      trip: {
        currentIntent: { rawText: intent.rawText },
        currentPlan: { id: plan.id },
        pendingIntent: null,
      },
      scenario: {
        ready: true,
        lockedAt: timestamp,
        demoSettings: { condition: "小雪", cabinTemperatureC: 8 },
      },
    });
    expect(conversation?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(conversation?.messages[1]).toMatchObject({ kind: "plan", planId: plan.id });
  });

  it("uses caller defaults when the legacy trip had no override key", () => {
    const conversation = buildLegacyConversation({
      intentJson: JSON.stringify(makeIntent()),
      planJson: null,
      demoSettingsJson: null,
    }, { now: timestamp, defaultDemoSettings: settings });

    expect(conversation?.scenario).toMatchObject({ ready: true, demoSettings: settings });
    expect(conversation?.trip.currentPlan).toBeNull();
  });

  it("does not let an unfinished legacy edit replace the last successful route intent", () => {
    const plannedIntent = makeIntent();
    const plan = makePlan(plannedIntent);
    const editedIntent = makeIntent();
    editedIntent.rawText = "改成九点出发";
    editedIntent.timeConstraint.time = "09:00";
    const conversation = buildLegacyConversation({
      intentJson: JSON.stringify(editedIntent),
      planJson: JSON.stringify(plan),
      demoSettingsJson: JSON.stringify(settings),
    }, { now: timestamp });

    expect(conversation?.trip.currentIntent?.timeConstraint.time).toBe("08:00");
    expect(conversation?.trip.currentPlan?.intent.timeConstraint.time).toBe("08:00");
    expect(conversation?.trip.pendingIntent?.timeConstraint.time).toBe("09:00");
  });

  it("keeps an empty scenario null when neither old settings nor defaults exist", () => {
    const conversation = buildLegacyConversation({
      intentJson: JSON.stringify(makeIntent()),
      planJson: null,
      demoSettingsJson: null,
    }, { now: timestamp });

    expect(conversation?.scenario).toEqual({ demoSettings: null, ready: false, lockedAt: null });
  });

  it("reports malformed legacy data without deleting any source key", () => {
    const values = new Map<string, string>([
      [LEGACY_INTENT_STORAGE_KEY, "{bad json"],
      [LEGACY_PLAN_STORAGE_KEY, JSON.stringify(makePlan())],
      [LEGACY_DEMO_SETTINGS_STORAGE_KEY, JSON.stringify(settings)],
    ]);
    const removed: string[] = [];
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => { removed.push(key); },
    };
    const snapshot = readLegacyConversationSnapshot(storage);

    expect(() => buildLegacyConversation(snapshot)).toThrow(ConversationStoreError);
    expect(removed).toEqual([]);
  });
});

describe("IndexedDbConversationStore", () => {
  it("provides a typed graceful error when IndexedDB is unavailable", async () => {
    const store = createConversationStore({ indexedDB: null, legacyStorage: null });

    await expect(store.loadConversations()).rejects.toMatchObject({
      name: "ConversationStoreError",
      code: "UNAVAILABLE",
      operation: "open",
    });
  });
});
