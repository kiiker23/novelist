// =============================================================================
// xp.test.ts — XP threshold computation tests.
//
// Covers: getXpForLevel for every mortal level 1–20 (including a regression
// test for the off-by-one bug where level 2 reported 250 XP instead of 100),
// strictly increasing threshold growth, getNextLevelThreshold, and
// getCurrentLevel boundary round-trips.
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";

// Minimal document stub so UIManager (imported transitively via xp.ts) no-ops
// in a DOM-free test run.
(globalThis as any).document = {
  getElementById: () => null,
  createElement: () => ({
    setAttribute() {},
    click() {},
    remove() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
  }),
  addEventListener: () => {},
  body: { appendChild() {} },
};

import { getXpForLevel, getCurrentLevel, getNextLevelThreshold, XpModule } from "./xp";
import { StateModule } from "../state/state";

/** Designed cumulative XP thresholds, mirroring XP_TABLE in xp.ts. */
const EXPECTED_THRESHOLDS: Record<number, number> = {
  1: 0,
  2: 100,
  3: 250,
  4: 500,
  5: 900,
  6: 1500,
  7: 2300,
  8: 3400,
  9: 4800,
  10: 6500,
  11: 8500,
  12: 11000,
  13: 14000,
  14: 17500,
  15: 22000,
  16: 27500,
  17: 34000,
  18: 42000,
  19: 52000,
  20: 65000,
};

const LEVELS_1_TO_20 = Array.from({ length: 20 }, (_, i) => i + 1);

describe("getXpForLevel — thresholds for every level 1–20", () => {
  it.each(LEVELS_1_TO_20)("level %i requires %i cumulative XP", (level) => {
    expect(getXpForLevel(level)).toBe(EXPECTED_THRESHOLDS[level]);
  });

  it("returns 0 XP for level 1 and below", () => {
    expect(getXpForLevel(1)).toBe(0);
    expect(getXpForLevel(0)).toBe(0);
    expect(getXpForLevel(-5)).toBe(0);
  });

  it("level 2 requires 100 XP, not 250 (off-by-one regression)", () => {
    // Regression: the level number was previously used as a 0-indexed table
    // index, so level 2 read XP_TABLE[2] (250) instead of XP_TABLE[1] (100).
    expect(getXpForLevel(2)).toBe(100);
  });

  it("thresholds grow strictly for every step from level 1 to 20", () => {
    for (let level = 2; level <= 20; level++) {
      expect(getXpForLevel(level)).toBeGreaterThan(getXpForLevel(level - 1));
    }
  });

  it("keeps growing past the mortal cap instead of clamping", () => {
    // Beyond level 20 the table is exhausted; the function doubles the top
    // threshold so cultivation-level progression still has a ceiling to show.
    expect(getXpForLevel(21)).toBe(EXPECTED_THRESHOLDS[20] * 2);
  });
});

describe("getNextLevelThreshold — threshold for the following level", () => {
  it.each(LEVELS_1_TO_20.slice(0, 19))(
    "next threshold after level %i is the level %i threshold",
    (level) => {
      expect(getNextLevelThreshold(level)).toBe(EXPECTED_THRESHOLDS[level + 1]);
    },
  );
});

describe("getCurrentLevel — round-trips every level boundary", () => {
  it.each(LEVELS_1_TO_20)(
    "xp exactly at the level %i threshold maps back to level %i",
    (level) => {
      expect(getCurrentLevel(EXPECTED_THRESHOLDS[level])).toBe(level);
    },
  );

  it.each(LEVELS_1_TO_20.slice(0, 19))(
    "xp one below the next threshold still maps to level %i",
    (level) => {
      const nextThreshold = EXPECTED_THRESHOLDS[level + 1];
      expect(getCurrentLevel(nextThreshold - 1)).toBe(level);
    },
  );

  it("xp at or above the level 20 threshold caps at level 20", () => {
    expect(getCurrentLevel(EXPECTED_THRESHOLDS[20])).toBe(20);
    expect(getCurrentLevel(EXPECTED_THRESHOLDS[20] * 10)).toBe(20);
  });

  it("never returns a level below 1", () => {
    expect(getCurrentLevel(0)).toBe(1);
    expect(getCurrentLevel(-100)).toBe(1);
  });
});

describe("XpModule.getXpProgress", () => {
  beforeEach(() => {
    // getXpProgress reads the live character state, so drive it directly.
    StateModule.state.char.level = 1;
    StateModule.state.char.xp = 0;
  });

  describe("partial progress (level 1, threshold 0 → 100)", () => {
    it("starts at 0% with no XP", () => {
      expect(XpModule.getXpProgress()).toBe(0);
    });

    it("is proportional to XP earned", () => {
      StateModule.state.char.xp = 25;
      expect(XpModule.getXpProgress()).toBe(25);
      StateModule.state.char.xp = 50;
      expect(XpModule.getXpProgress()).toBe(50);
      StateModule.state.char.xp = 99;
      expect(XpModule.getXpProgress()).toBe(99);
    });
  });

  describe("exactly at a threshold", () => {
    it.each([
      [2, 100],
      [3, 250],
      [5, 900],
      [10, 6500],
      [20, 65000],
    ] as const)("level %i at its %i XP threshold shows 0%", (level, threshold) => {
      StateModule.state.char.level = level;
      StateModule.state.char.xp = threshold;
      expect(XpModule.getXpProgress()).toBe(0);
    });
  });

  describe("mid-level progress between thresholds", () => {
    it.each([
      [2, 175, 50], // midpoint of 100 → 250
      [3, 375, 50], // midpoint of 250 → 500
      [10, 7500, 50], // midpoint of 6500 → 8500
    ] as const)("level %i at %i XP is halfway to level %i", (level, xp, expected) => {
      StateModule.state.char.level = level;
      StateModule.state.char.xp = xp;
      expect(XpModule.getXpProgress()).toBe(expected);
    });
  });

  describe("clamping and out-of-range XP", () => {
    it("clamps to 100% when XP exceeds the next threshold", () => {
      StateModule.state.char.xp = 150; // beyond level 2 threshold
      expect(XpModule.getXpProgress()).toBe(100);
    });

    it("never goes below 0% when XP is below the current threshold", () => {
      StateModule.state.char.level = 2;
      StateModule.state.char.xp = 0; // below the 100 XP threshold
      expect(XpModule.getXpProgress()).toBe(0);
    });
  });

  describe("max-level edge cases (level 20, mortal cap)", () => {
    it("shows 0% at exactly the level 20 threshold", () => {
      StateModule.state.char.level = 20;
      StateModule.state.char.xp = 65000;
      expect(XpModule.getXpProgress()).toBe(0);
    });

    it("tracks progress toward the doubled cap threshold", () => {
      // Past the table, getXpForLevel(21) returns 65000 * 2, so the bar
      // measures 65000 → 130000.
      StateModule.state.char.level = 20;
      StateModule.state.char.xp = 97500;
      expect(XpModule.getXpProgress()).toBe(50);
      StateModule.state.char.xp = 130000;
      expect(XpModule.getXpProgress()).toBe(100);
    });

    it("clamps to 100% far past the cap threshold", () => {
      StateModule.state.char.level = 20;
      StateModule.state.char.xp = 65000 * 10;
      expect(XpModule.getXpProgress()).toBe(100);
    });
  });

  describe("beyond the XP table (level 21+)", () => {
    it("reports 100% when the next threshold equals the current one", () => {
      // At level 21 both thresholds collapse to 130000, making the range
      // non-positive — the bar is treated as full.
      StateModule.state.char.level = 21;
      StateModule.state.char.xp = 0;
      expect(XpModule.getXpProgress()).toBe(100);
    });
  });
});
