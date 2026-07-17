const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

export function shanghaiDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value])) as Record<
    string,
    string
  >;
}

export function todayInShanghai(now = new Date()): string {
  const parts = shanghaiDateParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addCalendarDays(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
}

export function resolveRelativeDate(text: string, now = new Date()): string {
  const today = todayInShanghai(now);
  if (/大后天/.test(text)) return addCalendarDays(today, 3);
  if (/后天/.test(text)) return addCalendarDays(today, 2);
  if (/明天|明早|明晚/.test(text)) return addCalendarDays(today, 1);
  if (/今天|今晚|今早/.test(text)) return today;

  const weekdays: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 0,
    天: 0,
  };
  const match = text.match(/(?:下)?(?:周|星期)([一二三四五六日天])/);
  if (!match) return addCalendarDays(today, 1);

  const base = new Date(`${today}T12:00:00+08:00`);
  const target = weekdays[match[1]];
  let delta = (target - base.getDay() + 7) % 7;
  if (delta === 0) delta = 7;
  if (/下(?:周|星期)/.test(match[0])) delta += 7;
  return addCalendarDays(today, delta);
}

export function toShanghaiDate(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+08:00`);
}

export function formatClock(date: Date | string): string {
  const value = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: SHANGHAI_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

export function formatChineseDate(dateString: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: SHANGHAI_TIME_ZONE,
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${dateString}T12:00:00+08:00`));
}
