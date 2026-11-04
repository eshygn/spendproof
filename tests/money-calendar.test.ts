import { describe, expect, it } from "vitest";
import { addDays, addMonths, countWeekdayInMonth, dayNumber, eachDay, formatDate, monthOf, ordinal, weekday } from "@/lib/calendar";
import { formatMoney, fromDecimalString, parseMoney, sumCents, toDecimalString } from "@/lib/money";

describe("money (integer cents only)", () => {
  it("parses decimal strings without floats", () => {
    expect(parseMoney("$1,800.00")).toBe(180000);
    expect(parseMoney("50")).toBe(5000);
    expect(parseMoney("0.1")).toBe(10);
    expect(parseMoney("19.99")).toBe(1999);
    expect(fromDecimalString("0.07")).toBe(7);
  });
  it("rejects ambiguous amounts", () => {
    expect(() => parseMoney("1.234")).toThrow();
    expect(() => parseMoney("abc")).toThrow();
    expect(() => parseMoney("1e3")).toThrow();
  });
  it("formats with currency always shown", () => {
    expect(formatMoney(180000)).toBe("$1,800.00 USD");
    expect(formatMoney(5)).toBe("$0.05 USD");
    expect(formatMoney(40000, { compact: true, currency: false })).toBe("$400");
    expect(formatMoney(-2000)).toBe("−$20.00 USD");
  });
  it("round-trips PayPal decimal strings", () => {
    for (const c of [0, 1, 99, 100, 4200, 123456789]) expect(fromDecimalString(toDecimalString(c))).toBe(c);
    expect(toDecimalString(5000)).toBe("50.00");
  });
  it("refuses non-integer cents", () => {
    expect(() => sumCents([0.1, 0.2])).toThrow();
    expect(sumCents([5000, 2000, 15000])).toBe(22000);
  });
});

describe("calendar", () => {
  it("knows January 2027 has five Fridays and starts on one", () => {
    expect(countWeekdayInMonth("2027-01", 5)).toBe(5);
    expect(weekday("2027-01-01")).toBe(5);
    expect(countWeekdayInMonth("2026-11", 5)).toBe(4);
    expect(countWeekdayInMonth("2026-12", 5)).toBe(4);
  });
  it("does day arithmetic across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(dayNumber("1970-01-02")).toBe(1);
    expect(eachDay("2026-11-29", "2026-12-02")).toEqual(["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"]);
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2027-01", -1)).toBe("2026-12");
    expect(monthOf("2027-01-29")).toBe("2027-01");
  });
  it("formats dates and ordinals", () => {
    expect(formatDate("2027-01-29", { weekday: true, year: true })).toBe("Fri 29 Jan 2027");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 31].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "31st"]);
  });
});
