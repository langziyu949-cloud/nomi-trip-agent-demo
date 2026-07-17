import {
  allowMockIntentFallback,
  getIntentParserProvider,
} from "@/lib/ai/config";
import { MiniMaxClient, MiniMaxError } from "@/lib/ai/minimax-client";
import { MiniMaxIntentParser } from "@/lib/ai/minimax-intent-parser";
import { MockIntentParser, type IntentParser } from "@/lib/intent-parser";
import type { TripIntentDraft } from "@/lib/types";

class FallbackIntentParser implements IntentParser {
  constructor(
    private readonly primary: MiniMaxIntentParser,
    private readonly fallback: MockIntentParser,
  ) {}

  async parse(text: string, now?: Date): Promise<TripIntentDraft> {
    try {
      return await this.primary.parse(text, now);
    } catch (error) {
      if (!(error instanceof MiniMaxError)) throw error;
      const draft = await this.fallback.parse(text, now);
      draft.understanding = {
        provider: "mock",
        model: this.primary.model,
        fallback: true,
      };
      return draft;
    }
  }
}

export function createConfiguredIntentParser(
  env: NodeJS.ProcessEnv = process.env,
): IntentParser {
  const provider = getIntentParserProvider(env);
  if (provider === "mock") return new MockIntentParser();
  if (provider === "invalid") {
    throw new MiniMaxError(
      "INTENT_PARSER_PROVIDER 只能设置为 mock 或 minimax。",
      "AI_PROVIDER_INVALID",
      500,
      false,
    );
  }

  const minimax = new MiniMaxIntentParser(MiniMaxClient.fromEnv(env));
  return allowMockIntentFallback(env)
    ? new FallbackIntentParser(minimax, new MockIntentParser())
    : minimax;
}
