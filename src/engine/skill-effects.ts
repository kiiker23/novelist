// =============================================================================
// skill-effects.ts — active skill-effect durations in Active Modifiers.
//
// Skill effects ([SKILL_USE] / prose activation) are stored in
// state.modifiers[skillId] as a self-describing string so the value survives
// saves, shows up in the AI's prompt schema, and drives the reaction pipeline
// (Charm Aura warmth, Shadow Step hiding) through isSkillEffectActive. Each
// string carries its own remaining/total duration so the sidebar can render a
// progress indicator and a human-readable remaining time (minutes/hours/days).
//
// Canonical format:  active (4t/5t, 40m/50m): +20% CHA vs attracted targets
// Legacy format:     active (5t): +20% CHA vs attracted targets   (turns only)
//
// This module is a leaf (imports only StateModule) so skill.ts, turn.ts, and
// UIManager.ts can all use it without creating import cycles.
// =============================================================================

import { StateModule } from "../state/state";

/** In-game minutes elapsed per turn — matches TimeStateModule.tick(10). */
export const MINUTES_PER_TURN = 10;

/**
 * True when a skill's effect is currently recorded in Active Modifiers
 * (state.modifiers), i.e. the skill was activated via [SKILL_USE] or prose.
 * Consumed by the reaction pipeline (Charm Aura warmth, Shadow Step hiding)
 * and the stat-check pipeline (Charm Aura's CHA bonus).
 */
export function isSkillEffectActive(skillId: string): boolean {
  return Boolean(StateModule.state.modifiers[skillId]);
}

/**
 * Base CHA bonus from an active Charm Aura, before skill level is added.
 * The total is BASE + level, so a level-1 aura grants +2 (the original
 * bonus), level 2 grants +3, level 3 +4 — investing points in the skill
 * makes the aura meaningfully stronger.
 */
export const CHARM_AURA_BASE_BONUS = 1;

/**
 * CHA bonus from an active Charm Aura, scaled by the skill's level
 * (0 when inactive). Aura active with no learned skill entry (legacy save)
 * defaults to level 1.
 */
export function charmAuraChaBonus(): number {
  if (!isSkillEffectActive("charm_aura")) return 0;
  const level =
    StateModule.state.char.learnedSkills.find((sk) => sk.id === "charm_aura")?.level ?? 1;
  return CHARM_AURA_BASE_BONUS + level;
}

export type StatKey = "str" | "agi" | "int" | "cha";

const STAT_KEYS: StatKey[] = ["str", "agi", "int", "cha"];

/**
 * Parsed stat bonuses from a skill effect's text: flat points ("+3 CHA",
 * "CHA +2", "+2 STR, +1 AGI") and percentages ("+20% CHA" — a fraction of
 * the base stat). Any numeric bonus a skill effect declares replaces the
 * skill's level-based default for that stat.
 */
export interface ParsedStatBonus {
  flat: Partial<Record<StatKey, number>>;
  percent: Partial<Record<StatKey, number>>;
}

/**
 * Parse stat bonuses out of a skill effect's text. Returns empty bonuses when
 * the text declares none (e.g. "Radiate an aura that draws others in").
 */
export function parseStatBonuses(effect: string): ParsedStatBonus {
  const flat: Partial<Record<StatKey, number>> = {};
  const percent: Partial<Record<StatKey, number>> = {};
  const apply = (stat: string, value: number, isPercent: boolean) => {
    const key = stat.toLowerCase() as StatKey;
    if (isPercent) {
      percent[key] = (percent[key] || 0) + value / 100;
    } else {
      flat[key] = (flat[key] || 0) + value;
    }
  };
  const text = effect || "";
  // Number first: "+3 CHA", "+20% CHA".
  const reNumberFirst = /([+-]?\d+(?:\.\d+)?)\s*(%)?\s*(str|agi|int|cha)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = reNumberFirst.exec(text)) !== null) {
    apply(m[3], parseFloat(m[1]), !!m[2]);
  }
  // Stat first: "CHA +2", "CHA +20%".
  const reStatFirst = /\b(str|agi|int|cha)\s*([+-]?\d+(?:\.\d+)?)\s*(%)?/gi;
  while ((m = reStatFirst.exec(text)) !== null) {
    apply(m[1], parseFloat(m[2]), !!m[3]);
  }
  return { flat, percent };
}

/**
 * Total stat bonuses currently granted by ALL active skill effects
 * (state.modifiers entries in the skill-effect format). Each effect's text is
 * parsed for declared bonuses; an active Charm Aura with no declared CHA
 * bonus falls back to the level-scaled default. Non-skill modifier bags
 * ([STATE_UPDATE]) are permanent and grant nothing here.
 */
export function getSkillEffectStatBonuses(): {
  flat: Record<StatKey, number>;
  percent: Record<StatKey, number>;
} {
  const flat: Record<StatKey, number> = { str: 0, agi: 0, int: 0, cha: 0 };
  const percent: Record<StatKey, number> = { str: 0, agi: 0, int: 0, cha: 0 };
  for (const key of Object.keys(StateModule.state.modifiers)) {
    const parsed = parseSkillModifier(StateModule.state.modifiers[key]);
    if (!parsed) continue;
    const bonuses = parseStatBonuses(parsed.effect);
    for (const stat of STAT_KEYS) {
      flat[stat] += bonuses.flat[stat] || 0;
      percent[stat] += bonuses.percent[stat] || 0;
    }
    // Fallback: an active Charm Aura whose effect declares no CHA bonus uses
    // the level-scaled default (base 1 + skill level).
    if (key === "charm_aura" && !bonuses.flat.cha && !bonuses.percent.cha) {
      flat.cha += charmAuraChaBonus();
    }
  }
  return { flat, percent };
}

/**
 * The CHA bonus currently applied by active skill effects (flat + % of base),
 * used by the stat panel chip/tooltip so the displayed number always matches
 * the effective stats.
 */
export function activeChaBonus(): number {
  const b = getSkillEffectStatBonuses();
  return b.flat.cha + Math.floor(StateModule.state.char.cha * b.percent.cha);
}

export interface ParsedSkillModifier {
  turnsLeft: number;
  turnsTotal: number;
  minutesLeft: number;
  minutesTotal: number;
  effect: string;
}

/** Canonical serialized skill effect. */
const SKILL_EFFECT_RE =
  /^active \((\d+)t\/(\d+)t, (\d+)m\/(\d+)m\):\s*(.*)$/i;
/** Pre-duration format: turns only, no minutes. Still ticked and rendered. */
const LEGACY_SKILL_EFFECT_RE = /^active \((\d+)t\):\s*(.*)$/i;

/** Serialize a fresh skill effect at full duration (e.g. 5 turns = 50 min). */
export function formatSkillEffectValue(duration: number, effect: string): string {
  const total = Math.max(1, Math.round(duration));
  return `active (${total}t/${total}t, ${total * MINUTES_PER_TURN}m/${total * MINUTES_PER_TURN}m): ${effect}`;
}

/**
 * Parse an Active Modifiers value into a skill effect. Returns null for
 * anything that isn't a skill effect (plain [STATE_UPDATE] modifier bags,
 * numbers, booleans) — those are permanent and never ticked.
 */
export function parseSkillModifier(value: unknown): ParsedSkillModifier | null {
  if (typeof value !== "string") return null;
  const m = SKILL_EFFECT_RE.exec(value);
  if (m) {
    return {
      turnsLeft: parseInt(m[1], 10),
      turnsTotal: parseInt(m[2], 10),
      minutesLeft: parseInt(m[3], 10),
      minutesTotal: parseInt(m[4], 10),
      effect: m[5],
    };
  }
  const legacy = LEGACY_SKILL_EFFECT_RE.exec(value);
  if (legacy) {
    const turns = parseInt(legacy[1], 10);
    return {
      turnsLeft: turns,
      turnsTotal: turns,
      minutesLeft: turns * MINUTES_PER_TURN,
      minutesTotal: turns * MINUTES_PER_TURN,
      effect: legacy[2],
    };
  }
  return null;
}

/** Re-serialize a parsed skill effect (e.g. after a tick). */
export function serializeSkillModifier(p: ParsedSkillModifier): string {
  return `active (${p.turnsLeft}t/${p.turnsTotal}t, ${p.minutesLeft}m/${p.minutesTotal}m): ${p.effect}`;
}

/**
 * Tick all active skill effects down by one turn (~10 in-game minutes). An
 * effect whose remaining time hits zero is removed from Active Modifiers, so
 * its gameplay consequences genuinely fade: an expired Charm Aura stops
 * warming NPC responses, an expired Shadow Step restores witnesses. Non-skill
 * modifier entries (plain [STATE_UPDATE] bags) are permanent and untouched.
 */
export function tickSkillEffects(): void {
  const s = StateModule.state;
  for (const key of Object.keys(s.modifiers)) {
    const parsed = parseSkillModifier(s.modifiers[key]);
    if (!parsed) continue;
    const turnsLeft = parsed.turnsLeft - 1;
    if (turnsLeft <= 0) {
      delete s.modifiers[key];
    } else {
      s.modifiers[key] = serializeSkillModifier({
        ...parsed,
        turnsLeft,
        minutesLeft: Math.max(0, parsed.minutesLeft - MINUTES_PER_TURN),
      });
    }
  }
}

/**
 * Human-readable remaining time: minutes under an hour, hours+minutes up to a
 * day, whole days beyond. E.g. 30 min, 2h 10m, 3 days.
 */
export function formatRemainingTime(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  if (total < 24 * 60) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const days = Math.floor(total / (24 * 60));
  const rest = total % (24 * 60);
  const h = Math.floor(rest / 60);
  const dayLabel = days === 1 ? "1 day" : `${days} days`;
  return h === 0 ? dayLabel : `${dayLabel} ${h}h`;
}
