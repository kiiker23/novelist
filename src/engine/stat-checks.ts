// =============================================================================
// stat-checks.ts — the stat-check adjudication framework.
//
// The stat-check pipeline is a contract between the AI and the engine:
//  1. The AI declares which stat a meaningful challenge tests and how hard it
//     is, via [CHECK]{"stat":"CHA","difficulty":"hard","context":"..."}.
//  2. The ENGINE rolls the d20, adds the MC's effective stat (plus a small
//     LCK modifier), and compares the score against the difficulty target.
//  3. The margin maps onto seven outcome tiers — critical failure, major
//     failure, minor failure, neutral, minor success, major success, critical
//     success — surfaced as a compact system line so the player SEES why a
//     check passed or failed instead of guessing at invisible dice.
//  4. Momentum: the outcome modifies the target of the NEXT check on the same
//     stat. Consecutive failures make retrying that line steadily harder (a
//     critical failure adds +4 target, stacking up to the ±6 cap); successes
//     ease it. The next turn's payload carries the reminder so the AI writes
//     the fallout in fiction rather than changing the story to dodge the math.
//
// The AI never invents roll numbers — it declares the stakes, the engine owns
// the dice, and the story flow is preserved because the check line is a
// footnote after the narration, not a replacement for it. Difficulty is
// OPTIONAL: when the AI omits it, inferDifficulty derives it from the story
// (hostile/aggressive NPCs -> hard/brutal, warm targets -> easy, weather and
// darkness by stat) so the check stays consistent with the scene.
// =============================================================================

import { StateModule } from "../state/state";
import { getEffectiveStats } from "./equipment";
import { unwrapJsonBlock } from "./tag-utils";
import { normalizeTags } from "./lore";
import { containsWholeWord } from "./family-names";
import { isAdversarialMention, isCooperativeMention } from "./vacuum-safety";
import { CheckMomentum, CheckOutcome, NPCProfile, Relation } from "../state/GameState";

/** The seven outcome tiers, worst to best. */
export const CHECK_OUTCOMES: CheckOutcome[] = [
  "critical_failure",
  "major_failure",
  "minor_failure",
  "neutral",
  "minor_success",
  "major_success",
  "critical_success",
];

/** Difficulty tiers the AI may declare, mapping to the base target number. */
export const DIFFICULTY_BASE: Record<string, number> = {
  trivial: 5,
  easy: 8,
  moderate: 11,
  hard: 14,
  brutal: 17,
};

export const OUTCOME_LABELS: Record<CheckOutcome, string> = {
  critical_failure: "critical failure",
  major_failure: "major failure",
  minor_failure: "minor failure",
  neutral: "neutral",
  minor_success: "minor success",
  major_success: "major success",
  critical_success: "critical success",
};

/**
 * Target-number modifier the NEXT check on the same line inherits from the
 * previous outcome. Critical failure is a strong penalty, critical success a
 * strong ease; neutral leaves the line untouched.
 */
export const TIER_MOD: Record<CheckOutcome, number> = {
  critical_failure: 4,
  major_failure: 2,
  minor_failure: 1,
  neutral: 0,
  minor_success: -1,
  major_success: -2,
  critical_success: -4,
};

/** Momentum is capped so a long streak can't make checks impossible (or free). */
const MOMENTUM_CAP = 6;

/** Consecutive identical-sign outcomes beyond the first escalate by +1 each, capped. */
const STREAK_ESCALATION_CAP = 2;

/**
 * Target penalty on a declared FALLBACK check when the immediately preceding
 * check in the same turn FAILED: recovering from a blown plan under pressure
 * is harder than a planned attempt. Stacks with same-stat momentum.
 */
const FALLBACK_PENALTY = 2;

/**
 * Fraction of the failed primary's momentum penalty a fallback onto a
 * DIFFERENT stat inherits, so "talk fails, then dodge" feels like the same
 * escalating pressure rather than a fresh roll (e.g. a critical failure's
 * +4 imparts +2 onto the dodge).
 */
const FALLBACK_MOMENTUM_FRACTION = 0.5;

/**
 * Per-NPC scene escalation: a FAILED check against a named hostile NPC arms
 * the scene — the NEXT attempt against that same NPC is +2 target per prior
 * failure (capped), and the fiction escalates (weapon drawn, brandished,
 * ready to strike) until a success defuses it. A second failed talk against
 * the same hostile NPC therefore never repeats the identical check: the
 * stakes visibly rise instead.
 */
const ESCALATION_PER_FAILURE = 2;
const ESCALATION_CAP = 6;
/** An armed scene expires after this many turns without a new failure. */
const ESCALATION_TTL_TURNS = 3;

/** The weapon/stakes stage the MC faces, indexed by stage (1..3). */
const ESCALATION_STAGE_TEXT = [
  "",
  "has drawn a weapon",
  "brandishes a weapon, closing in",
  "is ready to strike at any moment",
];

/**
 * Cross-turn fallback inheritance only reaches back one turn: a dodge
 * declared on the turn right after the blown talk inherits half its
 * momentum; anything older is a fresh scene, not the same pressure.
 */
const LAST_CHECK_TTL_TURNS = 1;

/** Test hook: force the d20 RNG (returns a number in [0, 1)). */
let checkRng: (() => number) | null = null;
export function setCheckRng(rng: (() => number) | null): void {
  checkRng = rng;
}

/**
 * Map an emitted stat name to a comparable value. The four core stats use
 * EFFECTIVE values (cultivation-scaled + gear + active skill bonuses — the
 * same numbers the prompt shows the AI); the secondary stats use their base;
 * the four derived subskills use their computed values. Returns null for
 * unknown names so a malformed tag is skipped without touching momentum.
 */
function statValue(name: string): { label: string; value: number } | null {
  const s = StateModule.state;
  const eff = getEffectiveStats();
  const upper = name.trim().toUpperCase();
  switch (upper) {
    case "STR": return { label: "STR", value: eff.str };
    case "AGI": return { label: "AGI", value: eff.agi };
    case "INT": return { label: "INT", value: eff.int };
    case "CHA": return { label: "CHA", value: eff.cha };
    case "END": return { label: "END", value: s.char.end };
    case "WIL": return { label: "WIL", value: s.char.wil };
    case "LCK": return { label: "LCK", value: s.char.lck };
    case "PER": return { label: "PER", value: s.char.per };
    case "SNEAKING": return { label: "Sneaking", value: (s.subskills as any).sneaking ?? 0 };
    case "SEDUCTION": return { label: "Seduction", value: (s.subskills as any).seduction ?? 0 };
    case "NEGOTIATION": return { label: "Negotiation", value: (s.subskills as any).negotiation ?? 0 };
    case "INTIMIDATION": return { label: "Intimidation", value: (s.subskills as any).intimidation ?? 0 };
    default: return null;
  }
}

/** A parsed (not yet resolved) [CHECK] declaration. */
export interface ParsedCheck {
  stat: string;
  /** Explicitly declared difficulty (only when the AI named a valid tier). */
  difficulty?: string;
  /** False when the AI omitted difficulty (or garbled it) -> engine infers. */
  difficultyDeclared?: boolean;
  context?: string;
  /**
   * True when this check is a FALLBACK: a different-stat recovery attempt
   * declared after another check in the same turn ("talk your way out, and
   * if that fails, dodge"). The engine hardens it when the immediately
   * preceding check failed.
   */
  fallback?: boolean;
}

/** A fully resolved check: the math, the outcome, and the chat line. */
export interface CheckResult {
  turn: number;
  stat: string;
  statLabel: string;
  difficulty: string;
  /** True when the engine inferred the difficulty (AI omitted it). */
  inferred: boolean;
  roll: number;
  lckMod: number;
  effectiveStat: number;
  score: number;
  target: number;
  /** Momentum modifier applied to THIS check (from the previous attempt). */
  momentumMod: number;
  outcome: CheckOutcome;
  context?: string;
  /** True when declared as a recovery attempt after another check. */
  fallback?: boolean;
  /** Target penalty applied because the preceding check failed (+2 base). */
  fallbackMod?: number;
  /** Half the failed primary's momentum penalty carried into this fallback. */
  fallbackInheritedMod?: number;
  /** The failed primary check's stat label, when inheritance applied. */
  fallbackFrom?: string;
  /** Target penalty from a still-armed scene (the NPC drew a weapon). */
  escalationMod?: number;
  /** NPC the scene escalated against (primary name), when armed. */
  escalationNpc?: string;
  /** Weapon/stakes stage the MC faces this turn (1..3). */
  escalationStage?: number;
  line: string;
}

/** Outcomes that count as a failure (a fallback after one is harder). */
function isFailure(outcome: CheckOutcome): boolean {
  return (
    outcome === "critical_failure" ||
    outcome === "major_failure" ||
    outcome === "minor_failure"
  );
}

function rollD20(): number {
  const r = checkRng ? checkRng() : Math.random();
  return Math.min(20, Math.max(1, Math.floor(r * 20) + 1));
}

/** Parse [CHECK] blocks (JSON payload, recovery-wrapped like other tags). */
export function parseCheckBlocks(text: string): ParsedCheck[] {
  const out: ParsedCheck[] = [];
  const re = /\[CHECK\](.*?)\[\/CHECK\]/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const data = JSON.parse(unwrapJsonBlock(m[1]));
      if (!data || typeof data.stat !== "string" || !data.stat.trim()) continue;
      const declared = typeof data.difficulty === "string" ? data.difficulty.trim().toLowerCase() : "";
      const valid = DIFFICULTY_BASE[declared] !== undefined;
      out.push({
        stat: data.stat.trim(),
        // An omitted (or garbled) difficulty is left to the engine's
        // inference so hostile NPCs and weather still shape the check.
        difficulty: valid ? declared : undefined,
        difficultyDeclared: valid,
        context:
          typeof data.context === "string" && data.context.trim()
            ? data.context.trim()
            : undefined,
        fallback: data.fallback === true,
      });
    } catch {
      /* malformed block — skip without touching state */
    }
  }
  return out;
}

// =============================================================================
// Difficulty inference — when the AI omits (or garbles) the difficulty, the
// engine derives it from the story so it stays consistent: hostile/aggressive
// NPCs default to hard (brutal for the truly dangerous), friendly targets
// ease the check, adverse weather raises physical and perception checks, and
// cover (rain/darkness) eases Sneaking. Mirrors the ambient conditions the
// witness pipeline uses (vacuum-safety.ts) so one scene means one thing.
// =============================================================================

const TIER_ORDER = ["trivial", "easy", "moderate", "hard", "brutal"] as const;

/** Locations that count as shelter (weather can't reach the MC) — see vacuum-safety. */
const INDOOR_LOCATION_RE =
  /bedroom|kitchen|bathroom|living room|house|apartment|home|dorm|classroom|office|shop|store|tavern|inn|bar|cafe|restaurant|hall|library|temple|shrine|cabin|room|building|station|hospital|lab|smithy|forge|diner|auditorium|gym|study|studio|warehouse|garage/i;

/** Weather that makes physical feats harder (and muffles sound). */
const ADVERSE_WEATHER_RE =
  /rain|drizzle|downpour|storm|sleet|shower|monsoon|snowstorm|blizzard|snowing heavily|hail|snow/i;

/** Recorded lighting that implies poor visibility. */
const DARK_LIGHTING_RE =
  /dark|pitch[- ]?black|unlit|dim|moonless|blackout|shadowy|gloomy|no lights?|lights? (off|out)|flickering candle|lanternlight only|torchlight only/i;

/** Disposition phrasing that marks a hostile target. */
const HOSTILE_DISP_RE =
  /\b(hostile|aggressive|enemy|rival|angry|furious|fuming|livid|hates?|loathes?|despises?|vengeful|grudg(?:e|ing)|belligerent|antagonistic)\b/i;

/** Disposition phrasing that marks a warm target (persuasion is easier). */
const WARM_DISP_RE =
  /\b(friendly|close friend|warm|kind|affectionate|devoted|loyal|depend(?:ent|s)|submissive|infatuated|in love|crush|adoring|fond|smitten|drunk)\b/i;

/** Social stats that benefit from a warm room; hostility raises ALL checks. */
const SOCIAL_STATS = new Set(["CHA", "SEDUCTION", "NEGOTIATION"]);

/**
 * Generic ally phrasing in the player's action: an unregistered friend
 * vouching, helping, covering, or working alongside the MC. When the check
 * names nobody, this is all the engine knows of the cooperation — and it
 * defuses an ambient hostile crowd the same way a named ally does.
 */
const ALLY_ACTION_RE =
  /\b(vouches? (?:for|on behalf of)|helps? (?:you|me|us)|assists? (?:you|me|us)|backs? (?:you|me|us) up|covers? for (?:you|me|us)|works? with (?:you|me|us)|teams? up with (?:you|me|us)|joins? (?:you|me|us)|stands? with (?:you|me|us)|sides? with (?:you|me|us)|speaks? (?:up )?for (?:you|me|us)|accompanies? (?:you|me|us)|distracts? (?:the|that) (?:guard|soldier|watchman)|guards? (?:your|my) back)\b/i;

/** Physical stats hurt by weather. */
const PHYSICAL_STATS = new Set(["STR", "AGI", "END"]);

function shiftTier(base: string, delta: number): string {
  const idx = TIER_ORDER.indexOf(base as (typeof TIER_ORDER)[number]);
  if (idx === -1) return base;
  return TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, idx + delta))];
}

function currentScene() {
  const s = StateModule.state;
  const key = (s.worldState.location || "").trim().toLowerCase();
  return s.sceneLog && s.sceneLog[key];
}

function isOutdoor(): boolean {
  return !INDOOR_LOCATION_RE.test((StateModule.state.worldState.location || "").toLowerCase());
}

function hasAdverseWeather(): boolean {
  const w = (currentScene()?.weather || "").toLowerCase();
  return ADVERSE_WEATHER_RE.test(w);
}

function currentHour(): number | undefined {
  const m = (StateModule.state.worldState.time || "").match(/\b(\d{1,2}):\d{2}\b/);
  if (!m) return undefined;
  const h = parseInt(m[1], 10);
  return Number.isFinite(h) ? h : undefined;
}

/** Dark: recorded dark lighting, or outdoor night (mirrors the witness module). */
function isDark(): boolean {
  const lighting = currentScene()?.lighting;
  if (typeof lighting === "string" && DARK_LIGHTING_RE.test(lighting)) return true;
  if (isOutdoor()) {
    const hour = currentHour();
    if (hour !== undefined && (hour < 6 || hour >= 22)) return true;
  }
  return false;
}

/** Cover: rain/snow outdoors, or darkness — the conditions the sneak synergy rides. */
function hasCover(): boolean {
  return (isOutdoor() && hasAdverseWeather()) || isDark();
}

/** Living NPC profiles physically at the MC's location. */
function presentProfiles(): NPCProfile[] {
  const s = StateModule.state;
  const loc = (s.worldState.location || "").toLowerCase();
  const deceased = new Set<string>();
  for (const r of s.memory.relations || []) {
    if (r.status === "Deceased") {
      deceased.add(r.name.toLowerCase());
      for (const a of r.aliases || []) deceased.add(a.toLowerCase());
    }
  }
  return s.npcProfiles.filter(
    (p) =>
      !deceased.has(p.npcName.toLowerCase()) &&
      p.knownLocation &&
      p.knownLocation.toLowerCase() === loc,
  );
}

function relationOf(name: string): Relation | undefined {
  return StateModule.state.memory.relations.find(
    (r) => r.name.toLowerCase() === name.toLowerCase(),
  );
}

/**
 * The difficulty a single target suggests: hostility always raises it
 * (aggressive numbers or hostile disposition), warmth eases it. Hostile
 * always beats warm — worst case first.
 */
function targetTier(profile?: NPCProfile, relation?: Relation): string {
  if (profile && profile.aggressionThreshold >= 80) return "brutal";
  if (profile && profile.aggressionThreshold >= 60) return "hard";
  if (relation && HOSTILE_DISP_RE.test(relation.disposition || "")) return "hard";
  if (
    (profile && (profile.affection >= 70 || profile.trust >= 70)) ||
    (relation && WARM_DISP_RE.test(relation.disposition || ""))
  ) {
    return "easy";
  }
  return "moderate";
}

/**
 * Resolve who the check is against: an NPC named in the check's context or
 * in the player's action text (by primary name or relation alias, whole-word
 * so "Mara" never matches "Marabel"). Returns null when nobody is targeted.
 */
function findNamedTarget(
  parsed: { context?: string },
  actionText?: string,
): { profile?: NPCProfile; relation?: Relation } | null {
  const s = StateModule.state;
  const hay = [parsed.context, actionText].filter(Boolean).join(" ");
  if (!hay.trim()) return null;
  const aliases = new Map<string, string[]>();
  const deceased = new Set<string>();
  for (const r of s.memory.relations || []) {
    aliases.set(r.name.toLowerCase(), (r.aliases || []).map((a) => a.toLowerCase()));
    if (r.status === "Deceased") {
      deceased.add(r.name.toLowerCase());
      for (const a of r.aliases || []) deceased.add(a.toLowerCase());
    }
  }
  for (const p of s.npcProfiles) {
    if (deceased.has(p.npcName.toLowerCase())) continue;
    const names = [p.npcName, ...(aliases.get(p.npcName.toLowerCase()) || [])].filter(Boolean);
    if (names.some((n) => containsWholeWord(hay, n))) {
      return { profile: p, relation: relationOf(p.npcName) };
    }
  }
  for (const r of s.memory.relations || []) {
    if (deceased.has(r.name.toLowerCase())) continue;
    const names = [r.name, ...(r.aliases || [])].filter(Boolean);
    if (names.some((n) => containsWholeWord(hay, n))) return { relation: r };
  }
  return null;
}

/**
 * How the player's ACTION text treats the named target this turn: working
 * WITH them (cooperative), against them (adversarial), or unstated (neutral
 * -> the recorded state decides). Resolves by primary name and aliases, so
 * "Zhao vouches for you" matches the NPC registered as "Vice-Principal
 * Zhao" with alias "Zhao". Adversarial wins over cooperative when both
 * markers sit around different mentions of the same person.
 */
function actionNamesCooperatively(
  actionText: string | undefined,
  target: { profile?: NPCProfile; relation?: Relation },
): boolean {
  if (!actionText) return false;
  const names = new Set<string>();
  if (target.profile) names.add(target.profile.npcName);
  if (target.relation) {
    names.add(target.relation.name);
    for (const a of target.relation.aliases || []) names.add(a);
  }
  for (const n of names) {
    if (isAdversarialMention(actionText, n)) return false;
  }
  for (const n of names) {
    if (isCooperativeMention(actionText, n)) return true;
  }
  return false;
}

/**
 * Whether a failed check against this named target may ARM the scene: the
 * target is hostile by record (aggression/disposition -> hard or brutal) or
 * the action itself reads as adversarial ("talk my way past Zhao") even if
 * the state hasn't caught up with the fiction. A friendly NPC drawing a
 * weapon on a failed chat would be absurd, so warm targets never arm.
 */
function isEscalationCandidate(
  target: { profile?: NPCProfile; relation?: Relation },
  actionText?: string,
): boolean {
  const tier = targetTier(target.profile, target.relation);
  if (tier === "hard" || tier === "brutal") return true;
  if (actionText) {
    // Primary name AND aliases ("talk my way past Elle" matches the profile
    // registered as "Librarian Elle" with alias "Elle").
    const names: string[] = [];
    if (target.profile) names.push(target.profile.npcName);
    if (target.relation) {
      names.push(target.relation.name);
      for (const a of target.relation.aliases || []) names.push(a);
    }
    for (const n of names) {
      if (isAdversarialMention(actionText, n)) return true;
    }
  }
  return false;
}

/** The escalation key + display name for a named target, or null. */
function namedTargetNpc(
  target: { profile?: NPCProfile; relation?: Relation } | null,
): { key: string; name: string } | null {
  if (!target) return null;
  const name = target.profile?.npcName || target.relation?.name;
  if (!name) return null;
  return { key: name.toLowerCase(), name };
}

/** The weapon stage for a given failure count (1..3, capped). */
function escalationStage(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(failures, 3);
}

/**
 * Infer a difficulty tier from the story when the AI omits it. Priority:
 * the NAMED target (hostile -> hard/brutal, warm -> easy, but an action
 * that works WITH the target overrides hostility and eases it), else the
 * mood of everyone present (hostility raises, warmth eases social checks,
 * but an action that works WITH an ally defuses the hostile crowd), then
 * the scene (weather/lighting/cover by stat). Always falls back to
 * moderate.
 */
export function inferDifficulty(
  parsed: { stat: string; context?: string },
  actionText?: string,
): string {
  const stat = parsed.stat.trim().toUpperCase();
  let tier = "moderate";

  const named = findNamedTarget(parsed, actionText);
  if (named) {
    // The player's own action can override the state's hostility: when the
    // action explicitly works WITH the target ("Zhao vouches for you",
    // "you and Zhao cover the square"), their help eases the check instead
    // of their recorded disposition making it hard. An adversarial mention
    // ("talk my way past Zhao") still reads as hostile — judged first.
    if (actionNamesCooperatively(actionText, named)) {
      tier = "easy";
    } else {
      tier = targetTier(named.profile, named.relation);
    }
  } else {
    // Ambient mood: any present hostile raises it; warmth only eases social
    // checks (a friendly room doesn't make a STR feat trivial).
    const present = presentProfiles();
    let ambient = "moderate";
    let sawWarm = false;
    for (const p of present) {
      const t = targetTier(p, relationOf(p.npcName));
      if (t === "brutal") {
        ambient = "brutal";
        break;
      }
      if (t === "hard") ambient = "hard";
      if (t === "easy") sawWarm = true;
    }
    // Cooperation overrides the room's hostility exactly like it overrides a
    // named target's: an action that resolves by working WITH someone ("Rook
    // vouches for me", "my friend covers for me") defuses an ambient hostile
    // crowd even when the ally has no registered profile yet — the check
    // reads as tense-but-viable, not an automatic hard/brutal one. (A
    // REGISTERED ally never reaches this branch — findNamedTarget routes
    // them to the named-target override above.)
    if (
      (ambient === "brutal" || ambient === "hard") &&
      actionText &&
      ALLY_ACTION_RE.test(actionText)
    ) {
      ambient = ambient === "brutal" ? "hard" : "moderate";
      sawWarm = true;
    }
    if (ambient === "moderate" && sawWarm && SOCIAL_STATS.has(stat)) ambient = "easy";
    tier = ambient;
  }

  // Scene modifiers stack on top: weather hampers physical feats, darkness
  // hampers perception, and cover helps sneaking (the same conditions the
  // witness pipeline treats as cover).
  if (PHYSICAL_STATS.has(stat) && isOutdoor() && hasAdverseWeather()) {
    tier = shiftTier(tier, 1);
  }
  if (stat === "PER" && isDark()) {
    tier = shiftTier(tier, 1);
  }
  if (stat === "SNEAKING" && hasCover()) {
    tier = shiftTier(tier, -1);
  }
  return tier;
}

/**
 * The target penalty the most recent check on `key` IMPARTS on the next
 * attempt on that same line (TIER_MOD + streak escalation, capped). Only the
 * positive side matters here — a fallback inherits pressure, never ease.
 */
function impartedPenalty(key: string): number {
  const s = StateModule.state;
  const m = s.checkMomentum[key];
  if (!m) return 0;
  let mod = TIER_MOD[m.outcome];
  if (mod !== 0) {
    const extra = Math.min(m.streak - 1, STREAK_ESCALATION_CAP);
    mod += extra * Math.sign(mod);
  }
  mod = Math.max(-MOMENTUM_CAP, Math.min(MOMENTUM_CAP, mod));
  return Math.max(0, mod);
}

/**
 * Resolve one parsed check: roll, apply momentum + LCK, derive the outcome,
 * record it, and update the per-stat momentum. Returns null when the stat
 * name is unknown (the check is silently ignored).
 */
export function resolveCheck(
  parsed: ParsedCheck,
  actionText?: string,
  /** The check that resolved immediately before this one in the same turn. */
  prevResult?: CheckResult | null,
): CheckResult | null {
  const s = StateModule.state;
  const sv = statValue(parsed.stat);
  if (!sv) return null;
  const key = parsed.stat.trim().toUpperCase();

  // Momentum: the previous outcome on this same line modifies the target.
  // Consecutive same-sign outcomes escalate (+1 per extra attempt, capped)
  // so "keep bashing your head against it" genuinely gets harder.
  const prev: CheckMomentum | undefined = s.checkMomentum[key];
  let mod = prev ? TIER_MOD[prev.outcome] : 0;
  if (prev && mod !== 0) {
    const extra = Math.min(prev.streak - 1, STREAK_ESCALATION_CAP);
    mod += extra * Math.sign(mod);
  }
  mod = Math.max(-MOMENTUM_CAP, Math.min(MOMENTUM_CAP, mod));

  // Fallback: a declared recovery attempt ("if the talk fails, I dodge")
  // is harder when the immediately preceding check in this turn FAILED —
  // reacting to a blown plan under pressure. Stacks with same-stat momentum
  // when the fallback retries the same line. A fallback onto a DIFFERENT
  // stat additionally inherits half the failed primary's momentum penalty
  // (what a retry of that line would face), so the dodge after a blown talk
  // carries the same mounting pressure instead of rolling fresh.
  //
  // The failed primary is the check that resolved just before in this turn
  // — OR, when the player declares the recovery on the NEXT turn, the
  // persisted last-failed-check from the previous turn ("the talk blew up
  // yesterday; today's dodge is under the same pressure, not a fresh
  // roll"). The persisted source is consumed when a fallback inherits it.
  // Same-turn failed primary: ANY preceding failure earns the flat +2, but
  // the inherited half-fraction only flows when the fallback lands on a
  // DIFFERENT stat (a same-stat fallback already carries the full line
  // penalty via momentum — no double-dipping).
  const prevFailedAny = prevResult && isFailure(prevResult.outcome) ? prevResult : null;
  const prevFailedOther = prevFailedAny && prevFailedAny.stat !== key ? prevFailedAny : null;
  const crossTurn =
    parsed.fallback &&
    !prevFailedAny &&
    !!s.lastFailedCheck &&
    s.lastFailedCheck!.stat !== key &&
    s.turnCount - s.lastFailedCheck!.turn <= LAST_CHECK_TTL_TURNS;
  const inheritedFrom = prevFailedOther
    ? { stat: prevFailedOther.stat, statLabel: prevFailedOther.statLabel, imparted: impartedPenalty(prevFailedOther.stat) }
    : crossTurn
      ? { stat: s.lastFailedCheck!.stat, statLabel: s.lastFailedCheck!.statLabel, imparted: s.lastFailedCheck!.imparted }
      : null;
  const inheritedMomentum = inheritedFrom
    ? Math.floor(inheritedFrom.imparted * FALLBACK_MOMENTUM_FRACTION)
    : 0;
  const fallbackMod =
    parsed.fallback && (prevFailedAny || crossTurn) ? FALLBACK_PENALTY + inheritedMomentum : 0;
  mod += fallbackMod;
  if (crossTurn) s.lastFailedCheck = null; // consumed — one inheritance per blow-up

  // Per-NPC scene escalation: a previously armed NPC (a failed attempt drew
  // a weapon) makes this retry harder — +2 target per prior failure, capped
  // — instead of repeating the identical check. Only a still-fresh
  // escalation (within the TTL) colors the target.
  const named = findNamedTarget(parsed, actionText);
  const escNpc = namedTargetNpc(named);
  const armed = escNpc ? s.checkEscalation[escNpc.key] : undefined;
  const armedFresh = armed && s.turnCount - armed.lastFailTurn <= ESCALATION_TTL_TURNS;
  const escalationMod = armedFresh
    ? Math.min(armed!.failures * ESCALATION_PER_FAILURE, ESCALATION_CAP)
    : 0;

  // Explicitly declared difficulty wins; an omission (or garbled value) is
  // inferred from the NPCs and scene so the check stays consistent with the
  // story.
  const declared = !!parsed.difficulty && parsed.difficultyDeclared !== false;
  const difficulty = declared ? parsed.difficulty! : inferDifficulty(parsed, actionText);
  const inferred = !declared;
  const target = DIFFICULTY_BASE[difficulty] + mod + escalationMod;
  const roll = rollD20();


  // LCK nudges the dice: every 5 points above 10 is +1 (below 10 is -1),
  // capped at ±2. A check ON LCK itself doesn't also get the LCK modifier.
  const lckMod =
    sv.label === "LCK"
      ? 0
      : Math.max(-2, Math.min(2, Math.floor((s.char.lck - 10) / 5)));

  const effectiveStat = sv.value;
  const score = roll + lckMod + effectiveStat;
  const margin = score - target;

  let outcome: CheckOutcome;
  if (roll === 1) outcome = "critical_failure";
  else if (roll === 20) outcome = "critical_success";
  else if (margin >= 12) outcome = "critical_success";
  else if (margin >= 6) outcome = "major_success";
  else if (margin >= 2) outcome = "minor_success";
  else if (margin >= -1) outcome = "neutral";
  else if (margin >= -6) outcome = "minor_failure";
  else if (margin >= -12) outcome = "major_failure";
  else outcome = "critical_failure";

  // Record the check and update the streak for the next attempt on this line.
  const streak = prev && prev.outcome === outcome ? prev.streak + 1 : 1;
  s.checkMomentum[key] = { outcome, streak };

  // Scene escalation lifecycle: a FAILURE against a hostile named NPC arms
  // (or deepens) the scene — the next attempt faces a weapon and a higher
  // target. A SUCCESS defuses it (the threat was resolved). Stale
  // escalations (no new failure within the TTL) decay on the next touch.
  if (escNpc && isEscalationCandidate(named!, actionText)) {
    if (isFailure(outcome)) {
      const prior = armed && s.turnCount - armed.lastFailTurn <= ESCALATION_TTL_TURNS ? armed.failures : 0;
      const failures = prior + 1;
      s.checkEscalation[escNpc.key] = {
        npc: escNpc.name,
        failures,
        lastFailTurn: s.turnCount,
        stage: escalationStage(failures),
      };
    } else if (armed) {
      delete s.checkEscalation[escNpc.key];
    }
  }

  // Persist the failure so a fallback declared NEXT turn still inherits
  // half its momentum (the cross-turn chain). A success clears it — the
  // pressure was resolved.
  if (isFailure(outcome)) {
    s.lastFailedCheck = {
      stat: key,
      statLabel: sv.label,
      imparted: impartedPenalty(key),
      turn: s.turnCount,
    };
  } else {
    s.lastFailedCheck = null;
  }

  s.checkLog.push({
    turn: s.turnCount,
    stat: key,
    difficulty,
    inferred,
    roll,
    lckMod,
    effectiveStat,
    score,
    target,
    outcome,
    context: parsed.context,
    fallback: parsed.fallback || undefined,
    fallbackMod: fallbackMod || undefined,
    fallbackInheritedMod: inheritedMomentum || undefined,
    fallbackFrom: inheritedMomentum > 0 ? inheritedFrom!.statLabel : undefined,
    escalationMod: escalationMod || undefined,
    escalationNpc: escalationMod > 0 ? escNpc!.name : undefined,
  });
  if (s.checkLog.length > 30) s.checkLog.splice(0, s.checkLog.length - 30);

  const line = formatCheckLine({
    turn: s.turnCount,
    stat: key,
    statLabel: sv.label,
    difficulty,
    inferred,
    roll,
    lckMod,
    effectiveStat,
    score,
    target,
    fallback: parsed.fallback,
    fallbackMod,
    fallbackInheritedMod: inheritedMomentum || undefined,
    fallbackFrom: inheritedMomentum > 0 ? inheritedFrom!.statLabel : undefined,
    escalationMod: escalationMod || undefined,
    escalationNpc: escalationMod > 0 ? escNpc!.name : undefined,
    escalationStage: escalationMod > 0 && armedFresh ? armed!.stage : undefined,
    momentumMod: mod,
    outcome,
    context: parsed.context,
  });
  return {
    turn: s.turnCount,
    stat: key,
    statLabel: sv.label,
    difficulty,
    inferred,
    roll,
    lckMod,
    effectiveStat,
    score,
    target,
    momentumMod: mod,
    outcome,
    context: parsed.context,
    fallback: parsed.fallback || undefined,
    fallbackMod: fallbackMod || undefined,
    fallbackInheritedMod: inheritedMomentum || undefined,
    fallbackFrom: inheritedMomentum > 0 ? inheritedFrom!.statLabel : undefined,
    escalationMod: escalationMod || undefined,
    escalationNpc: escalationMod > 0 ? escNpc!.name : undefined,
    escalationStage: escalationMod > 0 && armedFresh ? armed!.stage : undefined,
    line,
  };
}

/**
 * The compact system line shown after the narration. The math is transparent
 * (roll + stat + LCK vs target) so the player sees WHY the outcome happened,
 * plus a short momentum note when a previous attempt on the same line colored
 * this check.
 */
export function formatCheckLine(r: Omit<CheckResult, "line">): string {
  const lckStr = r.lckMod !== 0 ? ` + LCK ${r.lckMod > 0 ? "+" : ""}${r.lckMod}` : "";
  let line = `⚔️ ${r.statLabel} check — ${OUTCOME_LABELS[r.outcome]} (roll ${r.roll}${lckStr} + ${r.statLabel} ${r.effectiveStat} = ${r.score} vs ${r.difficulty} ${r.target})`;
  if (r.inferred) line += " (inferred)";
  if (r.momentumMod > 0) {
    line += ` Consecutive ${r.statLabel} checks are harder: +${r.momentumMod} target.`;
  } else if (r.momentumMod < 0) {
    line += ` Consecutive ${r.statLabel} checks are easier: ${r.momentumMod} target.`;
  }
  // A fallback recovery after a failed check is flagged so the player sees
  // the chain ("talk failed, so the dodge"): the penalty is already inside
  // target. When the fallback landed on a different stat, the inherited
  // half of the failed primary's momentum is spelled out.
  if (r.fallback && r.fallbackMod) {
    if (r.fallbackInheritedMod && r.fallbackFrom) {
      line += ` fallback (+${r.fallbackMod} target after the previous failure; half the failed ${r.fallbackFrom} check's momentum carries over)`;
    } else {
      line += ` fallback (+${r.fallbackMod} target after the previous failure)`;
    }
  }
  // A scene escalation: the NPC this check targets drew a weapon after an
  // earlier failed attempt — the raised target is spelled out so the player
  // sees the stakes rising instead of a mystery second failure.
  if (r.escalationMod && r.escalationNpc && r.escalationStage) {
    line += ` ${r.escalationNpc} ${ESCALATION_STAGE_TEXT[r.escalationStage] || "is armed"} — the scene has escalated: +${r.escalationMod} target.`;
  }
  // The AI's context ("talking my way past Vice-Principal Zhao") makes the
  // roll line reference what was actually being checked, so the player can
  // match the math to the scene without digging into the sidebar panel.
  if (r.context) line += ` — ${r.context}`;
  return line;
}

/**
 * The per-turn momentum reminder injected into the next action's payload so
 * the AI sees exactly how the previous outcome colors this turn's checks and
 * writes the consequences in fiction. Empty string when nothing is in force.
 */
export function getMomentumReminder(): string {
  const s = StateModule.state;
  const lines: string[] = [];
  for (const key of Object.keys(s.checkMomentum)) {
    const m = s.checkMomentum[key];
    let mod = TIER_MOD[m.outcome];
    if (mod !== 0) {
      const extra = Math.min(m.streak - 1, STREAK_ESCALATION_CAP);
      mod += extra * Math.sign(mod);
    }
    mod = Math.max(-MOMENTUM_CAP, Math.min(MOMENTUM_CAP, mod));
    if (mod === 0) continue;
    const dir = mod > 0 ? "harder" : "easier";
    const sign = mod > 0 ? "+" : "";
    lines.push(
      `CHECK MOMENTUM: the MC's last ${key} check was a ${OUTCOME_LABELS[m.outcome]} (streak ${m.streak}) — consecutive ${key} checks are ${dir}: ${sign}${mod} target this turn. A success resets the streak.`,
    );
  }
  return lines.join("\n");
}

/**
 * The per-turn escalation reminder: which NPCs are still armed after a
 * failed attempt and how much harder retrying them is. The AI sees it in the
 * payload so it writes the drawn weapon into the fiction instead of
 * repeating the identical scene. Empty string when nothing is armed.
 */
export function getEscalationReminder(): string {
  const s = StateModule.state;
  const lines: string[] = [];
  for (const key of Object.keys(s.checkEscalation)) {
    const e = s.checkEscalation[key];
    // A scene left cold for too long decays on its own — no haunted past.
    if (s.turnCount - e.lastFailTurn > ESCALATION_TTL_TURNS) {
      delete s.checkEscalation[key];
      continue;
    }
    const mod = Math.min(e.failures * ESCALATION_PER_FAILURE, ESCALATION_CAP);
    const stageText = e.stage >= 1 ? `${ESCALATION_STAGE_TEXT[e.stage]} — ` : "";
    lines.push(
      `ESCALATION: ${e.npc} is still armed after your last failed attempt against them (${stageText}${e.failures} failed attempt${e.failures > 1 ? "s" : ""} in a row). Retrying is harder: +${mod} target this turn. Succeed to defuse the scene — or find another way.`,
    );
  }
  return lines.join("\n");
}

export const CheckModule = {
  /**
   * Resolve every [CHECK] block in an AI response. Runs the same unclosed-tag
   * normalization the other parsers use so a forgotten [/CHECK] still parses.
   * Returns the system lines for the chat/history; state (checkLog +
   * checkMomentum) is updated as a side effect.
   */
  extract(aiText: string, actionText?: string): string[] {
    const lines: string[] = [];
    const parsed = parseCheckBlocks(normalizeTags(aiText));
    // Chain: the check that resolved just before feeds the next one, so a
    // declared fallback knows whether the previous attempt failed.
    let prevResult: CheckResult | null = null;
    for (const p of parsed) {
      const r = resolveCheck(p, actionText, prevResult);
      if (r) {
        lines.push(r.line);
        prevResult = r;
      }
    }
    return lines;
  },
};
