/**
 * Calendar maths in plain TypeScript, on ISO "YYYY-MM-DD" strings in UTC.
 * Time is counted in calendar days; there are no hours anywhere in the rules.
 */
export type IsoDate = string; // YYYY-MM-DD
export type IsoMonth = string; // YYYY-MM

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function parseIso(date: IsoDate): { y: number; m: number; d: number } {
  const match = ISO_RE.exec(date);
  if (!match) throw new Error(`Not an ISO date: ${date}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw new Error(`Invalid date: ${date}`);
  return { y, m, d };
}

export function isIsoDate(value: string): boolean {
  try {
    parseIso(value);
    return true;
  } catch {
    return false;
  }
}

export function iso(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Days since 1970-01-01. */
export function dayNumber(date: IsoDate): number {
  const { y, m, d } = parseIso(date);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function fromDayNumber(n: number): IsoDate {
  const dt = new Date(n * 86_400_000);
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromDayNumber(dayNumber(date) + days);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: IsoDate): number {
  // 1970-01-01 was a Thursday (4).
  return (((dayNumber(date) + 4) % 7) + 7) % 7;
}

export function monthOf(date: IsoDate): IsoMonth {
  return date.slice(0, 7);
}

export function monthParts(month: IsoMonth): { y: number; m: number } {
  const [y, m] = month.split("-").map(Number);
  return { y, m };
}

export function addMonths(month: IsoMonth, n: number): IsoMonth {
  const { y, m } = monthParts(month);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function firstOfMonth(month: IsoMonth): IsoDate {
  return `${month}-01`;
}

export function lastOfMonth(month: IsoMonth): IsoDate {
  const { y, m } = monthParts(month);
  return iso(y, m, daysInMonth(y, m));
}

/** Every date from `from` to `to`, inclusive. */
export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let n = dayNumber(from); n <= dayNumber(to); n++) out.push(fromDayNumber(n));
  return out;
}

export function monthName(month: IsoMonth, short = false): string {
  const { y, m } = monthParts(month);
  return short ? `${MONTHS[m - 1].slice(0, 3)} ${String(y).slice(2)}` : `${MONTHS[m - 1]} ${y}`;
}

export function formatDate(date: IsoDate, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const { y, m, d } = parseIso(date);
  const base = `${d} ${MONTHS[m - 1].slice(0, 3)}`;
  const wd = opts.weekday ? `${WEEKDAYS[weekday(date)].slice(0, 3)} ` : "";
  return `${wd}${base}${opts.year ? ` ${y}` : ""}`;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** How many times a weekday occurs in a month — the "five Fridays" question. */
export function countWeekdayInMonth(month: IsoMonth, wd: number): number {
  return eachDay(firstOfMonth(month), lastOfMonth(month)).filter((d) => weekday(d) === wd).length;
}
