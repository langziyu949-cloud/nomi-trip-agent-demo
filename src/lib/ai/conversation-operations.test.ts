import { describe, expect, it } from "vitest";

import { applyConversationOperations } from "@/lib/ai/conversation-operations";
import { DEFAULT_PLACES } from "@/lib/default-places";
import type { TripIntentDraft } from "@/lib/types";

function intent(): TripIntentDraft {
  const departure = {
    type: "DEPART_AT" as const,
    time: "07:30",
    targetStopIndex: 0,
    inferred: false,
  };
  return {
    rawText: "原行程",
    date: "2026-07-18",
    city: "上海市",
    origin: {
      key: "home",
      label: "家",
      query: "家",
      resolved: structuredClone(DEFAULT_PLACES.home),
    },
    stops: [
      {
        key: "school",
        label: "儿子学校",
        query: "儿子学校",
        resolved: structuredClone(DEFAULT_PLACES.school),
      },
      {
        key: "custom-1-东方明珠",
        label: "东方明珠",
        query: "东方明珠",
        resolved: {
          ...structuredClone(DEFAULT_PLACES.company),
          id: "amap-oriental-pearl",
          name: "东方明珠",
          source: "AMAP",
        },
      },
      {
        key: "company",
        label: "我的公司",
        query: "我的公司",
        resolved: structuredClone(DEFAULT_PLACES.company),
      },
    ],
    timeConstraint: {
      type: "ARRIVE_BY",
      time: "10:00",
      targetStopIndex: 1,
      inferred: false,
    },
    timeConstraints: [
      departure,
      { type: "ARRIVE_BY", time: "08:00", targetStopIndex: 0, inferred: false },
      { type: "ARRIVE_BY", time: "10:00", targetStopIndex: 1, inferred: false },
    ],
    preferences: ["precondition_vehicle", "avoid_congestion"],
    confidence: 0.9,
    issues: [],
  };
}

const options = {
  rawText: "追加需求",
  provider: "minimax" as const,
  model: "MiniMax-Test",
  fallback: false,
};

describe("applyConversationOperations", () => {
  it("插入站点时同步后续到达约束下标", () => {
    const original = intent();
    original.stops = original.stops.slice(0, 2);
    original.timeConstraints = [
      { type: "DEPART_AT", time: "07:30", targetStopIndex: 0, inferred: false },
      { type: "ARRIVE_BY", time: "08:00", targetStopIndex: 0, inferred: false },
      { type: "ARRIVE_BY", time: "10:00", targetStopIndex: 1, inferred: false },
    ];
    original.timeConstraint = original.timeConstraints[2];

    const changed = applyConversationOperations(original, [{
      op: "ADD_STOP",
      index: 1,
      place: { kind: "FAVORITE_OR_QUERY", favoriteKey: null, query: "徐家汇公园" },
    }], options);

    expect(changed.stops.map((stop) => stop.label)).toEqual(["儿子学校", "徐家汇公园", "东方明珠"]);
    expect(changed.stops[1].resolved).toBeNull();
    expect(changed.timeConstraints?.map((constraint) => constraint.targetStopIndex)).toEqual([0, 0, 2]);
  });

  it("移动站点时只重映射到达约束，出发约束保持为 0", () => {
    const changed = applyConversationOperations(intent(), [
      { op: "MOVE_STOP", fromIndex: 0, toIndex: 2 },
    ], options);

    expect(changed.stops.map((stop) => stop.label)).toEqual(["东方明珠", "我的公司", "儿子学校"]);
    expect(changed.timeConstraints).toEqual([
      { type: "DEPART_AT", time: "07:30", targetStopIndex: 0, inferred: false },
      { type: "ARRIVE_BY", time: "08:00", targetStopIndex: 2, inferred: false },
      { type: "ARRIVE_BY", time: "10:00", targetStopIndex: 0, inferred: false },
    ]);
  });

  it("保留未修改地点的解析结果，并让替换后的自定义地点重新确认", () => {
    const original = intent();
    const changed = applyConversationOperations(original, [{
      op: "REPLACE_STOP",
      index: 1,
      place: { kind: "FAVORITE_OR_QUERY", favoriteKey: null, query: "上海博物馆" },
    }], options);

    expect(changed.origin.resolved).toEqual(original.origin.resolved);
    expect(changed.stops[0].resolved).toEqual(original.stops[0].resolved);
    expect(changed.stops[1]).toMatchObject({
      label: "上海博物馆",
      query: "上海博物馆",
      resolved: null,
    });
  });

  it("删除站点时保留出发约束并同步后续到达下标", () => {
    const changed = applyConversationOperations(intent(), [
      { op: "REMOVE_TIME_CONSTRAINT", index: 1 },
      { op: "REMOVE_STOP", index: 0 },
    ], options);

    expect(changed.stops.map((stop) => stop.label)).toEqual(["东方明珠", "我的公司"]);
    expect(changed.timeConstraints).toEqual([
      { type: "DEPART_AT", time: "07:30", targetStopIndex: 0, inferred: false },
      { type: "ARRIVE_BY", time: "10:00", targetStopIndex: 0, inferred: false },
    ]);
  });

  it("关闭主动备车时不影响其他偏好", () => {
    const changed = applyConversationOperations(intent(), [
      { op: "SET_PRECONDITION", enabled: false },
    ], options);

    expect(changed.preferences).toEqual(["avoid_congestion"]);
  });

  it("完整重写只复用会话里已有收藏地点的解析结果", () => {
    const changed = applyConversationOperations(intent(), [{
      op: "REWRITE",
      intent: {
        date: "2026-07-20",
        city: "上海市",
        origin: { kind: "FAVORITE_OR_QUERY", favoriteKey: "company", query: null },
        stops: [
          { kind: "FAVORITE_OR_QUERY", favoriteKey: null, query: "虹桥火车站" },
          { kind: "FAVORITE_OR_QUERY", favoriteKey: "home", query: null },
        ],
        timeConstraints: [
          { type: "DEPART_AT", time: "09:15", targetStopIndex: 0, inferred: false },
        ],
        preferences: [],
        confidence: 0.92,
        issues: [],
      },
    }], options);

    expect(changed.origin.resolved?.id).toBe(DEFAULT_PLACES.company.id);
    expect(changed.stops[0].resolved).toBeNull();
    expect(changed.stops[1].resolved?.id).toBe(DEFAULT_PLACES.home.id);
    expect(changed.date).toBe("2026-07-20");
  });
});
