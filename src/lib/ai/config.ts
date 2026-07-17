export type IntentParserProvider = "mock" | "minimax";
export type TripNarratorProvider = "template" | "minimax";

export interface MiniMaxConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface AIProviderHealth {
  intentParserProvider: IntentParserProvider | "invalid";
  tripNarratorProvider: TripNarratorProvider | "invalid";
  minimax: {
    selected: boolean;
    configured: boolean;
    model: string | null;
    missing: string[];
  };
}

function normalizeProvider<T extends string>(
  value: string | undefined,
  fallback: T,
  allowed: readonly T[],
): T | "invalid" {
  const normalized = (value?.trim().toLowerCase() || fallback) as T;
  return allowed.includes(normalized) ? normalized : "invalid";
}

export function getIntentParserProvider(
  env: NodeJS.ProcessEnv = process.env,
): IntentParserProvider | "invalid" {
  return normalizeProvider(env.INTENT_PARSER_PROVIDER, "mock", ["mock", "minimax"] as const);
}

export function getTripNarratorProvider(
  env: NodeJS.ProcessEnv = process.env,
): TripNarratorProvider | "invalid" {
  return normalizeProvider(env.TRIP_NARRATOR_PROVIDER, "template", ["template", "minimax"] as const);
}

export function allowMockIntentFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.MINIMAX_ALLOW_MOCK_FALLBACK?.trim() ?? "");
}

export function getMiniMaxConfigurationHealth(
  env: NodeJS.ProcessEnv = process.env,
): AIProviderHealth {
  const intentParserProvider = getIntentParserProvider(env);
  const tripNarratorProvider = getTripNarratorProvider(env);
  const requiredConfig: Array<[string, string | undefined]> = [
    ["MINIMAX_API_KEY", env.MINIMAX_API_KEY],
    ["MINIMAX_BASE_URL", env.MINIMAX_BASE_URL],
    ["MINIMAX_MODEL", env.MINIMAX_MODEL],
  ];
  const missing = requiredConfig
    .filter(([, value]) => !value?.trim())
    .map(([key]) => key);
  const selected = intentParserProvider === "minimax" || tripNarratorProvider === "minimax";

  return {
    intentParserProvider,
    tripNarratorProvider,
    minimax: {
      selected,
      configured: missing.length === 0,
      model: env.MINIMAX_MODEL?.trim() || null,
      missing,
    },
  };
}

export function readMiniMaxConfig(env: NodeJS.ProcessEnv = process.env): MiniMaxConfig {
  const health = getMiniMaxConfigurationHealth(env);
  if (!health.minimax.configured) {
    throw new Error(`MiniMax 配置不完整：${health.minimax.missing.join("、")}`);
  }

  const rawTimeout = env.MINIMAX_TIMEOUT_MS?.trim() || "10000";
  const timeoutMs = Number(rawTimeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("MINIMAX_TIMEOUT_MS 必须是 1000 到 120000 之间的整数。 ");
  }

  let baseUrl: string;
  try {
    const parsed = new URL(env.MINIMAX_BASE_URL!.trim());
    const localHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !localHttp) throw new Error("unsupported protocol");
    if (parsed.username || parsed.password) throw new Error("credentials in URL");
    baseUrl = parsed.toString().replace(/\/$/, "");
  } catch {
    throw new Error("MINIMAX_BASE_URL 必须是有效的 HTTPS 地址（本地联调可使用 localhost HTTP）。 ");
  }

  return {
    apiKey: env.MINIMAX_API_KEY!.trim(),
    baseUrl,
    model: env.MINIMAX_MODEL!.trim(),
    timeoutMs,
  };
}
