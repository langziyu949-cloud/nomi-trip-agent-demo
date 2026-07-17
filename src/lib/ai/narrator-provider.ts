import { getTripNarratorProvider } from "@/lib/ai/config";
import { MiniMaxClient, MiniMaxError } from "@/lib/ai/minimax-client";
import { MiniMaxTripNarrator } from "@/lib/ai/minimax-trip-narrator";
import { TemplateTripNarrator, type TripNarrator } from "@/lib/ai/trip-narrator";

export function createConfiguredTripNarrator(
  env: NodeJS.ProcessEnv = process.env,
): TripNarrator {
  const provider = getTripNarratorProvider(env);
  if (provider === "template") return new TemplateTripNarrator();
  if (provider === "invalid") {
    throw new MiniMaxError(
      "TRIP_NARRATOR_PROVIDER 只能设置为 template 或 minimax。",
      "AI_PROVIDER_INVALID",
      500,
      false,
    );
  }
  return new MiniMaxTripNarrator(MiniMaxClient.fromEnv(env));
}
