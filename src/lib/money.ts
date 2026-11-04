/**
 * Money is always an integer number of minor units (cents). Floats never
 * touch an amount: parsing works on the decimal string, formatting on
 * integer division.
 */
export type Cents = number;

export const CURRENCY = "USD" as const;
export type Currency = typeof CURRENCY;

export function assertCents(value: number, label = "amount"): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer number of cents, got ${value}`);
  }
  return value;
}

/** "1,800.5" | "$50" | "50.00" -> cents. Throws on anything ambiguous. */
export function parseMoney(input: string): Cents {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) throw new Error(`Not a money amount: "${input}"`);
  const [, neg, whole, frac = ""] = match;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return assertCents(neg ? -cents : cents);
}

/** Cents -> "50.00" (the decimal string PayPal expects). */
export function toDecimalString(cents: Cents): string {
  assertCents(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** PayPal decimal string -> cents, without going through a float. */
export function fromDecimalString(value: string): Cents {
  return parseMoney(value);
}

/** Cents -> "$1,800.00 USD" style display. */
export function formatMoney(cents: Cents, opts: { currency?: boolean; compact?: boolean } = {}): string {
  assertCents(cents);
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = abs % 100;
  const body = opts.compact && frac === 0 ? `$${whole}` : `$${whole}.${String(frac).padStart(2, "0")}`;
  return `${sign}${body}${opts.currency === false ? "" : " USD"}`;
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += assertCents(v);
  return assertCents(total);
}
