import { describe, expect, it } from "vitest";

import { MockIntentParser } from "@/lib/intent-parser";

const parser = new MockIntentParser();
const fixedNow = new Date("2026-07-14T02:00:00.000Z");

describe("MockIntentParser", () => {
  it("将标准送娃场景识别为按时到校", async () => {
    const intent = await parser.parse(
      "明早 8 点送孩子到学校，然后去公司，提前准备一下。",
      fixedNow,
    );

    expect(intent.date).toBe("2026-07-15");
    expect(intent.timeConstraint).toMatchObject({
      type: "ARRIVE_BY",
      time: "08:00",
      targetStopIndex: 0,
      inferred: false,
    });
    expect(intent.origin.resolved?.name).toBe("家");
    expect(intent.stops.map((stop) => stop.resolved?.name)).toEqual(["儿子学校", "我的公司"]);
    expect(intent.preferences).toContain("precondition_vehicle");
  });

  it("明确的出发表达不会被解释为到达时间", async () => {
    const intent = await parser.parse(
      "明天 8 点从家出发，先去学校，再去公司。",
      fixedNow,
    );

    expect(intent.timeConstraint.type).toBe("DEPART_AT");
    expect(intent.timeConstraint.time).toBe("08:00");
    expect(intent.stops).toHaveLength(2);
  });

  it("保留任意地点并交给 POI 服务确认", async () => {
    const intent = await parser.parse(
      "后天 7 点半从家出发，先去虹桥火车站，然后去静安嘉里中心。",
      fixedNow,
    );

    expect(intent.date).toBe("2026-07-16");
    expect(intent.timeConstraint.time).toBe("07:30");
    expect(intent.stops[0]).toMatchObject({ query: "虹桥火车站", resolved: null });
    expect(intent.stops[1]).toMatchObject({ query: "静安嘉里中心", resolved: null });
  });

  it("能够识别老婆公司的收藏别名", async () => {
    const intent = await parser.parse("明天 9 点从家出发去老婆公司。", fixedNow);
    expect(intent.stops[0]).toMatchObject({ key: "wifeCompany" });
    expect(intent.stops[0].resolved?.name).toBe("老婆公司");
  });

  it("没有提供时间时使用默认时间继续规划而不阻断", async () => {
    const intent = await parser.parse("明天送孩子上学，然后去公司。", fixedNow);
    expect(intent.issues).toEqual([]);
    expect(intent.timeConstraint).toEqual({
      type: "DEPART_AT",
      time: "09:00",
      targetStopIndex: 0,
      inferred: true,
    });
  });
});
