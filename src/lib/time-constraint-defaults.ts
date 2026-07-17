import { formatClock, todayInShanghai } from "@/lib/date-utils";

const EXPLICIT_CLOCK_PATTERN = /(?:[01]?\d|2[0-3])[:：][0-5]?\d|[零〇一二两三四五六七八九十0-9]{1,3}(?:点|时)(?:半|[零〇一二两三四五六七八九十0-9]{1,3}分)?/;
const EXPLICIT_CLOCK_PATTERN_GLOBAL = /(?:[01]?\d|2[0-3])[:：][0-5]?\d|[零〇一二两三四五六七八九十0-9]{1,3}(?:点|时)(?:半|[零〇一二两三四五六七八九十0-9]{1,3}分)?/g;

export function hasExplicitClock(text: string): boolean {
  return EXPLICIT_CLOCK_PATTERN.test(text.replace(/\s+/g, ""));
}

export function countExplicitClocks(text: string): number {
  return text.replace(/\s+/g, "").match(EXPLICIT_CLOCK_PATTERN_GLOBAL)?.length ?? 0;
}

export function inferredDepartureTime(text: string, intentDate: string, now: Date): string {
  if (/清晨|早晨|早上|今早|明早/.test(text)) return "08:00";
  if (/中午/.test(text)) return "12:00";
  if (/下午/.test(text)) return "14:00";
  if (/傍晚|晚上|今晚|明晚/.test(text)) return "18:00";

  if (intentDate !== todayInShanghai(now)) return "09:00";

  const candidate = new Date(now.getTime() + 30 * 60 * 1_000);
  if (todayInShanghai(candidate) !== intentDate) return "23:59";
  const [hour, minute] = formatClock(candidate).split(":").map(Number);
  const roundedMinutes = Math.ceil((hour * 60 + minute) / 15) * 15;
  return `${String(Math.floor(roundedMinutes / 60)).padStart(2, "0")}:${String(roundedMinutes % 60).padStart(2, "0")}`;
}
