import { describe, expect, it } from "vitest";

import {
  appendConversationMessage,
  beginConversationTurn,
  clipRecentMessages,
  commitConversationPlan,
  createChatMessage,
  createEmptyConversation,
  draftConversationTitle,
  failConversationTurn,
  lockConversationScenario,
  plannedConversationTitle,
} from "@/lib/conversations";
import { DEFAULT_PLACES, favoriteDraft } from "@/lib/default-places";
import { buildTripPlan } from "@/lib/planner";
import type { DemoSettings, RouteLeg, TripIntentDraft, WeatherContext } from "@/lib/types";

const timestamp = "2026-07-17T08:00:00.000Z";

function intent(rawText = "明早送孩子到学校，然后去公司"): TripIntentDraft {
  return {
    rawText,
    date: "2026-07-18",
    city: "上海市",
    origin: favoriteDraft("home"),
    stops: [favoriteDraft("school"), favoriteDraft("company")],
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

function planFor(draft = intent()) {
  const legs: RouteLeg[] = [
    {
      from: DEFAULT_PLACES.home,
      to: DEFAULT_PLACES.school,
      distanceM: 8_000,
      durationSec: 1_200,
      polyline: [DEFAULT_PLACES.home.location, DEFAULT_PLACES.school.location],
      steps: [],
    },
    {
      from: DEFAULT_PLACES.school,
      to: DEFAULT_PLACES.company,
      distanceM: 20_000,
      durationSec: 1_800,
      polyline: [DEFAULT_PLACES.school.location, DEFAULT_PLACES.company.location],
      steps: [],
    },
  ];
  return buildTripPlan(draft, legs, weather);
}

const demoSettings: DemoSettings = {
  enabled: true,
  condition: "小雪",
  batteryPercent: 42,
  cabinTemperatureC: 8,
  preconditionVehicle: true,
  favoritePlaces: DEFAULT_PLACES,
};

describe("conversation domain", () => {
  it("creates an empty conversation with an unlocked, null scenario", () => {
    const conversation = createEmptyConversation({ id: "conversation-1", now: timestamp });

    expect(conversation).toMatchObject({
      id: "conversation-1",
      title: "新行程",
      messages: [],
      trip: { currentIntent: null, currentPlan: null, pendingIntent: null },
      turn: { turnId: null, status: "idle" },
      scenario: { demoSettings: null, ready: false, lockedAt: null },
    });
  });

  it("locks Demo Lab settings exactly once for a conversation", () => {
    const empty = createEmptyConversation({ id: "conversation-1", now: timestamp });
    const locked = lockConversationScenario(empty, demoSettings, "2026-07-17T08:01:00.000Z");

    expect(empty.scenario.demoSettings).toBeNull();
    expect(locked.scenario).toMatchObject({
      ready: true,
      lockedAt: "2026-07-17T08:01:00.000Z",
      demoSettings: { condition: "小雪", batteryPercent: 42 },
    });
    expect(() => lockConversationScenario(locked, demoSettings)).toThrow(/already locked/);
  });

  it("uses the first user message as a temporary title and a successful route as the final title", () => {
    const empty = createEmptyConversation({ id: "conversation-1", now: timestamp });
    const message = createChatMessage({
      id: "message-1",
      conversationId: empty.id,
      turnId: "turn-1",
      role: "user",
      content: "  明早送孩子到学校，\n然后去公司  ",
      createdAt: timestamp,
    });
    const withMessage = appendConversationMessage(empty, message);
    const started = beginConversationTurn(withMessage, {
      turnId: "turn-1",
      pendingIntent: intent(),
      now: timestamp,
    });
    const plan = planFor();
    const committed = commitConversationPlan(started, {
      turnId: "turn-1",
      intent: plan.intent,
      plan,
      now: timestamp,
    });

    expect(withMessage.title).toBe("明早送孩子到学校， 然后去公司");
    expect(committed.title).toBe("2026-07-18 · 家→我的公司");
    expect(plannedConversationTitle(plan)).toBe(committed.title);
    expect(draftConversationTitle("😀".repeat(30))).toHaveLength(43); // 21 surrogate pairs + ellipsis
  });

  it("clips model history by newest message count and Unicode character budget", () => {
    const conversationId = "conversation-1";
    const messages = ["第一条", "第二条", "😀😀😀😀", "最后一条"].map((content, index) => createChatMessage({
      id: `message-${index}`,
      conversationId,
      turnId: `turn-${index}`,
      role: index % 2 ? "assistant" : "user",
      content,
      createdAt: timestamp,
    }));

    expect(clipRecentMessages(messages, { maxMessages: 2, maxCharacters: 20 })
      .map((message) => message.content)).toEqual(["😀😀😀😀", "最后一条"]);
    expect(clipRecentMessages(messages, { maxMessages: 4, maxCharacters: 6 })
      .map((message) => message.content)).toEqual(["最后一条"]);
    expect(messages[3].content).toBe("最后一条");
  });

  it("keeps the last successful route when a later pending change fails", () => {
    const originalIntent = intent();
    const originalPlan = planFor(originalIntent);
    const initial = commitConversationPlan(
      beginConversationTurn(createEmptyConversation({ id: "conversation-1", now: timestamp }), {
        turnId: "turn-1",
        pendingIntent: originalIntent,
        now: timestamp,
      }),
      { turnId: "turn-1", intent: originalIntent, plan: originalPlan, now: timestamp },
    );
    const changedIntent = intent("改成九点出发");
    changedIntent.timeConstraint.time = "09:00";
    const pending = beginConversationTurn(initial, {
      turnId: "turn-2",
      pendingIntent: changedIntent,
      now: "2026-07-17T08:02:00.000Z",
    });
    const failed = failConversationTurn(pending, {
      turnId: "turn-2",
      error: { message: "路线服务不可用", code: "ROUTE_FAILED", retryable: true },
      now: "2026-07-17T08:03:00.000Z",
    });

    expect(failed.trip.currentPlan).toEqual(originalPlan);
    expect(failed.trip.currentIntent?.timeConstraint.time).toBe("08:00");
    expect(failed.trip.pendingIntent?.timeConstraint.time).toBe("09:00");
    expect(failed.turn.status).toBe("failed");
  });
});
