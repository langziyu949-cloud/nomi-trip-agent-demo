import type { MiniMaxRawIntent } from "@/lib/ai/schemas";
import { readPromptSpec } from "@/lib/ai/prompt-specs";

export const INTENT_PROMPT_VERSION = "nomi-intent-v4";
export const NARRATION_PROMPT_VERSION = "nomi-narration-v2";

function shanghaiNowContext(now: Date): string {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return formatter.format(now);
}

export function buildIntentSystemPrompt(now: Date): string {
  return `${readPromptSpec("intent")}

## 本轮运行时上下文

- 内部调用版本：${INTENT_PROMPT_VERSION}
- 当前时间：${shanghaiNowContext(now)}
- 固定时区：Asia/Shanghai
- 当前支持城市：上海市`;
}

export function buildIntentUserPrompt(text: string): string {
  return `解析这条出行需求：${JSON.stringify(text)}`;
}

export function buildIntentRepairPrompt(
  text: string,
  previousOutput: string,
  validationIssue: string,
): string {
  return `上一次输出不符合结构要求。请重新输出完整、合法且只有一个 JSON 对象。
原始出行需求：${JSON.stringify(text)}
校验问题：${validationIssue.slice(0, 500)}
上一次输出：${previousOutput.slice(0, 4_000)}`;
}

export interface NarrationFacts {
  tripDate: string;
  origin: string;
  departureTime: string;
  stops: Array<{
    name: string;
    eta: string;
    departureTime: string | null;
    dwellMinutes: number;
  }>;
  weather: {
    available: boolean;
    condition: string;
    temperatureC: number | null;
    source: string;
  };
  vehicle: {
    batteryPercent: number;
    estimatedArrivalBattery: number;
    cabinTemperatureC: number;
  };
  planningBufferMinutes: number;
  actions: Array<{
    type: string;
    title: string;
    detail: string;
    severity: string;
    scheduledTime: string | null;
  }>;
}

export function buildNarrationSystemPrompt(): string {
  return `${readPromptSpec("narration")}

内部调用版本：${NARRATION_PROMPT_VERSION}`;
}

export function buildNarrationUserPrompt(facts: NarrationFacts): string {
  return `请根据以下已由规则引擎计算的数据生成总结：${JSON.stringify(facts)}`;
}

export function buildNarrationRepairPrompt(
  facts: NarrationFacts,
  previousOutput: string,
  validationIssue: string,
): string {
  const requiredIntermediateDepartures = facts.stops
    .filter((stop) => stop.departureTime && stop.dwellMinutes > 5)
    .map((stop) => stop.departureTime)
    .join("、");
  const requiredArrivals = facts.stops.map((stop) => stop.eta).join("、");
  const requiredActions = [...new Set(facts.actions.map((action) => action.type))].join("、");
  return `上一次总结没有通过校验，请严格按照规范重新输出 80–180 个中文字符的纯文本。必须原样包含起点出发时间 ${facts.departureTime}、各站到达时间 ${requiredArrivals}${requiredIntermediateDepartures ? `、中途出发时间 ${requiredIntermediateDepartures}` : ""}；必须覆盖动作 ${requiredActions || "无"}，自动车控使用“我会”语气，不得增加任何数字或事实。
校验问题：${validationIssue.slice(0, 300)}
上一次输出：${previousOutput.slice(0, 1_000)}
确定性事实：${JSON.stringify(facts)}`;
}

// Keeps this module tied to the validated contract when fields evolve.
export type IntentPromptContract = MiniMaxRawIntent;
