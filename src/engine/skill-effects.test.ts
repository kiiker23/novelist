// =============================================================================
// skill-effects.test.ts — active skill-effect durations in Active Modifiers.
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { StateModule } from "../state/state";
import {
  formatSkillEffectValue,
  parseSkillModifier,
  serializeSkillModifier,
  tickSkillEffects,
  formatRemainingTime,
  charmAuraChaBonus,
  parseStatBonuses,
  getSkillEffectStatBonuses,
  activeChaBonus,
  MINUTES_PER_TURN,
} from "./skill-effects";

function resetModifiers(): void {
  StateModule.state.modifiers = {};
}

describe("skill-effect serialization", () => {
  beforeEach(resetModifiers);

  it("serializes a fresh effect with turns and minutes at full duration", () => {
    expect(formatSkillEffectValue(5, "+20% CHA vs attracted targets")).toBe(
      "active (5t/5t, 50m/50m): +20% CHA vs attracted targets",
    );
    // 1 turn = 10 in-game minutes.
    expect(formatSkillEffectValue(1, "Move silently")).toBe(
      `active (1t/1t, ${MINUTES_PER_TURN}m/${MINUTES_PER_TURN}m): Move silently`,
    );
  });

  it("parses the canonical format back into structured fields", () => {
    const p = parseSkillModifier("active (4t/5t, 40m/50m): +20% CHA vs attracted targets");
    expect(p).toEqual({
      turnsLeft: 4,
      turnsTotal: 5,
      minutesLeft: 40,
      minutesTotal: 50,
      effect: "+20% CHA vs attracted targets",
    });
  });

  it("parses the legacy turns-only format, deriving minutes", () => {
    const p = parseSkillModifier("active (3t): Radiate an aura that draws others in");
    expect(p).toEqual({
      turnsLeft: 3,
      turnsTotal: 3,
      minutesLeft: 30,
      minutesTotal: 30,
      effect: "Radiate an aura that draws others in",
    });
  });

  it("returns null for non-skill modifier values (permanent bags, numbers)", () => {
    expect(parseSkillModifier("Tier 2 Shadowcloak — invisible")).toBeNull();
    expect(parseSkillModifier(42)).toBeNull();
    expect(parseSkillModifier(true)).toBeNull();
    expect(parseSkillModifier(undefined)).toBeNull();
  });

  it("round-trips a parsed modifier through serializeSkillModifier", () => {
    const p = parseSkillModifier("active (2t/5t, 20m/50m): Warm aura");
    expect(serializeSkillModifier(p!)).toBe("active (2t/5t, 20m/50m): Warm aura");
  });
});

describe("skill-effect ticking", () => {
  beforeEach(resetModifiers);

  it("decrements remaining turns and minutes by one turn per tick", () => {
    StateModule.state.modifiers.charm_aura = formatSkillEffectValue(5, "+20% CHA");
    tickSkillEffects();
    expect(StateModule.state.modifiers.charm_aura).toBe("active (4t/5t, 40m/50m): +20% CHA");
    tickSkillEffects();
    expect(StateModule.state.modifiers.charm_aura).toBe("active (3t/5t, 30m/50m): +20% CHA");
  });

  it("removes the effect entirely when the last turn ticks down", () => {
    StateModule.state.modifiers.charm_aura = formatSkillEffectValue(2, "+20% CHA");
    tickSkillEffects();
    tickSkillEffects();
    expect(StateModule.state.modifiers.charm_aura).toBeUndefined();
    expect(Object.keys(StateModule.state.modifiers)).toHaveLength(0);
  });

  it("expires legacy turns-only effects too", () => {
    StateModule.state.modifiers.shadow_step = "active (1t): Move silently";
    tickSkillEffects();
    expect(StateModule.state.modifiers.shadow_step).toBeUndefined();
  });

  it("leaves permanent non-skill modifier bags untouched", () => {
    StateModule.state.modifiers.shadowcloak = "Tier 2 Shadowcloak — invisible";
    StateModule.state.modifiers.sneak_difficulty_bonus = "-2 vs same tier";
    StateModule.state.modifiers.charm_aura = formatSkillEffectValue(1, "+20% CHA");
    tickSkillEffects();
    // The skill effect expired; the permanent bags survived.
    expect(StateModule.state.modifiers.shadowcloak).toBe("Tier 2 Shadowcloak — invisible");
    expect(StateModule.state.modifiers.sneak_difficulty_bonus).toBe("-2 vs same tier");
    expect(StateModule.state.modifiers.charm_aura).toBeUndefined();
  });
});

describe("formatRemainingTime", () => {
  it("formats minutes, hours, and days", () => {
    expect(formatRemainingTime(0)).toBe("0 min");
    expect(formatRemainingTime(50)).toBe("50 min");
    expect(formatRemainingTime(60)).toBe("1h");
    expect(formatRemainingTime(130)).toBe("2h 10m");
    expect(formatRemainingTime(24 * 60)).toBe("1 day");
    expect(formatRemainingTime(24 * 60 + 60)).toBe("1 day 1h");
    expect(formatRemainingTime(3 * 24 * 60)).toBe("3 days");
    expect(formatRemainingTime(3 * 24 * 60 + 120)).toBe("3 days 2h");
  });

  it("clamps negative values to zero", () => {
    expect(formatRemainingTime(-10)).toBe("0 min");
  });
});

describe("charmAuraChaBonus — level scaling", () => {
  beforeEach(() => {
    resetModifiers();
    StateModule.state.char.learnedSkills = [];
  });

  it("is zero when the aura is not active", () => {
    StateModule.state.char.learnedSkills.push({
      id: "charm_aura", name: "Charm Aura", description: "Radiate an aura that draws others in",
      category: "social", rarity: "uncommon", level: 3, xpInvested: 0, active: false, props: {},
    });
    expect(charmAuraChaBonus()).toBe(0);
  });

  it("grants base + level: +2 at level 1, +3 at level 2, +5 at level 4", () => {
    StateModule.state.modifiers.charm_aura = formatSkillEffectValue(5, "+20% CHA");
    StateModule.state.char.learnedSkills.push({
      id: "charm_aura", name: "Charm Aura", description: "Radiate an aura that draws others in",
      category: "social", rarity: "uncommon", level: 1, xpInvested: 0, active: false, props: {},
    });
    expect(charmAuraChaBonus()).toBe(2);
    StateModule.state.char.learnedSkills[0].level = 2;
    expect(charmAuraChaBonus()).toBe(3);
    StateModule.state.char.learnedSkills[0].level = 4;
    expect(charmAuraChaBonus()).toBe(5);
  });

  it("defaults to level 1 for an active aura with no learned entry (legacy save)", () => {
    StateModule.state.modifiers.charm_aura = formatSkillEffectValue(5, "+20% CHA");
    expect(charmAuraChaBonus()).toBe(2);
  });

  it("other active skills never touch the CHA bonus", () => {
    StateModule.state.modifiers.shadow_step = formatSkillEffectValue(3, "Move silently");
    expect(charmAuraChaBonus()).toBe(0);
  });
});

describe("parseStatBonuses — custom stat bonuses in effect text", () => {
  it("parses flat bonuses in both orders and multiple stats", () => {
    expect(parseStatBonuses("+3 CHA")).toEqual({ flat: { cha: 3 }, percent: {} });
    expect(parseStatBonuses("CHA +2")).toEqual({ flat: { cha: 2 }, percent: {} });
    expect(parseStatBonuses("+2 STR, +1 AGI")).toEqual({ flat: { str: 2, agi: 1 }, percent: {} });
    expect(parseStatBonuses("-2 CHA")).toEqual({ flat: { cha: -2 }, percent: {} });
  });

  it("parses percentage bonuses as a fraction of the base stat", () => {
    expect(parseStatBonuses("+20% CHA vs attracted targets")).toEqual({ flat: {}, percent: { cha: 0.2 } });
  });

  it("returns empty bonuses when the text declares none", () => {
    expect(parseStatBonuses("Radiate an aura that draws others in")).toEqual({ flat: {}, percent: {} });
    expect(parseStatBonuses("Move silently and blend into darkness")).toEqual({ flat: {}, percent: {} });
    expect(parseStatBonuses("")).toEqual({ flat: {}, percent: {} });
  });
});

describe("getSkillEffectStatBonuses / activeChaBonus", () => {
  beforeEach(() => {
    resetModifiers();
    StateModule.state.char.learnedSkills = [];
  });

  it("applies a declared flat CHA bonus and skips the level fallback", () => {
    StateModule.state.modifiers.charm_aura = "active (5t/5t, 50m/50m): +3 CHA";
    const b = getSkillEffectStatBonuses();
    expect(b.flat.cha).toBe(3);
    expect(b.percent.cha).toBe(0);
    expect(activeChaBonus()).toBe(3);
  });

  it("applies a declared percentage and computes it against the base stat", () => {
    StateModule.state.char.cha = 10;
    StateModule.state.modifiers.charm_aura = "active (5t/5t, 50m/50m): +20% CHA";
    expect(activeChaBonus()).toBe(2);
  });

  it("uses the level-scaled fallback when the aura declares no CHA bonus", () => {
    StateModule.state.modifiers.charm_aura = "active (5t/5t, 50m/50m): Radiate an aura that draws others in";
    StateModule.state.char.learnedSkills.push({
      id: "charm_aura", name: "Charm Aura", description: "Radiate an aura that draws others in",
      category: "social", rarity: "uncommon", level: 3, xpInvested: 0, active: false, props: {},
    });
    const b = getSkillEffectStatBonuses();
    expect(b.flat.cha).toBe(4); // 1 base + 3 levels
  });

  it("stacks bonuses across multiple active skill effects and ignores permanent bags", () => {
    StateModule.state.modifiers.charm_aura = "active (5t/5t, 50m/50m): +3 CHA";
    StateModule.state.modifiers.iron_skin = "active (5t/5t, 50m/50m): +2 STR, +1 AGI";
    StateModule.state.modifiers.shadowcloak = "Tier 2 Shadowcloak — invisible";
    const b = getSkillEffectStatBonuses();
    expect(b.flat).toEqual({ str: 2, agi: 1, int: 0, cha: 3 });
    expect(activeChaBonus()).toBe(3);
  });
});
