import { describe, expect, it, vi } from "vitest";

import { MiniMaxClient, MiniMaxError } from "@/lib/ai/minimax-client";
import type { MiniMaxConfig } from "@/lib/ai/config";

const config: MiniMaxConfig = {
  apiKey: "test-key",
  baseUrl: "https://api.minimaxi.com/v1",
  model: "MiniMax-Test",
  timeoutMs: 1_000,
};

function fetchFromResponse(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe("MiniMaxClient", () => {
  it("通过服务端 Bearer 鉴权调用 OpenAI 兼容接口", async () => {
    const fetchMock = fetchFromResponse(new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      base_resp: { status_code: 0 },
    }), { status: 200 }));
    const client = new MiniMaxClient(config, fetchMock);

    await expect(client.complete({ messages: [{ role: "user", content: "hello" }] })).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.minimaxi.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
  });

  it("将平台限流错误归一化为可重试错误", async () => {
    const client = new MiniMaxClient(config, fetchFromResponse(new Response(JSON.stringify({
      base_resp: { status_code: 1002, status_msg: "rate limit" },
    }), { status: 200 })));

    await expect(client.complete({ messages: [{ role: "user", content: "hello" }] }))
      .rejects.toMatchObject<Partial<MiniMaxError>>({ code: "MINIMAX_RATE_LIMIT", retryable: true });
  });

  it("在请求超时时返回统一错误", async () => {
    const timeoutFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
    const client = new MiniMaxClient({ ...config, timeoutMs: 5 }, timeoutFetch);

    await expect(client.complete({ messages: [{ role: "user", content: "hello" }] }))
      .rejects.toMatchObject<Partial<MiniMaxError>>({ code: "MINIMAX_TIMEOUT", retryable: true });
  });
});
