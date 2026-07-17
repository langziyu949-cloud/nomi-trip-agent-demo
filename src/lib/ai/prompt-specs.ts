import { readFileSync } from "node:fs";
import { join } from "node:path";

const SPEC_FILES = {
  intent: "INTENT_PARSING_SPEC.md",
  narration: "TRIP_NARRATION_SPEC.md",
} as const;

export type PromptSpecName = keyof typeof SPEC_FILES;

export function readPromptSpec(name: PromptSpecName): string {
  return readFileSync(join(process.cwd(), "prompts", SPEC_FILES[name]), "utf8").trim();
}
