import { NextResponse } from "next/server";

import { providerHealth } from "@/lib/amap";
import { getMiniMaxConfigurationHealth } from "@/lib/ai/config";

export async function GET() {
  const providers = providerHealth();
  const ai = getMiniMaxConfigurationHealth();
  const aiReady = ai.intentParserProvider !== "invalid" &&
    ai.tripNarratorProvider !== "invalid" &&
    (!ai.minimax.selected || ai.minimax.configured);
  return NextResponse.json({
    ready: Object.values(providers).every(Boolean) && aiReady,
    providers,
    ai,
  });
}
