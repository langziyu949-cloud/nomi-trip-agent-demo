import type { MiniMaxConversationTurn } from "@/lib/ai/conversation-operations";
import { resolveRelativeDate, todayInShanghai } from "@/lib/date-utils";
import type {
  ConversationPlanFacts,
  ConversationPlanFreshness,
} from "@/lib/conversation-turn";
import type { TimeConstraint, TripIntentDraft } from "@/lib/types";

const CHANGE_MARKER = /改|换|调整|挪|延到|推迟|提前到|改为|改成|放到|变成|取消/;
const REALTIME_MARKER = /现在|实时|最新|当前路况|此刻/;
const WEATHER_QUESTION = /天气|温度|气温|下雨|下雪|雨具|雨伞|湿度/;
const ROUTE_QUESTION = /路况|拥堵|堵车|路线|多久|到达|(?:几点|什么时候|何时).{0,3}(?:到|抵达)/;

export function realtimeRefreshForQuestion(text: string): { route: boolean; weather: boolean } | null {
  if (!REALTIME_MARKER.test(text)) return null;
  const weather = WEATHER_QUESTION.test(text);
  const route = ROUTE_QUESTION.test(text) || !weather;
  return { route, weather };
}

export function needsRealtimeRefresh(
  text: string,
  turnId: string,
  freshness: ConversationPlanFreshness,
): { route: boolean; weather: boolean } | null {
  const refresh = realtimeRefreshForQuestion(text);
  if (!refresh || freshness.refreshedForTurnId === turnId) return null;
  return refresh;
}

function chineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [tens, ones] = value.split("十");
    const tensValue = tens ? digits[tens] : 1;
    const onesValue = ones ? digits[ones] : 0;
    if (tensValue === undefined || onesValue === undefined) return null;
    return tensValue * 10 + onesValue;
  }
  return value.length === 1 ? (digits[value] ?? null) : null;
}

function explicitClock(text: string): string | null {
  const colon = text.match(/(?:^|\D)([01]?\d|2[0-3])[:：]([0-5]\d)(?!\d)/);
  if (colon) return `${colon[1].padStart(2, "0")}:${colon[2]}`;

  const clock = text.match(/([零〇一二两三四五六七八九十\d]{1,3})(?:点|时)(半|[零〇一二两三四五六七八九十\d]{1,3}分)?/);
  if (!clock) return null;
  const hour = chineseNumber(clock[1]);
  const minute = clock[2] === "半"
    ? 30
    : clock[2] ? chineseNumber(clock[2].replace(/分$/, "")) : 0;
  if (hour === null || minute === null || hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function explicitDate(text: string, now: Date): string | null {
  const iso = text.match(/(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)/);
  if (iso) {
    const candidate = `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
    const date = new Date(`${candidate}T12:00:00+08:00`);
    return Number.isFinite(date.getTime()) && date.getDate() === Number(iso[3]) ? candidate : null;
  }

  const monthDay = text.match(/([01]?\d)月([0-3]?\d)[日号]/);
  if (monthDay) {
    const currentYear = Number(todayInShanghai(now).slice(0, 4));
    const candidate = `${currentYear}-${monthDay[1].padStart(2, "0")}-${monthDay[2].padStart(2, "0")}`;
    const date = new Date(`${candidate}T12:00:00+08:00`);
    return Number.isFinite(date.getTime()) && date.getDate() === Number(monthDay[2]) ? candidate : null;
  }

  if (/大后天|后天|明天|明早|明晚|今天|今晚|今早|(?:下)?(?:周|星期)[一二三四五六日天]/.test(text)) {
    return resolveRelativeDate(text, now);
  }
  return null;
}

function constraintsFromIntent(intent: TripIntentDraft): TimeConstraint[] {
  return intent.timeConstraints?.length
    ? intent.timeConstraints
    : [intent.timeConstraint];
}

function stopIndexFromText(text: string, intent: TripIntentDraft): number | null {
  if (/第一站|首站/.test(text)) return intent.stops.length > 0 ? 0 : null;
  if (/第二站/.test(text)) return intent.stops.length > 1 ? 1 : null;
  if (/第三站|最后一站|终点/.test(text)) return intent.stops.length > 0 ? intent.stops.length - 1 : null;
  const index = intent.stops.findIndex((stop) => [
    stop.label,
    stop.query,
    stop.resolved?.name,
  ].some((name) => name && text.includes(name)));
  return index >= 0 ? index : null;
}

function timeConstraintOperation(text: string, intent: TripIntentDraft, time: string) {
  const constraints = constraintsFromIntent(intent);
  const activeIndex = Math.max(0, constraints.length - 1);
  const active = constraints[activeIndex];
  const explicitlyDepart = /出发|动身|启程/.test(text);
  const explicitlyArrive = /到达|抵达|前到|到校|送到|上班前|上学前/.test(text);
  const mentionedStopIndex = stopIndexFromText(text, intent);
  const type = explicitlyDepart ? "DEPART_AT" : explicitlyArrive ? "ARRIVE_BY" : active.type;
  const targetStopIndex = type === "DEPART_AT"
    ? 0
    : mentionedStopIndex ?? active.targetStopIndex;
  return {
    op: "SET_TIME_CONSTRAINT" as const,
    index: activeIndex,
    constraint: {
      type,
      time,
      targetStopIndex,
      inferred: false,
    },
  };
}

function selectedStops(text: string, facts: ConversationPlanFacts) {
  if (/第一站|首站/.test(text)) return facts.stops.slice(0, 1);
  if (/第二站/.test(text)) return facts.stops.slice(1, 2);
  if (/第三站/.test(text)) return facts.stops.slice(2, 3);
  if (/最后一站|终点/.test(text)) return facts.stops.slice(-1);
  const mentioned = facts.stops.filter((stop) =>
    text.includes(stop.name)
    || (/公司/.test(text) && /公司|大厦|园区/.test(stop.name))
    || (/学校|到校/.test(text) && /学校|中学|小学|幼儿园/.test(stop.name)),
  );
  return mentioned.length ? mentioned : facts.stops;
}

function groundedRuleAnswer(text: string, facts: ConversationPlanFacts): string | null {
  const parts: string[] = [];
  if (/哪天|日期|几号/.test(text)) {
    parts.push(`这次行程安排在 ${facts.tripDate}`);
  }
  if (/几点出发|什么时候出发|出发时间|何时出发/.test(text)) {
    parts.push(`计划 ${facts.departureTime} 从${facts.origin}出发`);
  }
  if (/(?:几点|什么时候|何时).{0,3}(?:到|抵达)|到达时间|预计到/.test(text)) {
    const stops = selectedStops(text, facts);
    const arrivals = stops
      .map((stop) => `${stop.eta} 到${stop.name}`)
      .join("，");
    parts.push(stops.length === 1 ? `照现在这条路线，${arrivals}` : `各站预计${arrivals}`);
  }
  if (/多久|多长时间|耗时/.test(text)) {
    parts.push(`全程预计 ${facts.totalDurationMinutes} 分钟`);
  }
  if (/多远|里程|多少公里|距离/.test(text)) {
    parts.push(`全程约 ${facts.totalDistanceKm} 公里`);
  }
  if (WEATHER_QUESTION.test(text)) {
    if (!facts.weather.available) {
      parts.push("当前计划没有可靠天气信息");
    } else {
      const temperature = facts.weather.temperatureC === null
        ? ""
        : `，温度 ${facts.weather.temperatureC}°C`;
      const humidity = /湿度/.test(text) && facts.weather.humidity !== null
        ? `，湿度 ${facts.weather.humidity}%`
        : "";
      parts.push(`计划天气为${facts.weather.condition}${temperature}${humidity}`);
    }
  }
  if (/电量|剩(?:余|下|多少)?.{0,2}电|到达.*电|续航/.test(text)) {
    parts.push(`当前电量 ${facts.vehicle.batteryPercent}%，预计行程结束剩余 ${facts.vehicle.estimatedArrivalBattery}%`);
  }
  if (/计划是什么|行程是什么|怎么安排/.test(text)) {
    const route = facts.stops.map((stop) => stop.name).join("、");
    parts.push(`计划 ${facts.departureTime} 从${facts.origin}出发，依次前往${route}`);
  }
  return parts.length ? `${parts.join("；")}。` : null;
}

export interface RuleConversationInput {
  text: string;
  currentIntent: TripIntentDraft;
  planFacts: ConversationPlanFacts | null;
  now: Date;
}

export function interpretConversationWithRules(input: RuleConversationInput): MiniMaxConversationTurn {
  const date = explicitDate(input.text, input.now);
  const time = explicitClock(input.text);
  const hasChange = Boolean(date || time) && (
    CHANGE_MARKER.test(input.text) ||
    (Boolean(time) && /出发|动身|启程|到达|抵达|前到|到校|送到/.test(input.text))
  );
  const answer = input.planFacts ? groundedRuleAnswer(input.text, input.planFacts) : null;

  if (hasChange && answer) {
    return {
      type: "CLARIFY",
      text: "我听到了行程修改和计划问题。请先确认要修改的内容，我更新后再回答最新计划。",
      reason: "AMBIGUOUS_CHANGE",
    };
  }

  if (hasChange) {
    const operations: Extract<MiniMaxConversationTurn, { type: "PLAN_CHANGE" }>["operations"] = [];
    if (date) operations.push({ op: "SET_DATE", date });
    if (time) operations.push(timeConstraintOperation(input.text, input.currentIntent, time));
    return {
      type: "PLAN_CHANGE",
      text: date && time
        ? `好的，行程已改到 ${date}，时间调整为 ${time}。`
        : date
          ? `好的，行程日期已改到 ${date}。`
          : `好的，时间已调整为 ${time}。`,
      operations,
    };
  }

  if (answer) return { type: "ANSWER", text: answer };
  if (!input.planFacts && /几点|天气|路况|多远|公里|电量|到达|出发/.test(input.text)) {
    return {
      type: "CLARIFY",
      text: "当前还没有可查询的成功规划。请先完成一次路线规划。",
      reason: "MISSING_CONTEXT",
    };
  }
  return {
    type: "CLARIFY",
    text: "这条追加需求需要更明确一些。请说明要改日期、出发或到达时间，或具体询问当前计划。",
    reason: "UNSUPPORTED",
  };
}
