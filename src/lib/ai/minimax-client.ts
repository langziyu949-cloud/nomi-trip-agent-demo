import { z } from "zod";

import { readMiniMaxConfig, type MiniMaxConfig } from "@/lib/ai/config";

export type MiniMaxMessageRole = "system" | "user" | "assistant";

export interface MiniMaxMessage {
  role: MiniMaxMessageRole;
  content: string;
}

export interface MiniMaxCompletionRequest {
  messages: MiniMaxMessage[];
  maxCompletionTokens?: number;
  temperature?: number;
}

export interface MiniMaxCompletionClient {
  readonly model: string;
  complete(request: MiniMaxCompletionRequest): Promise<string>;
}

type FetchLike = typeof fetch;

const MiniMaxResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }).passthrough(),
  }).passthrough()).min(1),
  input_sensitive: z.boolean().optional(),
  output_sensitive: z.boolean().optional(),
  base_resp: z.object({
    status_code: z.number().optional(),
    status_msg: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export class MiniMaxError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MiniMaxError";
  }
}

function completionEndpoint(baseUrl: string): string {
  if (/\/chat\/completions\/?$/.test(baseUrl)) return baseUrl;
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function errorFromStatus(status: number, providerCode?: number): MiniMaxError {
  if (status === 401 || status === 403 || providerCode === 1004) {
    return new MiniMaxError("MiniMax API Key 无效或没有模型权限。", "MINIMAX_AUTH", 502, false);
  }
  if (status === 402 || providerCode === 1008) {
    return new MiniMaxError("MiniMax 账户额度不足，请充值或购买可用套餐。", "MINIMAX_BALANCE", 503, false);
  }
  if (status === 429 || providerCode === 1002 || providerCode === 1041) {
    return new MiniMaxError("MiniMax 请求过于频繁，请稍后重试。", "MINIMAX_RATE_LIMIT", 503, true);
  }
  if (providerCode === 1026 || providerCode === 1027) {
    return new MiniMaxError("MiniMax 内容安全检查未通过，请调整输入后重试。", "MINIMAX_CONTENT_SAFETY", 400, false);
  }
  const retryableProviderCodes = [1000, 1001, 1024, 1033, 1039];
  return new MiniMaxError(
    "MiniMax 服务暂时不可用，请稍后重试。",
    "MINIMAX_UPSTREAM",
    502,
    status >= 500 || (providerCode !== undefined && retryableProviderCodes.includes(providerCode)),
  );
}

function providerStatusCode(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const baseResp = (value as { base_resp?: { status_code?: unknown } }).base_resp;
  return typeof baseResp?.status_code === "number" ? baseResp.status_code : undefined;
}

export class MiniMaxClient implements MiniMaxCompletionClient {
  readonly model: string;
  private readonly endpoint: string;

  constructor(
    private readonly config: MiniMaxConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.model = config.model;
    this.endpoint = completionEndpoint(config.baseUrl);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch): MiniMaxClient {
    try {
      return new MiniMaxClient(readMiniMaxConfig(env), fetchImpl);
    } catch (error) {
      throw new MiniMaxError(
        error instanceof Error ? error.message : "MiniMax 配置不完整。",
        "MINIMAX_NOT_CONFIGURED",
        503,
        false,
      );
    }
  }

  async complete(request: MiniMaxCompletionRequest): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
          stream: false,
          max_completion_tokens: request.maxCompletionTokens ?? 2_048,
          temperature: request.temperature ?? 0.2,
        }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      const upstreamCode = providerStatusCode(body);
      if (!response.ok || (upstreamCode !== undefined && upstreamCode !== 0)) {
        throw errorFromStatus(response.status, upstreamCode);
      }

      const parsed = MiniMaxResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new MiniMaxError("MiniMax 返回了无法识别的响应。", "MINIMAX_INVALID_RESPONSE", 502, true);
      }
      if (parsed.data.input_sensitive || parsed.data.output_sensitive) {
        throw errorFromStatus(400, parsed.data.input_sensitive ? 1026 : 1027);
      }

      const content = parsed.data.choices[0]?.message.content.trim();
      if (!content) {
        throw new MiniMaxError("MiniMax 没有返回有效内容。", "MINIMAX_EMPTY_RESPONSE", 502, true);
      }
      return content;
    } catch (error) {
      if (error instanceof MiniMaxError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new MiniMaxError("MiniMax 响应超时，请重试。", "MINIMAX_TIMEOUT", 504, true);
      }
      throw new MiniMaxError("无法连接 MiniMax 服务，请检查网络后重试。", "MINIMAX_NETWORK", 502, true);
    } finally {
      clearTimeout(timer);
    }
  }
}
