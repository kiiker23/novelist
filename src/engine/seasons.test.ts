// =============================================================================
// seasons.test.ts — Season derivation from the in-game calendar date.
// =============================================================================

import { describe, it, expect } from "vitest";
import { getSeasonFromTime, normalizeSeasonWord } from "./seasons";

describe("getSeasonFromTime", () => {
  it("maps spring months (Mar-May)", () => {
    expect(getSeasonFromTime("Monday, March 17, 07:00")).toBe("Spring");
    expect(getSeasonFromTime("Saturday, April 12, 19:00")).toBe("Spring");
    expect(getSeasonFromTime("Friday, May 30, 08:00")).toBe("Spring");
  });

  it("maps summer months (Jun-Aug)", () => {
    expect(getSeasonFromTime("Sunday, June 1, 07:00")).toBe("Summer");
    expect(getSeasonFromTime("Tuesday, July 15, 12:00")).toBe("Summer");
    expect(getSeasonFromTime("Monday, August 4, 23:59")).toBe("Summer");
  });

  it("maps autumn months (Sep-Nov)", () => {
    expect(getSeasonFromTime("Monday, September 22, 07:00")).toBe("Autumn");
    expect(getSeasonFromTime("Friday, October 31, 06:30")).toBe("Autumn");
    expect(getSeasonFromTime("Sunday, November 9, 14:00")).toBe("Autumn");
  });

  it("maps winter months (Dec-Feb)", () => {
    expect(getSeasonFromTime("Monday, December 29, 07:00")).toBe("Winter");
    expect(getSeasonFromTime("Friday, January 2, 07:00")).toBe("Winter");
    expect(getSeasonFromTime("Wednesday, February 11, 09:00")).toBe("Winter");
  });

  it("accepts abbreviated month names", () => {
    expect(getSeasonFromTime("Monday, Mar 17, 07:00")).toBe("Spring");
    expect(getSeasonFromTime("Sunday, Jun 1, 07:00")).toBe("Summer");
    expect(getSeasonFromTime("Wednesday, Dec 25, 07:00")).toBe("Winter");
  });

  it("accepts dates with a year", () => {
    expect(getSeasonFromTime("Monday, March 17, 1263, 07:00")).toBe("Spring");
  });

  it("returns undefined when the time has no month", () => {
    expect(getSeasonFromTime("Day 3, 14:30")).toBeUndefined();
    expect(getSeasonFromTime("Monday, 07:00 AM")).toBeUndefined();
    expect(getSeasonFromTime("")).toBeUndefined();
    expect(getSeasonFromTime("somewhere far away")).toBeUndefined();
  });
});

describe("normalizeSeasonWord", () => {
  it("extracts the canonical season from free text", () => {
    expect(normalizeSeasonWord("late autumn")).toBe("Autumn");
    expect(normalizeSeasonWord("mid-winter chill")).toBe("Winter");
    expect(normalizeSeasonWord("fall")).toBe("Autumn");
    expect(normalizeSeasonWord("Summer")).toBe("Summer");
    expect(normalizeSeasonWord("early spring rains")).toBe("Spring");
  });

  it("returns undefined when no season word is present", () => {
    expect(normalizeSeasonWord("the rainy season")).toBeUndefined();
    expect(normalizeSeasonWord("")).toBeUndefined();
    expect(normalizeSeasonWord("midsummer madness")).toBeUndefined();
  });
});
