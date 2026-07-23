import type { MiniMaxRawIntent } from "@/lib/ai/schemas";
import { readPromptSpec } from "@/lib/ai/prompt-specs";

export const INTENT_PROMPT_VERSION = "nomi-intent-v5";
export const NARRATION_PROMPT_VERSION = "nomi-narration-v4";

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
    label: string;
    eta: string;
    departureTime: string | null;
    dwellMinutes: number;
  }>;
  timeConstraints: Array<{
    type: "ARRIVE_BY" | "DEPART_AT";
    time: string;
    targetName: string;
    targetLabel: string;
    plannedTime: string;
    inferred: boolean;
    satisfied: boolean;
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

export interface NarrationTurnGuidance {
  mode: "initial" | "update";
  focus:
    | { kind: "stop_arrival"; targetLabel: string; targetName: string; plannedTime: string }
    | { kind: "departure"; plannedTime: string }
    | {
        kind: "constraint";
        targetLabel: string;
        targetName: string;
        requestedTime: string;
        plannedTime: string;
        satisfied: boolean;
      }
    | { kind: "overview" };
}

export function buildNarrationSystemPrompt(): string {
  return `${readPromptSpec("narration")}

内部调用版本：${NARRATION_PROMPT_VERSION}`;
}

export function buildNarrationUserPrompt(
  facts: NarrationFacts,
  userText?: string,
  guidance?: NarrationTurnGuidance,
): string {
  return `请生成本轮行程回复。
用户本轮原话（仅用于识别用户最关注的目标与自然称呼，不能作为路线结果）：${JSON.stringify(userText?.slice(0, 2_000) ?? "")}
本轮回复策略：${JSON.stringify(guidance ?? { mode: "initial", focus: { kind: "overview" } })}
请先自然回应本轮关注点，不要套用“先确认你最关心的时间/问题/信息”等固定开场。若是 update，只说本轮变化及其直接影响，不要机械复述未变化的旧约束、天气与车控动作。
规则引擎确定性事实（所有结果数字和结论只能来自这里）：${JSON.stringify(facts)}`;
}

export function buildNarrationRepairPrompt(
  facts: NarrationFacts,
  previousOutput: string,
  validationIssue: string,
  userText?: string,
  guidance?: NarrationTurnGuidance,
): string {
  const requiredIntermediateDepartures = facts.stops
    .filter((stop) => stop.departureTime && stop.dwellMinutes > 5)
    .map((stop) => stop.departureTime)
    .join("、");
  const explicitConstraintResults = facts.timeConstraints
    .filter((constraint) => !constraint.inferred)
    .map((constraint) => `${constraint.targetLabel}：要求 ${constraint.time}，计划 ${constraint.plannedTime}，${constraint.satisfied ? "已满足" : "未满足"}`)
    .join("；");
  const mode = guidance?.mode ?? "initial";
  const initialRequirements = mode === "initial"
    ? `首次规划需要交代建议出发时间 ${facts.departureTime}${requiredIntermediateDepartures ? `、中途关键出发时间 ${requiredIntermediateDepartures}` : ""}，并自然合并必要车控与提醒。`
    : "这是后续修改或追问，只回应本轮关注点和直接受影响的结果；不要重复无关的旧目标、天气与车控安排。";
  return `上一次回复没有通过校验，请按照规范重新输出 20–220 个中文字符的纯文本。${initialRequirements}不要使用“先确认你最关心的时间/问题/信息”等固定开场，可以像熟悉用户安排的出行伙伴一样自然承接，但不得增加任何数字或事实。
用户本轮原话：${JSON.stringify(userText?.slice(0, 2_000) ?? "")}
本轮回复策略：${JSON.stringify(guidance ?? { mode: "initial", focus: { kind: "overview" } })}
显式目标核对：${explicitConstraintResults || "本轮没有显式时间目标"}
校验问题：${validationIssue.slice(0, 300)}
上一次输出：${previousOutput.slice(0, 1_000)}
确定性事实：${JSON.stringify(facts)}`;
}

// Keeps this module tied to the validated contract when fields evolve.
export type IntentPromptContract = MiniMaxRawIntent;
