// =============================================================================
// npc-profile.ts — Phase 5: NPC Profile management, trait parsing, threshold logic.
// =============================================================================

import { StateModule } from "../state/state";
import { NPCProfile, NPCTrait, NPCRelationship } from "../state/GameState";
import { NPCProfileSchema } from "../state/schema";
import { safeParseJsonBlock } from "./tag-utils";
import { isSkillEffectActive } from "./skill";

// -----------------------------------------------------------------------------
// Stimulus matching — how MC actions map onto trait-driven reactions.
//
// The engine keys reactions off the MC's action text. To keep this from being
// brittle trigger-word matching ("I attack" works, "I shove" doesn't), the
// text is normalized: lowercased, punctuation stripped, and each word reduced
// with a light English stemmer ("punched"/"punching" -> "punch"). The stemmed
// text is then matched against broad per-category word sets. The AI still does
// the narrative work from the profile stats; this only decides stat movement,
// interrupts, and the reaction descriptor.
// -----------------------------------------------------------------------------

/** Light English stemmer: strip common inflections, then a trailing e. */
function stemWord(w: string): string {
  if (w.length <= 3) return w;
  let s = w
    .replace(/(?:ingly|ing)$/i, "")
    .replace(/(?:edly|ed)$/i, "")
    .replace(/(?:es|s)$/i, "");
  s = s.replace(/e$/i, "");
  // "slapped" -> "slapp" -> "slap"
  s = s.replace(/([a-z])\1$/i, "$1");
  return s;
}

/**
 * Normalize an action/stimulus string for category matching: lowercase,
 * strip punctuation, stem each word.
 */
export function normalizeStimulus(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .map(stemWord)
    .filter(Boolean)
    .join(" ");
}

/** Base-form word sets per stimulus category (stemmed at match time). */
export const STIMULUS_CATEGORIES = {
  aggression: [
    "attack", "fight", "strike", "hurt", "punch", "shove", "hit", "slap",
    "kick", "assault", "threaten", "menace", "brandish", "fist", "kill",
    "stab", "slash", "bite", "choke", "ambush", "snarl", "batter", "beat",
    "smash", "slam", "violence", "violent", "rage", "lash", "stomp",
    "wrestle", "steal", "theft", "rob", "robbery", "pickpocket", "pilfer",
    "shoplift", "burgl", "loot", "mug",
  ],
  romance: [
    "romance", "kiss", "hug", "flirt", "love", "affection", "intimate",
    "embrace", "caress", "seduce", "court", "cuddle", "proposition",
    "desire", "passion", "smooch", "courtship", "woo",
  ],
  gift: [
    "gift", "give", "offer", "present", "donate", "bestow", "tip", "award",
    "grant", "treat", "bribe", "reward",
  ],
  // Kindness / family care — making breakfast, helping with chores, leaving
  // money, comforting, protecting. Deliberately broader than "gift": these
  // are acts of care toward someone, not necessarily physical presents.
  // NOTE: "guard", "shelter", and "shield" were removed — they collide with
  // common NOUNS ("a market guard is sheltering under an awning") and made
  // neutral scene descriptions trigger the kindness reaction. Live test caught
  // a guard "reacting warmly" to a pickpocket attempt.
  care: [
    "care", "cook", "breakfast", "meal", "feed", "help", "protect",
    "support", "comfort", "nurse", "rescue", "save", "escort",
    "tend", "kind", "kindness", "serve", "heal", "defend",
    "grateful", "thank", "chore", "errand", "housework",
  ],
} as const;

type StimulusCategory = keyof typeof STIMULUS_CATEGORIES;

/**
 * Emotional cues the engine reads from the AI's own narrative, in priority
 * order (negative cues outrank positive in a mixed sentence). Each fires a
 * MILD trust/affection nudge — deliberately smaller than action-triggered
 * reactions, because this is a soft signal, not a mechanic the player chose.
 */
const NARRATIVE_CUES: Array<{
  cue: string;
  regex: RegExp;
  trustDelta: number;
  affectionDelta: number;
}> = [
  {
    cue: "hostile",
    regex:
      /\b(?:angry|angrily|furious|hostile|glar\w*|snarl\w*|scowl\w*|seeth\w*|sneer\w*|growl\w*|snap\w*|bristl\w*|hiss\w*|spit\w*|coldly|icily)\b/i,
    trustDelta: -3,
    affectionDelta: -2,
  },
  {
    cue: "fearful",
    regex:
      /\b(?:flinch\w*|recoil\w*|trembl\w*|fear\w*|frighten\w*|shrink\w*|back\s+away|pale\w*|gulp\w*)\b/i,
    trustDelta: -1,
    affectionDelta: -1,
  },
  {
    cue: "suspicious",
    regex:
      /\b(?:suspicious|wary|warily|distrust\w*|skeptic\w*|doubt\w*|narrow\w*)\b/i,
    trustDelta: -2,
    affectionDelta: 0,
  },
  {
    cue: "warm",
    regex:
      /\b(?:smil\w*|beam\w*|warm\w*|soften\w*|fond\w*|pleased|grateful|delight\w*|glad|welcome\w*|relax\w*|brighten\w*|chuckl\w*|giggl\w*)\b/i,
    trustDelta: 2,
    affectionDelta: 3,
  },
];

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// -----------------------------------------------------------------------------
// Narrative NPC relocation — when the story says an NPC left for a place
// ("your mother left for her double shift at the diner", "Lin Wei went to the
// market"), move the profile's knownLocation so witness checks follow the
// story: a mother at the diner stops reacting from home, and when she "comes
// back home" she witnesses again. Conservative by design — only registered
// NPCs move, a bare "left" with no destination changes nothing, and
// questions/negations never relocate.
// -----------------------------------------------------------------------------

/** Sentinel resolved to the MC's home location (setup starting location). */
const HOME_PLACE = "__home__";

/** Clause-ending words that stop a place capture ("to school with her..."). */
const PLACE_BOUNDARY =
  "until|for|and|but|so|while|before|after|because|to|again|already|yet|" +
  "just|still|tomorrow|tonight|this|next|morning|evening|yesterday|today|" +
  "with|then|as|if|when|once|later|soon|now";

/** "at (the) <place>" — a place phrase. */
const LOCATION_AT_RE = new RegExp(
  `\\bat\\s+(?:the\\s+)?([A-Za-z][A-Za-z0-9' -]{1,24}?)(?=[,.;!?]|\\s+(?:${PLACE_BOUNDARY})|$)`,
  "i",
);

/** Direct destination after a departure verb: "went to school", "left for work".
 * Anchored so a leading space can't defeat the "for|to|back" prefix. */
const LOCATION_DIRECT_RE = new RegExp(
  `^\\s*(?:for|to|toward|towards|off to|over to|back to|back)?\\s*(?:the\\s+|her\\s+|his\\s+|their\\s+|a\\s+|an\\s+)*([A-Za-z][A-Za-z0-9' -]{1,24}?)(?=[,.;!?]|\\s+(?:${PLACE_BOUNDARY})|$)`,
  "i",
);

/** Presence verbs that ground a following "at <place>" ("works at the diner"). */
const LOCATION_VERB_RE =
  /\b(?:left|headed|went|departed|rushed|hurried|returned|walked|drove|ran|rode|flew|sailed|came|set off|took off|made (?:her|his|their) way|arrived|got to|reached|works?|is working|stays?|stationed|posted|teaches?|studies?|shifts?|is)\b/i;

/** "is (already|back) at <place>" — the one bare-"is" case we trust. */
const LOCATION_IS_AT_RE = new RegExp(
  `\\bis\\s+(?:already\\s+|back\\s+)?at\\s+(?:the\\s+)?([A-Za-z][A-Za-z0-9' -]{1,24}?)(?=[,.;!?]|\\s+(?:${PLACE_BOUNDARY})|$)`,
  "i",
);

/** Phrasings that mean "back at the MC's home" (arrival only — "left the
 * house" is a departure FROM home and must never relocate anyone home). */
const HOME_PLACE_WORDS = /^(?:home|back\s+home)$/i;

/** Tokens that can never be a real destination. */
const JUNK_PLACES = new Set([
  "a", "an", "the", "and", "but", "so", "or", "her", "his", "their",
  "our", "my", "your", "him", "them", "us", "it", "you", "me",
  "while", "moment", "bit", "time", "day", "week", "month", "year",
  "ever", "now", "later", "soon", "once", "always", "never", "good",
  "some", "any", "this", "that", "these", "those", "which", "who",
  "what", "when", "where", "there", "here", "again", "already",
  // In-home and liminal words — not durable destinations.
  "house", "apartment", "flat", "cabin", "room", "bedroom", "kitchen",
  "bathroom", "hall", "hallway", "door", "doorway", "yard", "garden",
  "street", "sidewalk", "porch", "stairs", "step", "corner",
  // Temporal/hedge words that read like destinations after a departure verb
  // ("returned yet", "left just now", "went still").
  "yet", "just", "still", "soon", "now", "later", "again", "already",
]);

/** Normalize a captured place phrase into a location string (or null). */
function cleanLocationPlace(place: string): string | null {
  const p = (place || "").trim().replace(/[.,;:!?'"]+$/, "");
  if (!p) return null;
  const lower = p.toLowerCase();
  if (HOME_PLACE_WORDS.test(lower)) return HOME_PLACE;
  const base = lower.replace(/^(?:the|a|an)\s+/, "");
  if (HOME_PLACE_WORDS.test(base)) return HOME_PLACE;
  if (JUNK_PLACES.has(lower) || JUNK_PLACES.has(base)) return null;
  if (/\d/.test(p) || p.length > 30) return null;
  if (!base) return null;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Extract the place an NPC went to from a sentence, or null. Scans every
 * location verb in order and keeps the LAST destination ("left the house and
 * went to the park" -> the park). Questions and negations never relocate.
 */
function extractLocationPlace(sentence: string): string | null {
  const s = sentence.trim();
  if (!s) return null;
  // Negation guard — also handles the curly apostrophe this model family
  // writes ("hadn’t returned yet"): a denied departure must never relocate.
  if (/\?\s*$/.test(s) ||
      /\b(?:didn[’']?t|not|never|no longer|hasn[’']?t|hadn[’']?t|won[’']?t|isn[’']?t|wasn[’']?t|aren[’']?t|weren[’']?t|can[’']?t|couldn[’']?t|wouldn[’']?t|shouldn[’']?t)\b/i.test(s)) {
    return null;
  }
  let best: string | null = null;
  const re = new RegExp(LOCATION_VERB_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const verb = m[0].toLowerCase();
    const tail = s.slice(m.index + m[0].length);
    let place: string | null = null;
    if (verb === "is") {
      // The full sentence still carries the "is ... at" we matched.
      const at = LOCATION_IS_AT_RE.exec(s);
      if (at) place = at[1];
    } else {
      const atM = LOCATION_AT_RE.exec(tail);
      const directM = LOCATION_DIRECT_RE.exec(tail);
      if (atM) {
        const before = tail.slice(0, atM.index);
        const near = before.split(/\s+/).filter(Boolean).length <= 6;
        const noClauseBreak = !/[,;:—–]/.test(before);
        if (near && noClauseBreak) place = atM[1];
      }
      if (!place && directM) place = directM[1];
    }
    if (place) {
      const cleaned = cleanLocationPlace(place);
      if (cleaned) best = cleaned;
    }
  }
  return best;
}

/** The MC's home — setup starting location, falling back to current. */
function homeLocationFallback(): string | null {
  const s = StateModule.state;
  const setup = s.setup as { location?: string } | Record<string, never>;
  const fromSetup =
    setup && typeof setup === "object" && "location" in setup
      ? (setup as { location?: string }).location
      : "";
  return (fromSetup || s.worldState.location || "").trim() || null;
}

/** Stemmed word sets, computed once at module load. */
const STEM_SETS: Record<StimulusCategory, Set<string>> = {
  aggression: new Set(STIMULUS_CATEGORIES.aggression.map(stemWord)),
  romance: new Set(STIMULUS_CATEGORIES.romance.map(stemWord)),
  gift: new Set(STIMULUS_CATEGORIES.gift.map(stemWord)),
  care: new Set(STIMULUS_CATEGORIES.care.map(stemWord)),
};

/** True when any stemmed word of the stimulus falls in the category. */
export function matchesStimulusCategory(
  normalized: string,
  category: StimulusCategory,
): boolean {
  const set = STEM_SETS[category];
  return normalized.split(/\s+/).some((w) => set.has(w));
}

// -----------------------------------------------------------------------------
// Remembered-mood bias — the strongest remembered reaction feeds the reaction
// pipeline's mood. A cold reaction the NPC remembers (e.g. "Nina reacted with
// jealousy") makes them LESS likely to cooperate this turn: warm paths mute
// toward cool, neutral turns turn guarded. A remembered warm reaction gently
// eases the response. The signal is intensity-weighted within a recent window
// so an old grudge fades while a strong recent one dominates.
// -----------------------------------------------------------------------------

/** How many turns back a reaction still shapes the NPC's mood. */
const REACTION_MOOD_WINDOW = 10;

/**
 * Cold-mood downgrades: remembered coldness pushes COOPERATION down a tier.
 * Deliberately NOT applied to neutral/private actions ("I check my bag") —
 * the mood blocks warmth the MC seeks (gifts, care, flirtation) instead of
 * bleeding trust for doing nothing. The RECENT REACTIONS prompt block carries
 * the lingering coldness into the AI's narration for neutral scenes.
 */
const COLD_MOOD_DOWNGRADES: Record<string, string> = {
  reciprocate_generously: "respond_warmly",
  respond_warmly: "normal_response",
  reciprocate_flirtatiously: "stoic_rejection",
  accept_with_appreciation_for_value: "suspicious_of_gift",
  hesitate_then_respond: "retreat_or_defend",
};

/** Warm-mood upgrades: remembered warmth gently eases the response. */
const WARM_MOOD_UPGRADES: Record<string, string> = {
  suspicious_of_gift: "respond_warmly",
  hesitate_then_respond: "respond_proportionally",
  retreat_or_defend: "respond_proportionally",
};

/**
 * The strongest remembered reaction for an NPC — the mood signal. Scans the
 * action-memory log (witness-pipeline and prose-scanner reaction entries
 * alike) for the NPC's highest-intensity reaction within the recent window;
 * its valence is the mood. -1 = a remembered cold reaction, +1 = remembered
 * warmth, 0 = no meaningful memory. Exported for tests.
 */
export function getNpcMood(npcName: string): 1 | -1 | 0 {
  const s = StateModule.state;
  const mem = s.actionMemory || [];
  if (mem.length === 0) return 0;
  const cutoff = s.turnCount - REACTION_MOOD_WINDOW;
  let best: { intensity: number; valence: 1 | -1 | 0; turn: number } | null = null;
  for (const e of mem) {
    if (!e || e.category !== "social" || !e.npc) continue;
    if (e.npc.toLowerCase() !== npcName.toLowerCase()) continue;
    const out = e.outcome || "";
    const sum = e.summary || "";
    const isReaction =
      /warm reaction|cold reaction/i.test(out) || /^.{1,40} reacted /i.test(sum);
    if (!isReaction) continue;
    const turn = typeof e.turn === "number" ? e.turn : 0;
    if (turn < cutoff) continue;
    let valence: 1 | -1 | 0 = 0;
    if (/warm reaction/i.test(out)) valence = 1;
    else if (/cold reaction/i.test(out)) valence = -1;
    else {
      const m = out.match(/(?:Affection|Trust)\s+([+-]?\d+)/);
      if (m) {
        const n = Number(m[1]);
        valence = n > 0 ? 1 : n < 0 ? -1 : 0;
      }
    }
    if (valence === 0) continue;
    const intensity = typeof e.intensity === "number" ? e.intensity : 0;
    if (
      !best ||
      intensity > best.intensity ||
      (intensity === best.intensity && turn > best.turn)
    ) {
      best = { intensity, valence, turn };
    }
  }
  return best ? best.valence : 0;
}

export const NPCProfileModule = {
  /**
   * Parse [NPC_PROFILE] tags from AI output and apply to state.
   * Format: [NPC_PROFILE]{"npcName":"...","traits":["aggressive"],"aggressionThreshold":70,...}[/NPC_PROFILE]
   * Returns true if any profile was created or updated (caller should re-render).
   */
  extract(aiText: string): boolean {
    const s = StateModule.state;
    if (!s.toggles.npcDepth) return false;

    let changed = false;
    const profileRegex = /\[NPC_PROFILE\](.*?)\[\/NPC_PROFILE\]/gs;
    let match: RegExpExecArray | null;

    while ((match = profileRegex.exec(aiText)) !== null) {
      const jsonStr = match[1].trim();
      if (!jsonStr) continue;

      const parsed = safeParseJsonBlock(NPCProfileSchema, jsonStr);
      if (!parsed.ok || !parsed.data) {
        console.warn("Skipped invalid NPC_PROFILE:", parsed.error, jsonStr);
        continue;
      }

      this.upsertProfile(parsed.data);
      changed = true;
    }
    return changed;
  },

  /** Insert or update an NPC profile. Creates from Relation if not found. */
  upsertProfile(profile: NPCProfile): void {
    const s = StateModule.state;
    const idx = s.npcProfiles.findIndex((p) => p.npcName.toLowerCase() === profile.npcName.toLowerCase());

    if (idx >= 0) {
      // Merge: keep existing values for fields not provided
      const existing = s.npcProfiles[idx];
      s.npcProfiles[idx] = {
        ...existing,
        ...profile,
        traits: profile.traits.length > 0 ? profile.traits : existing.traits,
        relationships: profile.relationships.length > 0 ? profile.relationships : existing.relationships,
        equipment: profile.equipment.length > 0 ? profile.equipment : existing.equipment,
      };
    } else {
      s.npcProfiles.push(profile);
    }
  },

  /**
   * Convert an existing Relation into a basic NPCProfile (used in migration).
   */
  profileFromRelation(name: string, disposition: string, _aliases: string[]): NPCProfile {
    const traits: NPCTrait[] = [];
    const lowerDisp = disposition.toLowerCase();

    if (/aggress|violent|hostile|fierce/i.test(lowerDisp)) traits.push("aggressive");
    if (/timid|shy|afraid|coward/i.test(lowerDisp)) traits.push("timid");
    if (/jealous|possessive/i.test(lowerDisp)) traits.push("jealous");
    if (/generous|kind|giving/i.test(lowerDisp)) traits.push("generous");
    if (/greedy|avarice|money-hungry/i.test(lowerDisp)) traits.push("greedy");
    if (/loyal|devoted|faithful/i.test(lowerDisp)) traits.push("loyal");
    if (/deceit|liar|cunning|sly/i.test(lowerDisp)) traits.push("deceitful");
    if (/honest|truthful|straightforward/i.test(lowerDisp)) traits.push("honest");
    if (/flirt|charming|romantic|amorous/i.test(lowerDisp)) traits.push("flirtatious");
    if (/stoic|calm|composed|unflappable/i.test(lowerDisp)) traits.push("stoic");
    if (/empathetic|compassionate|caring/i.test(lowerDisp)) traits.push("empathetic");
    if (/vengeful|revenge|grudge/i.test(lowerDisp)) traits.push("vengeful");
    if (/cautious|careful|prudent/i.test(lowerDisp)) traits.push("cautious");
    if (/bold|brave|fearless/i.test(lowerDisp)) traits.push("bold");
    if (/proud|arrogant|haughty/i.test(lowerDisp)) traits.push("proud");
    // A "sneaky sidekick"-style disposition marks the NPC as stealthy, which
    // lets them contribute to the ambient-sneak synergy when acting with the MC.
    if (/sneak|stealth|shadowy|furtive|nimble|unseen/i.test(lowerDisp)) traits.push("sneaky");

    return {
      npcName: name,
      traits,
      aggressionThreshold: traits.includes("aggressive") ? 70 : traits.includes("timid") ? 20 : 50,
      jealousyThreshold: traits.includes("jealous") ? 30 : traits.includes("generous") ? 80 : 50,
      trust: 50,
      affection: 50,
      schedule: [],
      relationships: [],
      equipment: [],
      autoGenerated: true,
    };
  },

  /**
   * Check NPC reaction based on traits and thresholds.
   * Returns a reaction descriptor the prompt can use.
   */
  getReaction(npcName: string, stimulus: string): string {
    const s = StateModule.state;
    const profile = s.npcProfiles.find(
      (p) => p.npcName.toLowerCase() === npcName.toLowerCase(),
    );

    if (!profile) return "neutral";

    const normalized = normalizeStimulus(stimulus);

    // Aggression check — violent/threatening actions, however phrased
    // ("I shove him", "I raised my fist", "she punched the wall").
    if (matchesStimulusCategory(normalized, "aggression")) {
      if (profile.aggressionThreshold > 60 && profile.traits.includes("aggressive")) {
        return "escalate_aggressively";
      }
      if (profile.traits.includes("timid") || profile.aggressionThreshold < 30) {
        return "retreat_or_defend";
      }
      if (profile.traits.includes("cautious")) {
        return "hesitate_then_respond";
      }
      return "respond_proportionally";
    }

    // Jealousy check — romantic attention toward others, however phrased
    // ("I embraced her", "I caressed her cheek"). An active Charm Aura
    // suppresses the jealous reaction: the aura soothes possessiveness and
    // the NPC falls through to warmer paths instead of souring.
    if (matchesStimulusCategory(normalized, "romance")) {
      const charmActive = isSkillEffectActive("charm_aura");
      if (
        profile.affection > profile.jealousyThreshold &&
        profile.traits.includes("jealous") &&
        !charmActive
      ) {
        return "jealous_reaction";
      }
      if (profile.traits.includes("flirtatious")) {
        return "reciprocate_flirtatiously";
      }
      if (profile.traits.includes("stoic") || profile.traits.includes("proud")) {
        return "stoic_rejection";
      }
    }

    // Generosity / gift check
    if (matchesStimulusCategory(normalized, "gift")) {
      if (profile.traits.includes("greedy")) {
        return "accept_with_appreciation_for_value";
      }
      if (profile.traits.includes("generous")) {
        return "reciprocate_generously";
      }
      if (profile.trust < 30) {
        return "suspicious_of_gift";
      }
    }

    // Kindness / family-care check — cooking for someone, helping with
    // chores, leaving money, comforting, protecting. Warm-hearted NPCs
    // (generous / empathetic / loyal) reciprocate strongly; everyone else
    // still responds with a mild warm nudge so kind acts toward present
    // NPCs (especially family at home) genuinely register in the stats.
    if (matchesStimulusCategory(normalized, "care")) {
      if (
        profile.traits.includes("generous") ||
        profile.traits.includes("empathetic") ||
        profile.traits.includes("loyal")
      ) {
        return "reciprocate_generously";
      }
      return "respond_warmly";
    }

    return "normal_response";
  },

  /**
   * Reaction WITH the remembered-mood bias applied. The base reaction comes
   * from getReaction (traits + thresholds + stimulus); the STRONGEST remembered
   * reaction for this NPC then nudges cooperation — a remembered cold reaction
   * makes them less likely to cooperate this turn (warm paths mute, neutral
   * turns guarded), a remembered warm reaction gently eases the response.
   * Used by the witness/reaction pipeline so the narrative, the interruption
   * check, and the stat deltas all agree on the same mood.
   */
  getMoodedReaction(npcName: string, stimulus: string): string {
    const base = this.getReaction(npcName, stimulus);
    const mood = getNpcMood(npcName);
    if (mood < 0 && COLD_MOOD_DOWNGRADES[base]) {
      return COLD_MOOD_DOWNGRADES[base];
    }
    if (mood > 0 && WARM_MOOD_UPGRADES[base]) {
      return WARM_MOOD_UPGRADES[base];
    }
    return base;
  },

  /**
   * Get all living NPC profiles for prompt injection.
   */
  getLivingProfiles(): NPCProfile[] {
    const s = StateModule.state;
    const aliveNames = new Set(
      (s.memory.relations || [])
        .filter((r) => r.status === "Alive")
        .map((r) => r.name.toLowerCase()),
    );

    return s.npcProfiles.filter((p) => aliveNames.has(p.npcName.toLowerCase()));
  },

  /**
   * Find profile by name (with fuzzy matching against aliases).
   */
  findProfile(name: string): NPCProfile | undefined {
    const s = StateModule.state;
    const search = name.toLowerCase();

    return s.npcProfiles.find((p) => {
      if (p.npcName.toLowerCase() === search) return true;
      return false;
    });
  },

  /**
   * Add an inter-NPC relationship.
   */
  addNPCRelationship(npcName: string, relationship: NPCRelationship): void {
    const s = StateModule.state;
    const profile = s.npcProfiles.find(
      (p) => p.npcName.toLowerCase() === npcName.toLowerCase(),
    );
    if (profile) {
      profile.relationships.push(relationship);
    }
  },

  /**
   * Adjust NPC trust/affection based on player actions.
   */
  adjustAffection(npcName: string, delta: number): void {
    const s = StateModule.state;
    const profile = s.npcProfiles.find(
      (p) => p.npcName.toLowerCase() === npcName.toLowerCase(),
    );
    if (profile) {
      profile.affection = Math.max(0, Math.min(100, profile.affection + delta));
      // Trust adjusts more slowly
      profile.trust = Math.max(0, Math.min(100, profile.trust + Math.floor(delta * 0.5)));
    }
  },

  /**
   * Adjust NPC trust specifically.
   */
  adjustTrust(npcName: string, delta: number): void {
    const s = StateModule.state;
    const profile = s.npcProfiles.find(
      (p) => p.npcName.toLowerCase() === npcName.toLowerCase(),
    );
    if (profile) {
      profile.trust = Math.max(0, Math.min(100, profile.trust + delta));
    }
  },

  /**
   * Apply reaction-driven changes to BOTH stats at their exact deltas — used
   * by the witness-reaction pipeline. Deliberately does NOT route through
   * adjustAffection (which nudges trust by half its delta): the reaction
   * switch already computes independent, explicit trust and affection values.
   */
  applyReactionDeltas(npcName: string, trustDelta: number, affectionDelta: number): void {
    const s = StateModule.state;
    const profile = s.npcProfiles.find(
      (p) => p.npcName.toLowerCase() === npcName.toLowerCase(),
    );
    if (profile) {
      profile.trust = Math.max(0, Math.min(100, profile.trust + trustDelta));
      profile.affection = Math.max(0, Math.min(100, profile.affection + affectionDelta));
    }
  },

  /**
   * Refine reactions from the AI's OWN narrative: when the model describes a
   * named NPC with an emotional cue ("Wren glares at you coldly.") even though
   * the MC's action text was neutral, apply a MILD trust/affection nudge in
   * the cue's direction. Sentence-scoped (the NPC's name must appear in the
   * same or previous sentence, so pronoun references like "She glares..."
   * still resolve), one nudge per NPC per turn (first in narrative order), and
   * NPCs that already reacted this turn with nonzero deltas are excluded so
   * the same event is never double-counted. Returns what was applied.
   */
  applyNarrativeNudges(
    narrative: string,
    excludeNames?: Set<string>,
  ): Array<{ npcName: string; cue: string; trustDelta: number; affectionDelta: number }> {
    const s = StateModule.state;
    const applied: Array<{ npcName: string; cue: string; trustDelta: number; affectionDelta: number }> = [];
    const sentences = (narrative || "").split(/(?<=[.!?])\s+/).filter(Boolean);
    const done = new Set<string>();

    for (let i = 0; i < sentences.length; i++) {
      const windowText = sentences.slice(Math.max(0, i - 1), i + 1).join(" ");
      for (const profile of s.npcProfiles) {
        const lower = profile.npcName.toLowerCase();
        if (done.has(lower) || excludeNames?.has(lower)) continue;
        if (!new RegExp(`\\b${escapeRegExp(profile.npcName)}\\b`, "i").test(windowText)) {
          continue;
        }
        for (const cue of NARRATIVE_CUES) {
          if (cue.regex.test(sentences[i])) {
            if (cue.trustDelta !== 0 || cue.affectionDelta !== 0) {
              this.applyReactionDeltas(profile.npcName, cue.trustDelta, cue.affectionDelta);
              applied.push({
                npcName: profile.npcName,
                cue: cue.cue,
                trustDelta: cue.trustDelta,
                affectionDelta: cue.affectionDelta,
              });
            }
            done.add(lower);
            break;
          }
        }
      }
    }
    return applied;
  },

  /**
   * Move NPC profiles when the turn's prose says they left for a place
   * (user action text + the AI's tag-stripped response). Runs BEFORE the
   * witness check so a mother who "left for her double shift at the diner"
   * stops reacting from home that same turn. Returns the number of profiles
   * relocated.
   */
  applyLocationShifts(userText: string, narrative: string): number {
    const s = StateModule.state;
    const mcName = (s.char.name || "").toLowerCase();
    const profiles = s.npcProfiles.filter(
      (p) => p.npcName.toLowerCase() !== mcName,
    );
    if (profiles.length === 0) return 0;

    const deceased = new Set<string>();
    for (const r of s.memory.relations || []) {
      if (r.status === "Deceased") {
        deceased.add(r.name.toLowerCase());
        for (const a of r.aliases || []) deceased.add(a.toLowerCase());
      }
    }

    // Match keys per profile: the profile's own name plus relation aliases
    // ("Lin Wei" matches "Mother", "Mom", "Mum", "Mama").
    const keysByProfile = new Map<string, string[]>();
    for (const p of profiles) {
      const keys = [p.npcName];
      const rel = (s.memory.relations || []).find(
        (r) => r.name.toLowerCase() === p.npcName.toLowerCase(),
      );
      for (const a of rel?.aliases || []) keys.push(a);
      keysByProfile.set(p.npcName.toLowerCase(), keys);
    }

    const sentences = [
      ...(userText || "").split(/(?<=[.!?])\s+/),
      ...(narrative || "").split(/(?<=[.!?])\s+/),
    ].filter(Boolean);

    const home = homeLocationFallback();
    let moved = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const prev = i > 0 ? sentences[i - 1] : "";
      for (const p of profiles) {
        const low = p.npcName.toLowerCase();
        if (deceased.has(low)) continue;
        const keys = keysByProfile.get(low) || [];
        const mentions = (k: string) =>
          k && new RegExp(`\\b${escapeRegExp(k)}\\b`, "i").test(sentence);
        const mentionedHere = keys.some(mentions);
        if (!mentionedHere) {
          // Pronoun references ("She left for work.") resolve through the
          // previous sentence — but only when no OTHER named NPC appears in
          // this one (so "The dog went to the park." after a name never
          // relocates that NPC).
          const pronounStart = /^\s*(?:she|he|they|her|his|their)\b/i.test(sentence);
          if (!pronounStart) continue;
          const otherNamed = profiles.some(
            (q) =>
              q !== p &&
              (keysByProfile.get(q.npcName.toLowerCase()) || []).some(
                (k) =>
                  k &&
                  new RegExp(`\\b${escapeRegExp(k)}\\b`, "i").test(sentence),
              ),
          );
          const mentionedPrev = keys.some((k) => {
            if (!k) return false;
            const re = new RegExp(`\\b${escapeRegExp(k)}\\b`, "i");
            return re.test(prev);
          });
          if (otherNamed || !mentionedPrev) continue;
        }

        const place = extractLocationPlace(sentence);
        if (!place) continue;
        const target = place === HOME_PLACE ? home : place;
        if (!target) continue;
        if (target.toLowerCase() === (p.knownLocation || "").toLowerCase()) {
          continue;
        }
        p.knownLocation = target;
        moved++;
      }
    }
    return moved;
  },
};
