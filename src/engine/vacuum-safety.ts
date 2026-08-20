// =============================================================================
// vacuum-safety.ts — Phase 5: Witness checking, NPC reaction logic for vacuum interactions.
// =============================================================================

import { StateModule } from "../state/state";
import { NPCProfile } from "../state/GameState";
import {
  NPCProfileModule,
  matchesStimulusCategory,
  normalizeStimulus,
} from "./npc-profile";
import { TimeStateModule } from "./time-states";
import { isSkillEffectActive } from "./skill";
import { parseWorldClock } from "./director-notes";
import { isFamilyRelation } from "./family";
import { containsWholeWord } from "./family-names";

/** Stealth skills whose active effect hides the MC from witnesses. */
const STEALTH_HIDE_SKILLS = ["shadow_step", "vanishing_trick"];

/**
 * Ambient conditions dampen how many NPCs notice the MC's actions:
 * rain and darkness reduce witnesses outdoors, while shelter (an indoor
 * location) blocks the weather but not an unlit room. The effect is a
 * per-witness probability, so it stays "gently" plausible rather than
 * hard exclusions.
 */

/** Locations that count as shelter (weather can't reach the MC). */
const INDOOR_LOCATION_RE =
  /bedroom|kitchen|bathroom|living room|house|apartment|home|dorm|classroom|office|shop|store|tavern|inn|bar|cafe|restaurant|hall|library|temple|shrine|cabin|room|building|station|hospital|lab|smithy|forge|diner|auditorium|gym|study|studio|warehouse|garage/i;

/** Recorded lighting that implies poor visibility. */
const DARK_LIGHTING_RE =
  /dark|pitch[- ]?black|unlit|dim|moonless|blackout|shadowy|gloomy|no lights?|lights? (off|out)|flickering candle|lanternlight only|torchlight only/i;

/** Weather that reduces visibility / muffles sound. */
const RAIN_RE =
  /rain|drizzle|downpour|storm|sleet|shower|monsoon|snowstorm|blizzard|snowing heavily|hail/i;

/**
 * Never drop the notice chance below this — a living world always has some
 * risk. A practiced sneak can push past the plain-ambient floor, so this
 * lower bound only binds once the sneak synergy stacks on top.
 */
const AMBIENT_FACTOR_FLOOR = 0.05;

/** Cap on the MC's own sneak contribution: the factor shrinks by at most 50%. */
const SNEAK_SYNERGY_CAP = 0.5;

/** Extra cover contributed by each sneaky sidekick present with the MC. */
const COMPANION_SYNERGY_PER = 0.15;

/** Overall cap on the synergy once sneaky companions stack on the MC's part. */
const SNEAK_SYNERGY_TEAM_CAP = 0.6;

/** Traits that mark an NPC as a sneaky sidekick (contributes to cover). */
const SNEAKY_TRAIT_RE = /sneak|stealth|shadowy|furtive|nimble|ghostlike|unseen/i;

/**
 * Words right before an NPC mention that put the NPC on the far side of the
 * action — the target or obstacle rather than a teammate. Covers both
 * movement blockers ("sneak past Zhao", "talk my way past the guard") and
 * social opposition ("convince the clerk", "deceive the merchant").
 */
const OPPOSITION_PRE_RE =
  /\b(past|around|by|against|convince|persuade|deceive|trick|fool|avoid|evade|bypass|slip past|sneak past|get past|get by|talk (?:my way )?past|bribe|lie to|argue with|fight|confront|intimidate|stand up to|defy|threaten|scare off|outsmart|outrun|distract|pressure|sway|win over|overcome|beat|defeat|stop|block|resist)\b/i;

/**
 * Verbs where the NPC itself acts adversarially toward the MC. Anchored to
 * the START of the window right after the mention, so the verb must be the
 * first content word following the name ("Zhao blocks the door") — a noun
 * that merely sits later in the same sentence ("Zhao vouches for me to the
 * guards") never falsely triggers the check.
 */
const OPPOSITION_POST_RE =
  /^[^a-z]*(?:blocks|resists|refuses|intercepts|stops|attacks|guards|bars|denies|rejects|pushes back|stands in (?:the |his |her |their )?way|shakes (?:his |her |their )?head|scowls|glowers|bristles|snarls|sneers|scoffs)\b/i;

/** Disposition phrasing that marks the NPC as an adversary, not a teammate. */
const ADVERSARIAL_DISP_RE =
  /\b(hostile|aggressive|enemy|rival|angry|furious|fuming|livid|hates?|loathes?|despises?|vengeful|grudg(?:e|ing)|belligerent|antagonistic)\b/i;

/**
 * Verbs right after an NPC mention where the NPC acts as the MC's active
 * ally — "Zhao vouches for you", "Rook keeps watch", "Elle covers for you".
 * The NPC is the SUBJECT doing something helpful, the mirror image of the
 * adversarial POST list (blocks/refuses/resists). Anchored to the start of
 * the window after the mention for the same reason as the adversarial list.
 */
const COOPERATIVE_POST_RE =
  /^[^a-z]*(?:vouches?|helps?|backs? (?:you|me|us) up|assists?|covers? for|escorts?|supports?|stands? with|sides? with|speaks? (?:up )?for|recommends?|defends?|protects?|distracts?|keeps? watch|keeps? (?:your|my) back|clears? the way|opens? the (?:door|gate|path|way)|accompanies?|joins?|works? with (?:you|me|us)|teams? up with (?:you|me|us)|pulls? strings|puts? in a good word)\b/i;

/**
 * True when the action text works WITH the named NPC this turn: a helping
 * verb right after the mention ("Zhao vouches for you") or a with-phrase
 * directly before it ("you and Zhao work the crowd"). Adversarial mentions
 * are judged FIRST by callers, so "convince Zhao" or "Zhao blocks the door"
 * never read as cooperation.
 */
export function isCooperativeMention(action: string, name: string): boolean {
  const lower = action.toLowerCase();
  const nameLower = name.toLowerCase();
  const re = new RegExp(`\\b${escapeRegExp(nameLower)}\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    const afterStart = m.index + nameLower.length;
    const after = lower.slice(afterStart, afterStart + MENTION_WINDOW_CHARS);
    if (COOPERATIVE_POST_RE.test(after)) return true;
    // A with-phrase immediately before the mention: "you and Zhao",
    // "work with Zhao", "alongside Zhao".
    const justBefore = lower.slice(Math.max(0, m.index - 12), m.index);
    if (/\b(?:and|with|alongside|beside)\s*$/i.test(justBefore)) return true;
    re.lastIndex = afterStart;
  }
  return false;
}

/** How many characters on each side of an NPC mention count as "right around it". */
const MENTION_WINDOW_CHARS = 45;

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the action text treats the named NPC as the action's target or
 * obstacle. Each whole-word mention is judged by what sits right around it:
 * the words BEFORE the mention are tested for target markers ("sneak past
 * Zhao", "convince the clerk", "Rook distracts the merchant") and the words
 * AFTER for NPC-side hostile verbs ("Zhao blocks the door"). Splitting the
 * two directions is what keeps the SUBJECT of a cooperative verb credited —
 * in "Rook distracts the merchant", Rook has no marker before him and counts,
 * while the merchant ("distracts the merchant") does not.
 */
export function isAdversarialMention(action: string, name: string): boolean {
  const lower = action.toLowerCase();
  const nameLower = name.toLowerCase();
  const re = new RegExp(`\\b${escapeRegExp(nameLower)}\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    // Target markers BEFORE the mention: only the last few words count, so
    // "talk my way past Vice-Principal Zhao" is adversarial while "I slip
    // past the guard with Zhao" (marker belongs to the guard) is not.
    const beforeTokens = lower.slice(Math.max(0, m.index - MENTION_WINDOW_CHARS), m.index).split(/\s+/);
    const beforeTail = beforeTokens.slice(-3).join(" ");
    const afterStart = m.index + nameLower.length;
    const after = lower.slice(afterStart, afterStart + MENTION_WINDOW_CHARS);
    if (OPPOSITION_PRE_RE.test(beforeTail) || OPPOSITION_POST_RE.test(after)) {
      return true;
    }
    re.lastIndex = afterStart;
  }
  return false;
}

/**
 * True when the NPC is recorded as an adversary: a hostile disposition in
 * memory. The disposition is the relationship's source of truth for whose
 * side the NPC is on — the aggression threshold is a reactivity stat (how
 * fast they escalate), not allyship, so a hot-tempered companion still
 * counts. An adversary is never a teammate; a rival the story later warms up
 * (via [RELATION]) starts counting again.
 */
function isAdversarialNpc(p: NPCProfile): boolean {
  const rel = (StateModule.state.memory.relations || []).find(
    (r) => r.name.toLowerCase() === p.npcName.toLowerCase(),
  );
  return rel ? ADVERSARIAL_DISP_RE.test(rel.disposition || "") : false;
}

/** Test hook: deterministic RNG for the ambient witness reduction. */
let ambientRng: (() => number) | null = null;

/**
 * Turns within which an identical reaction still counts toward decay. After
 * the window passes, the NPC "forgets" and the reaction is full-strength
 * again — so spamming the same action in one session fades, but a player who
 * varies their behavior keeps getting meaningful reactions.
 */
const REACTION_DECAY_WINDOW = 5;

/**
 * Delta multipliers by repetition count (identical reactions within the
 * window): 1st full strength, 2nd half, 3rd quarter, 4th+ none. This is the
 * per-NPC cap against farming/tanking stats by repeating one action.
 */
const REACTION_DECAY_FACTORS = [1, 0.5, 0.25, 0];

/** How many recent reactions to retain per NPC. */
const MAX_RECENT_REACTIONS = 8;

/** Human-readable reaction labels for the chat system line. */
const REACTION_LABELS: Record<string, string> = {
  escalate_aggressively: "aggressively",
  retreat_or_defend: "defensively",
  hesitate_then_respond: "hesitantly",
  respond_proportionally: "in kind",
  jealous_reaction: "with jealousy",
  reciprocate_flirtatiously: "warmly",
  stoic_rejection: "with cool distance",
  accept_with_appreciation_for_value: "with calculated appreciation",
  reciprocate_generously: "generously",
  respond_warmly: "warmly",
  suspicious_of_gift: "with suspicion",
  normal_response: "calmly",
};

/**
 * A vacuum interaction is an action the MC takes that would normally
 * only affect the MC (e.g., undressing, meditating, using an item).
 * This module checks if any NPCs are present as witnesses and
 * determines their likely reaction.
 */
export const VacuumSafetyModule = {
  /**
   * How likely an NPC at the current location is to NOTICE the MC's action,
   * given ambient conditions: recorded [SCENE] weather/lighting plus the
   * clock. 1 = everyone notices; lower = rain/darkness hide things. Shelter
   * (an indoor location) blocks weather but not an unlit room.
   */
  ambientNoticeFactor(action?: string): number {
    const s = StateModule.state;
    const key = (s.worldState.location || "").trim().toLowerCase();
    const scene = s.sceneLog && s.sceneLog[key];
    const location = (s.worldState.location || "").toLowerCase();
    const isIndoor = INDOOR_LOCATION_RE.test(location);
    const clock = parseWorldClock(s.worldState.time);

    let factor = 1;

    // Darkness: the recorded lighting says it's dark/unlit, or it's night
    // outside (indoor spaces with no recorded darkness stay lit as usual).
    const lightingDark =
      typeof scene?.lighting === "string" && DARK_LIGHTING_RE.test(scene.lighting);
    const isNight =
      clock !== undefined && (clock.hour < 6 || clock.hour >= 22);
    const dark = lightingDark || (!isIndoor && isNight);
    if (dark) factor *= isIndoor ? 0.6 : 0.5;

    // Rain and other precipitation only matter outdoors — shelter blocks it.
    const weather = typeof scene?.weather === "string" ? scene.weather.toLowerCase() : "";
    if (RAIN_RE.test(weather) && !isIndoor) factor *= 0.5;

    // Ambient-vs-sneak synergy: when conditions ALREADY reduce visibility, a
    // practiced Sneaking subskill rides the weather and tightens the factor
    // further. Each point of Sneaking above 10 (the average) shaves 1% off,
    // capped at 50% — it stacks with the weather but never guarantees a hide
    // (that's what active stealth skills like Shadow Step are for). In clear
    // conditions the subskill does nothing through this path.
    if (factor < 1) {
      const bonus = this.ambientSneakBonus(action);
      if (bonus > 0) factor *= 1 - bonus;
    }

    return Math.max(AMBIENT_FACTOR_FLOOR, factor);
  },

  /**
   * How many sneaky non-family sidekicks are part of the MC's crew right now:
   * those physically at the MC's location, PLUS any sneaky companion the
   * action explicitly involves by name/alias ("Rook distracts the guard") — a
   * coordinated effort gives the companion full sneak credit for this turn
   * even when their profile's location hasn't caught up to the story.
   * Family is excluded — household members are not adventure partners.
   */
  sneakyCompanionsPresent(action?: string): number {
    const s = StateModule.state;
    const loc = (s.worldState.location || "").toLowerCase();
    const family = new Set(
      (s.memory.relations || [])
        .filter((r) => isFamilyRelation(r))
        .map((r) => r.name.toLowerCase()),
    );
    // Aliases live on the matching RELATION ("Diane" -> Mother), so an action
    // naming a companion by alias resolves the same way [RELATION] updates do.
    const relationAliases = new Map<string, string[]>();
    for (const r of s.memory.relations || []) {
      relationAliases.set(r.name.toLowerCase(), (r.aliases || []).map((a) => a.toLowerCase()));
    }
    return s.npcProfiles.filter((p) => {
      if (!(p.traits || []).some((t) => SNEAKY_TRAIT_RE.test(t))) return false;
      if (family.has(p.npcName.toLowerCase())) return false;
      // An NPC recorded as an adversary never lends cover — a hostile rival
      // is not part of the MC's crew no matter where they're standing.
      if (isAdversarialNpc(p)) return false;
      // Physically present at the MC's location.
      if (p.knownLocation && p.knownLocation.toLowerCase() === loc) {
        return true;
      }
      // Explicitly involved in the action text, by primary name or alias
      // (whole-word: "El helps" must not match a companion named "Elle").
      // An NPC the action treats as an obstacle ("sneak past the guard")
      // is never a teammate either.
      if (action) {
        const names = [p.npcName, ...(relationAliases.get(p.npcName.toLowerCase()) || [])].filter(Boolean);
        if (names.some((n) => containsWholeWord(action, n) && !isAdversarialMention(action, n))) return true;
      }
      return false;
    }).length;
  },

  /**
   * The sneak synergy bonus (0..SNEAK_SYNERGY_TEAM_CAP): how much extra hiding
   * the MC + their sneaky sidekicks provide ON TOP OF ambient conditions. The
   * MC's Sneaking subskill contributes (0 at/below average, capped 0.5) and
   * each sneaky companion present adds COMPANION_SYNERGY_PER up to the team cap.
   */
  ambientSneakBonus(action?: string): number {
    const s = StateModule.state;
    const sneaking = (s.subskills as { sneaking?: number } | undefined)?.sneaking;
    const mc =
      typeof sneaking === "number" && Number.isFinite(sneaking)
        ? Math.min(SNEAK_SYNERGY_CAP, Math.max(0, sneaking - 10) / 100)
        : 0;
    const team = mc + this.sneakyCompanionsPresent(action) * COMPANION_SYNERGY_PER;
    return Math.min(SNEAK_SYNERGY_TEAM_CAP, team);
  },

  /**
   * The non-family companions the action explicitly coordinates with, by
   * primary name (resolution honors relation aliases). Any companion counts —
   * not just sneaky ones — because teamwork itself is the lever: a
   * distraction partner, a lookout, or a persuader makes the MC's social and
   * leadership checks easier. Family is excluded, matching the
   * sneaky-companion rule, as is anyone the action treats as a target
   * ("talk my way past Zhao") or who is recorded as an adversary.
   */
  coordinatedCompanionNames(action?: string): string[] {
    const s = StateModule.state;
    if (!action) return [];
    const family = new Set(
      (s.memory.relations || [])
        .filter((r) => isFamilyRelation(r))
        .map((r) => r.name.toLowerCase()),
    );
    const relationAliases = new Map<string, string[]>();
    for (const r of s.memory.relations || []) {
      relationAliases.set(r.name.toLowerCase(), (r.aliases || []).map((a) => a.toLowerCase()));
    }
    return s.npcProfiles
      .filter((p) => {
        if (family.has(p.npcName.toLowerCase())) return false;
        // An adversary is never a teammate, even when the action names them.
        if (isAdversarialNpc(p)) return false;
        const names = [p.npcName, ...(relationAliases.get(p.npcName.toLowerCase()) || [])].filter(Boolean);
        return names.some(
          (n) =>
            containsWholeWord(action, n) &&
            // An NPC the action is getting past / convincing / deceiving is
            // the target of the action, not a companion working alongside.
            !isAdversarialMention(action, n),
        );
      })
      .map((p) => p.npcName);
  },

  /** How many non-family companions the action coordinates with. */
  coordinatedCompanions(action?: string): number {
    return this.coordinatedCompanionNames(action).length;
  },

  /** Test hook: force the RNG used for the ambient witness reduction. */
  setAmbientRng(rng: (() => number) | null): void {
    ambientRng = rng;
  },

  /**
   * Everyone physically at the MC's location (living only) — regardless of
   * whether rain/darkness hides the MC's actions. This is what the vacuum
   * NOTE lists, so it can never claim the MC is "alone" while NPCs are right
   * there; the notice reduction only decides who actually REACTS.
   */
  getPresentNPCs(): NPCProfile[] {
    const s = StateModule.state;
    const currentLocation = s.worldState.location;
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
        p.knownLocation.toLowerCase() === currentLocation.toLowerCase(),
    );
  },

  /**
   * Check if any NPCs are in the same location as the MC (after ambient
   * reduction — the people who actually NOTICE the action).
   * Returns a list of witness profiles.
   */
  getWitnesses(action?: string): NPCProfile[] {
    // An active stealth effect (Shadow Step, Vanishing Trick) hides the MC:
    // no one witnesses the action, so no reactions, interrupts, or vacuum
    // notes fire regardless of who is present.
    if (STEALTH_HIDE_SKILLS.some((id) => isSkillEffectActive(id))) {
      return [];
    }
    const present = this.getPresentNPCs();

    // Ambient reduction: in rain/darkness (outdoors) or an unlit room, some
    // of the people present simply won't notice the MC's action. Each witness
    // is retained with probability = the notice factor — soft, never a hard
    // exclusion, and the same for reactions and interrupts.
    const factor = this.ambientNoticeFactor(action);
    if (factor < 1 && present.length > 0) {
      const rng = ambientRng || Math.random;
      return present.filter(() => rng() < factor);
    }
    return present;
  },

  /**
   * Determine if the current location is "private" (no witnesses).
   */
  isPrivateLocation(): boolean {
    return this.getWitnesses().length === 0;
  },

  /**
   * Generate a vacuum safety note for prompt injection.
   * Describes who is present and how they might react.
   */  generateVacuumNote(action: string): string {
    const s = StateModule.state;
    // List everyone physically present — ambient conditions reduce who
    // REACTS, never whether someone is listed as here. A rainy market with a
    // guard under an awning must never be narrated as empty.
    const present = this.getPresentNPCs();
    if (present.length === 0) {
      return "VACUUM NOTE: You are currently alone in this location. No NPCs are present to witness your actions.";
    }

    const lowerAction = action.toLowerCase();
    let note = `VACUUM NOTE: The following NPCs are present in ${s.worldState.location} and may react to your actions:\n`;

    // When ambient conditions reduce visibility, tell the AI so the narrative
    // matches the mechanic (rain muffling sound, darkness hiding motion).
    const factor = this.ambientNoticeFactor();
    if (factor < 1) {
      note += `Current conditions (${factor < 0.5 ? "heavy rain or deep darkness" : "rain or darkness"}) reduce how many of them notice the MC's actions — not everyone present may react.\n`;
      if (this.ambientSneakBonus(action) > 0) {
        const comps = this.sneakyCompanionsPresent(action);
        note +=
          comps > 0
            ? `The MC${comps === 1 ? " and a sneaky companion" : ` and ${comps} sneaky companions`} ride these conditions — even fewer will notice.\n`
            : `The MC's practiced Sneaking rides these conditions — even fewer will notice.\n`;
      }
    }

    for (const w of present) {
      const reaction = NPCProfileModule.getMoodedReaction(w.npcName, lowerAction);
      const states = TimeStateModule.getNPCStatusSummary(w.npcName);
      const stateStr = states ? ` | States: ${states}` : "";

      const traitStr = w.traits.length > 0 ? ` Traits: ${w.traits.join(", ")}` : "";
      const trustStr = ` Trust: ${w.trust}/100 | Affection: ${w.affection}/100`;

      note += `  - ${w.npcName}${traitStr}${trustStr}${stateStr}\n`;
      note += `    Likely reaction: ${reaction}\n`;
    }

    return note;
  },

  /**
   * Check if an NPC would interrupt a private action.
   */
  wouldInterrupt(action: string): { interrupts: boolean; npcName?: string; reason: string } {
    const witnesses = this.getWitnesses(action);
    const normalized = normalizeStimulus(action);

    for (const w of witnesses) {
      const reaction = NPCProfileModule.getMoodedReaction(w.npcName, normalized);

      // Aggressive NPCs with high aggression threshold will interrupt
      if (reaction === "escalate_aggressively" && w.aggressionThreshold > 60) {
        return {
          interrupts: true,
          npcName: w.npcName,
          reason: `${w.npcName} aggressively interrupts due to their ${w.traits.join(", ")} nature.`,
        };
      }

      // Jealous NPCs may interrupt romantic actions
      if (reaction === "jealous_reaction" && matchesStimulusCategory(normalized, "romance")) {
        return {
          interrupts: true,
          npcName: w.npcName,
          reason: `${w.npcName} reacts with jealousy to the intimate action.`,
        };
      }

      // Timid NPCs may flee or call for help
      if (reaction === "retreat_or_defend" && matchesStimulusCategory(normalized, "aggression")) {
        return {
          interrupts: true,
          npcName: w.npcName,
          reason: `${w.npcName} retreats in fear and may alert others.`,
        };
      }
    }

    return { interrupts: false, reason: "No NPCs would interrupt this action." };
  },

  /**
   * Trigger an NPC reaction when the MC performs an action near them.
   * Applies the reaction's trust/affection deltas to every witness profile
   * (so user interactions genuinely influence those stats) and returns the
   * narrative consequence, the aggregate deltas, and a per-witness detail
   * list the UI uses to explain WHY the stats moved.
   */
  triggerReaction(action: string): {
    narrative: string;
    trustDelta: number;
    affectionDelta: number;
    details: Array<{ npcName: string; reaction: string; label: string; trustDelta: number; affectionDelta: number; repeats: number }>;
  } {
    const s = StateModule.state;
    const witnesses = this.getWitnesses(action);
    let narrative = "";
    let totalTrustDelta = 0;
    let totalAffectionDelta = 0;
    const details: Array<{ npcName: string; reaction: string; label: string; trustDelta: number; affectionDelta: number; repeats: number }> = [];

    for (const w of witnesses) {
      const reaction = NPCProfileModule.getMoodedReaction(w.npcName, action);
      let npcNarrative = "";
      let trustDelta = 0;
      let affectionDelta = 0;

      switch (reaction) {
        case "escalate_aggressively":
          npcNarrative = `${w.npcName} reacts with hostility, ${w.traits.includes("aggressive") ? "their aggressive nature pushing them to confront you directly" : "choosing to escalate the situation"}.`;
          trustDelta -= 15;
          affectionDelta -= 10;
          break;
        case "retreat_or_defend":
          npcNarrative = `${w.npcName} steps back defensively, ${w.traits.includes("timid") ? "clearly frightened by your actions" : "taking a cautious stance"}.`;
          trustDelta -= 5;
          break;
        case "jealous_reaction":
          npcNarrative = `${w.npcName} watches with visible jealousy, ${w.traits.includes("jealous") ? "their possessive nature flaring up" : "clearly uncomfortable with the attention"}.`;
          affectionDelta -= 10;
          trustDelta -= 5;
          break;
        case "reciprocate_flirtatiously":
          npcNarrative = `${w.npcName} responds warmly, ${w.traits.includes("flirtatious") ? "returning your attention with obvious charm" : "appearing pleased by your gesture"}.`;
          affectionDelta += 10;
          trustDelta += 5;
          // An active Charm Aura amplifies the warm response.
          if (isSkillEffectActive("charm_aura")) {
            affectionDelta += 5;
            trustDelta += 2;
          }
          break;
        case "stoic_rejection":
          npcNarrative = `${w.npcName} maintains a composed expression but subtly distances themselves.`;
          affectionDelta -= 5;
          break;
        case "accept_with_appreciation_for_value":
          npcNarrative = `${w.npcName} accepts with calculated appreciation, their greedy nature noting the value.`;
          trustDelta += 3;
          break;
        case "reciprocate_generously":
          npcNarrative = `${w.npcName} responds with genuine warmth, ${w.traits.includes("generous") ? "their kind nature shining through" : "clearly moved by your gesture"}.`;
          affectionDelta += 15;
          trustDelta += 10;
          break;
        case "respond_warmly":
          npcNarrative = `${w.npcName} warms at your thoughtfulness, ${w.traits.includes("empathetic") ? "their caring nature responding to your kindness" : "appreciating the gesture"}.`;
          affectionDelta += 6;
          trustDelta += 4;
          break;
        case "suspicious_of_gift":
          npcNarrative = `${w.npcName} eyes your offering warily, trust too low to accept readily.`;
          trustDelta -= 3;
          break;
        default:
          npcNarrative = `${w.npcName} observes quietly, maintaining a neutral demeanor.`;
      }

      narrative += npcNarrative + " ";

      // Decay: repeated IDENTICAL reactions within the window fade toward
      // zero — the per-NPC cap against farming/tanking via one repeated
      // action. The NPC gets used to it; after the window passes it forgets.
      const log = w.recentReactions || [];
      const cutoffTurn = s.turnCount - REACTION_DECAY_WINDOW;
      const repeats = log.filter(
        (r) => r.reaction === reaction && r.turn >= cutoffTurn,
      ).length;
      const factor =
        REACTION_DECAY_FACTORS[
          Math.min(repeats, REACTION_DECAY_FACTORS.length - 1)
        ];
      const appliedTrust = Math.round(trustDelta * factor);
      const appliedAffection = Math.round(affectionDelta * factor);
      w.recentReactions = [...log, { turn: s.turnCount, reaction }].slice(
        -MAX_RECENT_REACTIONS,
      );

      // Apply THIS witness's reaction to their profile — user interactions
      // now genuinely move Trust/Affection for NPCs present at the scene.
      if (appliedTrust !== 0 || appliedAffection !== 0) {
        NPCProfileModule.applyReactionDeltas(w.npcName, appliedTrust, appliedAffection);
      }
      details.push({
        npcName: w.npcName,
        reaction,
        label: REACTION_LABELS[reaction] ?? reaction.replace(/_/g, " "),
        trustDelta: appliedTrust,
        affectionDelta: appliedAffection,
        repeats,
      });
      totalTrustDelta += appliedTrust;
      totalAffectionDelta += appliedAffection;
    }

    return {
      narrative: narrative.trim(),
      trustDelta: totalTrustDelta,
      affectionDelta: totalAffectionDelta,
      details,
    };
  },

  /**
   * Format a witness reaction as a compact chat system line explaining why
   * the stats moved, e.g. "Wren reacts with jealousy — Affection -10, Trust -5".
   * Returns null when nothing actually changed for that witness.
   */
  formatReactionLine(detail: {
    npcName: string;
    label: string;
    trustDelta: number;
    affectionDelta: number;
    repeats?: number;
  }): string | null {
    const parts: string[] = [];
    if (detail.affectionDelta !== 0) {
      parts.push(`Affection ${detail.affectionDelta > 0 ? "+" : ""}${detail.affectionDelta}`);
    }
    if (detail.trustDelta !== 0) {
      parts.push(`Trust ${detail.trustDelta > 0 ? "+" : ""}${detail.trustDelta}`);
    }
    if (parts.length === 0) return null;
    const suffix = detail.repeats && detail.repeats > 0 ? " (reduced)" : "";
    return `${detail.npcName} reacts ${detail.label} — ${parts.join(", ")}${suffix}`;
  },

  /**
   * Check if an NPC's schedule puts them at the current location.
   * Used to dynamically populate witnesses.
   */
  checkSchedulePresence(): string[] {
    const s = StateModule.state;
    const currentLocation = s.worldState.location;
    const present: string[] = [];

    for (const profile of s.npcProfiles) {
      if (profile.knownLocation &&
          profile.knownLocation.toLowerCase() === currentLocation.toLowerCase()) {
        present.push(profile.npcName);
      }
    }

    return present;
  },
};
