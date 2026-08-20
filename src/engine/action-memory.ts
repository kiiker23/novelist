// =============================================================================
// action-memory.ts — episodic action memory.
//
// The chat log alone is NOT enough for continuity: it gets compressed as the
// session grows, and after a restart (Ollama closed overnight) the model no
// longer remembers what the MC did. This module keeps a durable, structured
// log of the MC's actual actions — with whom, when, and how it went — that
// persists in the save and is re-injected into every turn's payload as
// RECENT ACTION MEMORY.
//
// Entries are harvested automatically from signals the engine already
// processes (resolved [CHECK] results, NPC reactions, gifts) plus explicit
// [MEMORY] tags the AI can emit for notable moments — and intimacy
// milestones (kisses, hand-holding, hugs) are detected straight from the
// narration and the player's action text, so purely narrative moments need
// no tag at all. The AI is told to CHECK
// this log whenever the player references a past action — so "this sparring
// partner is weaker than the one I beat yesterday" is verified against
// yesterday's entry instead of dismissed as speculation, and intimacy
// comparisons ("we already kissed; hand-holding is below that") are grounded
// in what actually happened.
// =============================================================================

import { StateModule } from "../state/state";
import {
  ActionCategory,
  ActionMemoryEntry,
  CheckRecord,
} from "../state/GameState";
import { unwrapJsonBlock } from "./tag-utils";
import { containsWholeWord } from "./family-names";
import { OUTCOME_LABELS } from "./stat-checks";
import { MINUTES_PER_DAY, parseWorldClock } from "./director-notes";

/**
 * Currency names that are really the engine's own accounting, not spendable
 * money — the game mirrors char.systemPoints into a "systemPoints" currency
 * entry, so diffing it as a currency double-reports with the real
 * systemPoints delta. Case-insensitive; "system points" spacing included.
 */
const PSEUDO_CURRENCIES = new Set(["systempoints", "system points", "system-points"]);

/** Hard cap on retained entries — oldest are pruned first. */
const MEMORY_CAP = 40;

/** How many entries the payload reminder shows (most recent first). */
const REMINDER_LIMIT = 6;

/** Intensity (0-100) of an automatically-harvested check by outcome tier. */
const OUTCOME_INTENSITY: Record<string, number> = {
  critical_failure: 15,
  major_failure: 30,
  minor_failure: 45,
  neutral: 55,
  minor_success: 65,
  major_success: 80,
  critical_success: 95,
};

/** Which category a stat check belongs to (for like-with-like comparison). */
const STAT_CATEGORY: Record<string, ActionCategory> = {
  STR: "combat",
  AGI: "combat",
  END: "combat",
  CHA: "social",
  SEDUCTION: "intimacy",
  NEGOTIATION: "social",
  INTIMIDATION: "social",
  SNEAKING: "adventure",
  INT: "school",
  WIL: "cultivation",
  LCK: "other",
  PER: "adventure",
};

/**
 * Intimacy milestones harvested automatically from the narration and the
 * player's action text, in priority order (make-outs before plain kisses so
 * "french kiss" never lands as just "kiss"). Each milestone carries an
 * intensity on the same 0-100 scale the [MEMORY] tag uses — a hand-hold is
 * ~12, a hug ~20, a kiss ~45, making out ~65 — so the AI can compare today's
 * step against what already happened ("we kissed before; hand-holding is
 * below that").
 */
// NOTE: every milestone regex MUST carry the global (g) flag — the scanner
// advances via re.lastIndex, and without g, exec() ignores lastIndex and
// returns the same match forever (an infinite loop).
const INTIMACY_MILESTONES: Array<{ re: RegExp; label: string; intensity: number }> = [
  {
    re: /\b(made out|making out|french(?:ed)? kiss(?:es|ing)?|deep kiss(?:es|ing)?|soul kiss(?:es|ing)?)\b/gi,
    label: "Made out with",
    intensity: 65,
  },
  {
    re: /\b(kissed|kiss(?:es|ing)?|smooch(?:ed|ing)?|peck(?:ed)?)\b/gi,
    label: "Kissed",
    intensity: 45,
  },
  {
    re: /\b(?:held|holds?|holding|taken) (?:[a-z]+'s )?hands?\b|\bhand in hand\b|\btook(?: her| his| their| my) hands?\b|\btakes(?: her| his| their| my) hands?\b|\blinked (?:fingers|arms)\b|\binterlaced fingers?\b/gi,
    label: "Held hands with",
    intensity: 12,
  },
  {
    re: /\b(cuddled|cuddling|snuggled|snuggling|spooned|spooning)\b/gi,
    label: "Cuddled with",
    intensity: 25,
  },
  {
    re: /\b(hugged|hug(?:ging)?|embraced|embracing|held (?:her|him|each other) close|wrapped (?:her|his|their) arms around)\b/gi,
    label: "Hugged",
    intensity: 20,
  },
];

/** Person indicators that make a milestone "real" ("I kissed her") rather than
 * a metaphor ("the sun kissed the ground"). */
const PERSON_RE =
  /\b(i|me|my|we|us|our|her|him|his|she|he|they|them|their|you|your)\b/i;

/**
 * Non-person subjects that turn a verb into a metaphor even when a pronoun
 * sits later in the sentence: "the SUN kissed the ground as HE stepped
 * outside" is not a milestone. Checked against the word(s) immediately
 * before the matched verb.
 */
const NON_PERSON_SUBJECTS = new Set([
  "sun", "moon", "wind", "breeze", "rain", "water", "wave", "tide", "shore",
  "ground", "sky", "air", "fire", "flame", "light", "morning", "evening",
  "dusk", "dawn", "shadow", "darkness", "snow", "grass", "leaf", "leaves",
  "cloud", "clouds", "mist", "fog", "gale", "storm", "night", "day",
]);

/**
 * Find intimacy milestones in a piece of prose. Returns the strongest match
 * per span (priority order wins), each with a summary and intensity. A match
 * needs a person nearby — a named NPC or a person pronoun — so "the sun
 * kissed the ground" and "the water kissed the shore" never become memories.
 */
export function findIntimacyMilestones(
  text: string | undefined,
): Array<{ label: string; summary: string; npc?: string; intensity: number }> {
  if (!text) return [];
  const out: Array<{ label: string; summary: string; npc?: string; intensity: number }> = [];
  const accepted: Array<{ start: number; end: number }> = [];
  for (const m of INTIMACY_MILESTONES) {
    m.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = m.re.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      // Skip spans already claimed by a higher-priority milestone.
      if (accepted.some((a) => start < a.end && end > a.start)) {
        m.re.lastIndex = end;
        continue;
      }
      // Person context: a named NPC or a person pronoun within ±25 chars.
      const lo = Math.max(0, start - 25);
      const hi = Math.min(text.length, end + 25);
      const window = text.slice(lo, hi);
      const npc = findMentionedNpc(window);
      const pronoun = window.match(PERSON_RE);
      if (!npc && !pronoun) {
        m.re.lastIndex = end;
        continue;
      }
      // Metaphor guard: "the sun kissed the ground" — the subject right
      // before the verb is not a person, even if a pronoun appears later.
      const beforeTok = text
        .slice(Math.max(0, start - 16), start)
        .trim()
        .split(/\s+/)
        .pop()
        ?.toLowerCase();
      if (beforeTok && NON_PERSON_SUBJECTS.has(beforeTok)) {
        m.re.lastIndex = end;
        continue;
      }
      const pro = window.match(/\b(her|him|them|me|us)\b/i);
      out.push({
        label: m.label,
        summary: npc ? `${m.label} ${npc}` : pro ? `${m.label} ${pro[1].toLowerCase()}` : m.label,
        npc,
        intensity: m.intensity,
      });
      accepted.push({ start, end });
      m.re.lastIndex = end;
    }
  }
  return out;
}

/** A dedup key so the same milestone (same type, same partner) isn't recorded
 * twice in one turn when both the action and the narration mention it. */
function milestoneKey(m: { label: string; npc?: string; intensity: number }): string {
  return `${m.label}:${(m.npc || "").toLowerCase()}`;
}

/**
 * Economic milestones harvested automatically from the narration and the
 * player's action text — crypto trades, marketplace runs, investments,
 * gambling, significant purchases/sales. Economic actions are easy for the
 * AI to forget: they usually produce NO [CHECK], NO reaction, and NO [GIFT],
 * so without this scanner they only exist in the chat prose (which gets
 * compressed) — the model then claims "first time" when the player brings up
 * a trade from 20 turns ago. Like intimacy milestones, each carries an
 * intensity so the AI can compare today's bet/trade against earlier ones.
 *
 * The verb-only patterns ("trade", "bought") require a money or market
 * context word nearby so "trading blows" and "bought time" never count.
 */
// NOTE: every milestone regex MUST carry the global (g) flag — the scanner
// advances via re.lastIndex (see the intimacy note above).
const ECONOMIC_MILESTONES: Array<{ re: RegExp; label: string; intensity: number; needsContext?: boolean; needsAmount?: boolean }> = [
  // Crypto / trading platform — unmistakably economic on its own. Requires
  // an actual trading act or platform, NOT the bare word "crypto" ("crypto
  // trading ... are ways to make income" is a plan, not an action).
  {
    re: /\b(trad(?:e|ed|ing) (?:coins?|on (?:the )?(?:crypto|trading|exchange) platform)|trading platform|trading account|(?:bitcoin|ethereum) (?:trad(?:e|ed|ing)?|position|portfolio)|bought (?:bitcoin|ethereum|coins?))\b/gi,
    label: "Traded crypto",
    intensity: 65,
  },
  // Marketplace / flipping / reselling goods. A bare "marketplace" mention
  // ("a small online marketplace for rare collectibles") is browsing, not
  // selling — only the actual flipping/reselling verbs count as a sale.
  {
    re: /\b(flip(?:ped|ping)? (?:goods|items|collectibles)|resell(?:ing|s)?|sold (?:on|through) (?:the )?marketplace)\b/gi,
    label: "Sold on the marketplace",
    intensity: 50,
  },
  {
    re: /\bmarketplace\b/gi,
    label: "Browsed the marketplace",
    intensity: 30,
  },
  // Gambling — actual bets, not the MC merely weighing "gambling... as a way
  // to make income" (a plan, not an action). Past-tense gambled or a
  // specific bet/casino/lottery act counts; the gerund "gambling" alone does
  // not.
  {
    re: /\bgambled\b|\bbet(?:s|ting)? (?:on|at|\d)|\bwagered?\b|\bcasino\b|\blottery\b|\bplaced? a bet\b/gi,
    label: "Gambled",
    intensity: 70,
  },
  // Investing / portfolio management.
  {
    re: /\b(invest(?:ed|ing|ment)?|portfolio)\b/gi,
    label: "Invested",
    intensity: 55,
  },
  // Generic trade verb — needs an actual currency AMOUNT nearby to count
  // ("use all 547.50 to trade"); "trade" in prose like "trade secrets" or
  // "traded blows" is never economic. Skips "trading platform/account/…"
  // (already caught by the crypto rule above).
  {
    re: /\btrad(?:e|ed|ing)?\b(?! (?:platform|account|bot|exchange))/gi,
    label: "Traded",
    intensity: 50,
    needsAmount: true,
  },
  // Significant purchase/sale — needs a currency amount nearby.
  {
    re: /\b(bought|sold|purchased)\b/gi,
    label: "Bought or sold",
    intensity: 45,
    needsContext: true,
  },
];

/** Money or market context that makes a bare "trade"/"bought" economic. */
const ECONOMIC_CONTEXT_RE =
  /(?:USD|dollars?|\$\s?\d|coins?|credits?|system points?|stocks?|shares?|platform|market|portfolio|bitcoin|crypto)/i;

/**
 * Find economic milestones in prose. Returns matches with a label, a summary
 * (the label plus a "(amount)" suffix when a currency value sits nearby), and
 * an intensity. The generic verb patterns only fire when a money/market word
 * appears within a short window, so "they traded blows" and "she bought time"
 * are never harvested as economic actions.
 */
export function findEconomicMilestones(
  text: string | undefined,
): Array<{ label: string; summary: string; intensity: number; amount?: string }> {
  if (!text) return [];
  const out: Array<{ label: string; summary: string; intensity: number; amount?: string }> = [];
  for (const m of ECONOMIC_MILESTONES) {
    m.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = m.re.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const lo = Math.max(0, start - 30);
      const hi = Math.min(text.length, end + 30);
      const window = text.slice(lo, hi);
      if (m.needsContext && !ECONOMIC_CONTEXT_RE.test(window)) {
        m.re.lastIndex = end;
        continue;
      }
      // Pull a nearby currency amount for the summary ("Traded (547.50 USD)").
      const amountMatch = window.match(/(\d[\d,]*(?:\.\d+)?\s*(?:USD|dollars?|coins?|credits?|system points?))|\$\s?\d[\d,]*(?:\.\d+)?/i);
      if (m.needsAmount && !amountMatch) {
        m.re.lastIndex = end;
        continue;
      }
      const amount = amountMatch ? amountMatch[0].trim() : undefined;
      out.push({
        label: m.label,
        summary: amount ? `${m.label} (${amount})` : m.label,
        intensity: m.intensity,
        amount,
      });
      m.re.lastIndex = end;
    }
  }
  return out;
}

/**
 * NPC reaction phrases detected straight from the narration prose — "Nina
 * reacts warmly", "Mara smiled at you", "the guard glares at you", "she is
 * furious". The witness-based reaction pipeline only fires for NPCs present
 * at the MC's location on qualifying actions, so a purely narrative social
 * moment (the model describes an NPC's reaction without any trigger) never
 * reaches memory through it. This scanner catches those, so "Nina reacts
 * warmly" is remembered even when no [CHECK] / [MEMORY] tag fired — the AI
 * can then compare today's interaction against how Nina felt before.
 */
// NOTE: every pattern regex MUST carry the global (g) flag (see the
// intimacy/economic notes above — the scanner advances via re.lastIndex).
// `effect: true` patterns carry capture groups (verb, adjective / up-down)
// so the summary can be rebuilt as "Made Nina happy" instead of the raw
// pronoun phrasing.
const NPC_REACTION_PATTERNS: Array<{ re: RegExp; effect?: boolean }> = [
  // "Nina reacts warmly / coldly / with jealousy" — the canonical reaction
  // phrasing the AI uses after an interaction. Valence is classified from
  // the matched word below.
  {
    re: /\breact(?:s|ed|ing)? (?:very |quite |visibly )?(?:warmly|coldly|coolly|angrily|favorably|positively|negatively|with (?:warmth|hostility|jealousy|distrust|affection|annoyance|pleasure|joy|delight|anger|fury|contempt|surprise))\b/gi,
  },
  // Warm/generous reactions. Includes the eye/face phrasings romance prose
  // favors ("her eyes soften", "his face lights up") which don't carry an
  // explicit "at you".
  {
    re: /\b(smiles?|smiled|beams?|beamed|grins?|grinned|glows?|glowed|warmed?|softens?|lights? up) (?:at|upon|towards?)\s+(?:you|me|him|her|them)\b|\b(?:eyes?|face|expression) (?:soften(?:s|ed)?|light(?:s|ed)? up|warm(?:s|ed)?|brighten(?:s|ed)?|glow(?:s|ed)?)\b/gi,
  },
  // Cold/aggressive reactions.
  {
    re: /\b(glare[ds]?|scowl[ds]?|frown[ds]?|snarl[ds]?|sneer[ds]?|sigh[ds]?|groan[ds]?|stiffens?|flinch(?:es|ed)?) (?:at|upon|towards?)\s+(?:you|me|him|her|them)\b/gi,
  },
  // Emotional state descriptions — needs the NPC named nearby ("Nina is
  // furious"); the pattern alone is too generic to fire on its own.
  {
    re: /\b(?:is|looks|seems|appears|grows?) (?:very |visibly |clearly )?(?:pleased|delighted|happy|glad|warm|annoyed|furious|angry|irritated|cold|distant|hostile|disappointed|relieved|embarrassed)\b/gi,
  },
  // MC-effect verbs — the reaction attributed through the MC's OWN action on
  // the NPC ("I make her happy", "I made Nina angry", "I cheer her up",
  // "I calm her down"). Group 1 = make-style verb, 2 = the adjective, 3 =
  // cheer/calm verb, 4 = up/down. Deliberately case-SENSITIVE (no i flag):
  // the object must be a pronoun or a PROPER NOUN (initial capital), so
  // "Nina's gift makes ME happy" (NPC acting on the MC) and "make the whole
  // class happy" (generic object) can never fire as an MC-effect on an NPC.
  {
    effect: true,
    re: /\b([Mm]ake|[Mm]ade|[Mm]akes|[Cc]omfort(?:s|ed)?|[Ss]oothe(?:s|d)?|[Dd]elight(?:s|ed)?|[Pp]lease(?:s|d)?|[Aa]nger(?:s|ed)?|[Uu]psets?|[Ss]adden(?:s|ed)?|[Ff]righten(?:s|ed)?|[Ss]care(?:s|d)?|[Aa]nnoy(?:s|ed)?|[Ii]rritate(?:s|d)?)\s+(?:her|him|them|you|[A-Z][a-zA-Z'’\-]*(?:\s+[A-Z][a-zA-Z'’\-]*)?)\s+(?:feel\s+)?(?:very\s+|visibly\s+|clearly\s+)?(happy|glad|pleased|delighted|warm|better|calm|relieved|sad|angry|furious|annoyed|irritated|upset|scared|afraid|cold|distant|worried|anxious|worse)\b|([Cc]heer(?:s|ed)?|[Cc]alm(?:s|ed)?)\s+(?:her|him|them|you|[A-Z][a-zA-Z'’\-]*(?:\s+[A-Z][a-zA-Z'’\-]*)?)\s+(up|down)\b/g,
  },
];

/** Past tense for MC-effect verbs so summaries read "Made Nina happy". */
const EFFECT_VERB_PAST: Record<string, string> = {
  make: "made",
  makes: "made",
  made: "made",
  comfort: "comforted",
  comforts: "comforted",
  comforted: "comforted",
  soothe: "soothed",
  soothes: "soothed",
  soothed: "soothed",
  delight: "delighted",
  delights: "delighted",
  delighted: "delighted",
  please: "pleased",
  pleases: "pleased",
  pleased: "pleased",
  anger: "angered",
  angers: "angered",
  angered: "angered",
  upset: "upset",
  upsets: "upset",
  sadden: "saddened",
  saddens: "saddened",
  saddened: "saddened",
  frighten: "frightened",
  frightens: "frightened",
  frightened: "frightened",
  scare: "scared",
  scares: "scared",
  scared: "scared",
  annoy: "annoyed",
  annoys: "annoyed",
  annoyed: "annoyed",
  irritate: "irritated",
  irritates: "irritated",
  irritated: "irritated",
  cheer: "cheered",
  cheers: "cheered",
  cheered: "cheered",
  calm: "calmed",
  calms: "calmed",
  calmed: "calmed",
};

/** Valence of an MC-effect adjective: warm vs cold. */
const EFFECT_POSITIVE_ADJ_RE = /\b(happy|glad|pleased|delighted|warm|better|calm|relieved)\b/i;
const EFFECT_NEGATIVE_ADJ_RE =
  /\b(sad|angry|furious|annoyed|irritated|upset|scared|afraid|cold|distant|worried|anxious|worse)\b/i;

/** Positive reaction words → warm memory; negative → cold, heavier memory. */
const REACTION_POSITIVE_RE =
  /(?:warmly|favorably|positively|warmth|affection|pleasure|joy|delight|smiles?|smiled|beams?|beamed|grins?|grinned|glows?|glowed|pleased|delighted|happy|glad|relieved|soften(?:s|ed)?|light(?:s|ed)? up|warmed?|brighten(?:s|ed)?|surprise)/i;
const REACTION_NEGATIVE_RE =
  /(?:coldly|coolly|angrily|negatively|hostility|jealousy|distrust|annoyance|anger|fury|contempt|glare[ds]?|scowl[ds]?|frown[ds]?|snarl[ds]?|sneer[ds]?|sigh[ds]?|groan[ds]?|annoyed|furious|angry|irritated|cold|distant|hostile|disappointed|stiffens?|flinch(?:es|ed)?)/i;

/**
 * Find NPC reactions in prose — the model's narration and the player's own
 * action text ("Nina reacts warmly", "Mara smiled at you", "I tell Nina a
 * joke. Nina seems happy."). Returns matches with the reaction phrase and
 * the NPC who reacted (must be a registered NPC name nearby — "the sun
 * smiled at you" and "the kettle glowed" never count). A person pronoun
 * alone ("she smiled at you") is skipped unless the name appears in the
 * same text.
 */
export function findNpcReactions(
  text: string | undefined,
  names?: string[],
): Array<{ npc: string; phrase: string; summary: string; valence: number }> {
  if (!text) return [];
  const out: Array<{ npc: string; phrase: string; summary: string; valence: number }> = [];
  const accepted: Array<{ start: number; end: number }> = [];
  const known = names || collectNpcNames();
  for (const p of NPC_REACTION_PATTERNS) {
    p.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = p.re.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (accepted.some((a) => start < a.end && end > a.start)) {
        p.re.lastIndex = end;
        continue;
      }
      // The NPC who reacted must be named within ±35 chars ("Nina reacts
      // warmly"). Without a name the memory would be useless ("Reacted
      // warmly" — who?). An NPC named INSIDE the phrase itself wins first —
      // the MC-effect object ("calm Rook down") must resolve to Rook, not
      // whoever else happens to appear earlier in the window.
      const lo = Math.max(0, start - 35);
      const hi = Math.min(text.length, end + 35);
      const npc =
        resolveNpcName(match[0], known) ||
        resolveNpcName(text.slice(lo, hi), known);
      if (!npc) {
        p.re.lastIndex = end;
        continue;
      }
      const phrase = match[0].trim();
      let summary: string;
      let valence: number;
      if (p.effect) {
        // MC-effect: rebuild as "Made Nina happy" / "Cheered Nina up" /
        // "Calmed Nina down" instead of the raw pronoun phrasing.
        const makeVerb = match[1];
        const adj = match[2];
        const upDownVerb = match[3];
        const dir = match[4];
        if (makeVerb && adj) {
          const past = EFFECT_VERB_PAST[makeVerb.toLowerCase()] || makeVerb.toLowerCase();
          summary = `${past.charAt(0).toUpperCase() + past.slice(1)} ${npc} ${adj.toLowerCase()}`;
          valence =
            EFFECT_NEGATIVE_ADJ_RE.test(adj) && !EFFECT_POSITIVE_ADJ_RE.test(adj)
              ? -1
              : 1;
        } else if (upDownVerb && dir) {
          const past = EFFECT_VERB_PAST[upDownVerb.toLowerCase()] || upDownVerb.toLowerCase();
          summary = `${past.charAt(0).toUpperCase() + past.slice(1)} ${npc} ${dir.toLowerCase()}`;
          // Cheering up / calming down are always warm acts.
          valence = 1;
        } else {
          summary = `${npc} ${phrase.charAt(0).toLowerCase() + phrase.slice(1)}`;
          valence = 0;
        }
      } else {
        const positive = REACTION_POSITIVE_RE.test(phrase);
        const negative = REACTION_NEGATIVE_RE.test(phrase);
        // "eyes soften" / "face lights up" read naturally as "Nina's eyes
        // soften" — the possessive form — not "Nina eyes soften".
        const possessive = /^(?:eyes?|face|expression)\b/.test(phrase);
        summary = possessive
          ? `${npc}'s ${phrase.charAt(0).toLowerCase() + phrase.slice(1)}`
          : `${npc} ${phrase.charAt(0).toLowerCase() + phrase.slice(1)}`;
        valence = positive && !negative ? 1 : negative && !positive ? -1 : 0;
      }
      out.push({
        npc,
        phrase,
        summary,
        valence,
      });
      accepted.push({ start, end });
      p.re.lastIndex = end;
    }
  }
  return out;
}

/** Collect the registered NPC names (primary + aliases) from a save state or
 * the live module state. */
function collectNpcNames(source?: {
  npcProfiles?: Array<{ npcName: string }>;
  memory?: { relations?: Array<{ name: string; aliases?: string[] }> };
}): string[] {
  const s = source || StateModule.state;
  const names: string[] = [];
  for (const p of s.npcProfiles || []) names.push(p.npcName);
  for (const r of s.memory?.relations || []) {
    names.push(r.name);
    for (const a of r.aliases || []) names.push(a);
  }
  return names;
}

/** An NPC named in a check's context or the player's action (primary name). */
function findMentionedNpc(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return resolveNpcName(text, collectNpcNames());
}

/** Resolve a name/alias mention back to the primary NPC name (live state). */
function resolveNpcName(text: string | undefined, names: string[]): string | undefined {
  if (!text) return undefined;
  const s = StateModule.state;
  for (const n of names) {
    if (n && containsWholeWord(text, n)) {
      // Resolve aliases back to the primary name for stable comparisons.
      const rel = (s.memory?.relations || []).find(
        (r) => r.name.toLowerCase() === n.toLowerCase(),
      );
      const prof = (s.npcProfiles || []).find(
        (p) => p.npcName.toLowerCase() === n.toLowerCase(),
      );
      return prof?.npcName || rel?.name || n;
    }
  }
  return undefined;
}

function freshId(): string {
  return "am_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Append an entry, deduping an identical summary within the same turn. */
function pushEntry(entry: Omit<ActionMemoryEntry, "id">): void {
  const s = StateModule.state;
  s.actionMemory = s.actionMemory || [];
  const last = s.actionMemory[s.actionMemory.length - 1];
  if (last && last.turn === entry.turn && last.summary === entry.summary) return;
  s.actionMemory.push({ id: freshId(), ...entry });
  if (s.actionMemory.length > MEMORY_CAP) {
    s.actionMemory.splice(0, s.actionMemory.length - MEMORY_CAP);
  }
}

/** Parse explicit [MEMORY] JSON blocks. */
export function parseMemoryTags(text: string): Array<{
  summary: string;
  npc?: string;
  category?: ActionCategory;
  intensity?: number;
  outcome?: string;
  reward?: string;
  detail?: string;
}> {
  const out: Array<{
    summary: string;
    npc?: string;
    category?: ActionCategory;
    intensity?: number;
    outcome?: string;
    reward?: string;
    detail?: string;
  }> = [];
  const re = /\[MEMORY\](.*?)\[\/MEMORY\]/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const data = JSON.parse(unwrapJsonBlock(m[1]));
      if (!data || typeof data.summary !== "string" || !data.summary.trim()) continue;
      out.push({
        summary: data.summary.trim(),
        npc: typeof data.npc === "string" && data.npc.trim() ? data.npc.trim() : undefined,
        category: data.category || "other",
        intensity: typeof data.intensity === "number" ? data.intensity : undefined,
        outcome:
          typeof data.outcome === "string" && data.outcome.trim() ? data.outcome.trim() : undefined,
        reward:
          typeof data.reward === "string" && data.reward.trim() ? data.reward.trim() : undefined,
        detail:
          typeof data.detail === "string" && data.detail.trim() ? data.detail.trim() : undefined,
      });
    } catch {
      /* malformed block — skip without touching state */
    }
  }
  return out;
}

/**
 * Harvest this turn's action memory. Call AFTER the check/reaction/gift
 * pipelines ran, passing the records they produced this turn.
 */
export function harvestActionMemory(opts: {
  aiText: string;
  /** Tag-stripped narration prose (the [MEMORY]/[CHECK] payloads are never scanned). */
  narration?: string;
  actionText?: string;
  newChecks?: CheckRecord[];
  reactions?: Array<{
    npcName: string;
    label: string;
    trustDelta: number;
    affectionDelta: number;
  }>;
  newGifts?: Array<{ giver: string; recipient: string; itemName: string }>;
  newTransactions?: Array<{
    type?: string;
    itemName?: string;
    amount?: number;
    currency?: string;
    partner?: string;
  }>;
  /** State deltas detected from this turn's [STATE_UPDATE] blocks. */
  stateDelta?: {
    /** Net systemPoints change (positive = earned, negative = spent). */
    systemPointsDelta?: number;
    /** Items newly present in the inventory after the update. */
    gainedItems?: string[];
    /** Items that left the inventory after the update. */
    lostItems?: string[];
    /** Currency balance changes (positive = earned, negative = spent). */
    currencyDeltas?: Array<{ name: string; delta: number }>;
  };
}): void {
  const s = StateModule.state;
  const time = s.worldState.time;
  const turn = s.turnCount;

  // 1. Explicit [MEMORY] tags — the AI records a notable moment.
  for (const t of parseMemoryTags(opts.aiText)) {
    pushEntry({
      summary: t.summary,
      npc: t.npc || findMentionedNpc(t.summary),
      category: t.category || "other",
      intensity:
        typeof t.intensity === "number"
          ? Math.max(0, Math.min(100, t.intensity))
          : 60,
      outcome: t.outcome,
      reward: t.reward,
      detail: t.detail,
      time,
      turn,
    });
  }

  // 2. Intimacy milestones in the narration/action — a kiss, hand-holding,
  //    a hug. Purely narrative moments need no [MEMORY] tag: the prose is
  //    scanned and each milestone is remembered with its intensity so later
  //    intimacy can be compared against it ("we already kissed"). Deduped by
  //    partner + milestone type so "I lean in and kiss her" + "their lips met"
  //    in the same turn collapse into one memory.
  {
    const seen = new Set<string>();
    const milestones = [
      ...findIntimacyMilestones(opts.narration),
      ...findIntimacyMilestones(opts.actionText),
    ];
    // The narrator often drops the partner's name ("their lips met in a
    // kiss") — resolve it from BOTH texts combined so the action and the
    // prose collapse onto the same person, and the memory names them.
    const combined = `${opts.narration || ""} ${opts.actionText || ""}`;
    for (const m of milestones) {
      const npc = m.npc || findMentionedNpc(combined);
      const key = milestoneKey({ label: m.label, npc, intensity: m.intensity });
      if (seen.has(key)) continue;
      seen.add(key);
      const summary = npc ? `${m.label} ${npc}` : m.summary;
      pushEntry({
        summary,
        npc,
        category: "intimacy",
        intensity: m.intensity,
        time,
        turn,
      });
    }
  }

  // 3. Resolved [CHECK] results — every contested action is remembered with
  //    its stat, tier, and outcome, so later comparisons have a baseline.
  for (const c of opts.newChecks || []) {
    if (!c || !c.stat) continue;
    pushEntry({
      summary: c.context && c.context.trim() ? c.context.trim() : `${c.stat} check`,
      npc: findMentionedNpc(`${c.context || ""} ${opts.actionText || ""}`),
      category: STAT_CATEGORY[c.stat] || "other",
      intensity: OUTCOME_INTENSITY[c.outcome] ?? 50,
      outcome: `${OUTCOME_LABELS[c.outcome]} (${c.stat} ${c.difficulty})`,
      time,
      turn,
    });
  }

  // 4. NPC reactions — meaningful relationship movement is remembered.
  for (const r of opts.reactions || []) {
    if (!r || !r.npcName) continue;
    const deltas: string[] = [];
    if (r.affectionDelta !== 0) deltas.push(`Affection ${r.affectionDelta > 0 ? "+" : ""}${r.affectionDelta}`);
    if (r.trustDelta !== 0) deltas.push(`Trust ${r.trustDelta > 0 ? "+" : ""}${r.trustDelta}`);
    if (deltas.length === 0) continue;
    pushEntry({
      summary: `${r.npcName} reacted ${r.label || "strongly"}`,
      npc: r.npcName,
      category: "social",
      intensity: Math.max(20, Math.min(90, 50 + Math.abs(r.affectionDelta) + Math.abs(r.trustDelta))),
      outcome: deltas.join(", "),
      time,
      turn,
    });
  }

  // 5. Gifts — who gave whom what (gifted items change relationships).
  for (const g of opts.newGifts || []) {
    if (!g || !g.itemName) continue;
    pushEntry({
      summary: `${g.giver || "MC"} gave ${g.itemName} to ${g.recipient || "someone"}`,
      npc: g.recipient,
      category: "social",
      intensity: 60,
      outcome: "gift",
      time,
      turn,
    });
  }

  // 6. Economic milestones in the narration/action — crypto trades,
  //    marketplace runs, gambling, investments, significant purchases. These
  //    produce no [CHECK] and often no [TRANSACTION] tag either, so without
  //    this scan the model later claims "first time" for a trade it already
  //    made 20 turns ago. Deduped per label so one sentence mentioning a trade
  //    twice still lands a single memory.
  {
    const seen = new Set<string>();
    const combined = `${opts.narration || ""} ${opts.actionText || ""}`;
    for (const m of findEconomicMilestones(combined)) {
      // Dedup by full summary (label + amount): two separate trades in one
      // turn ("847.50 USD to trade … 297.50 USD to trade more") are two
      // memories, but the same sentence repeated once is one.
      const key = m.summary.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      pushEntry({
        summary: m.summary,
        category: "economy",
        intensity: m.intensity,
        outcome: m.amount ? `for ${m.amount}` : undefined,
        time,
        turn,
      });
    }
  }

  // 7. Transactions the engine actually recorded this turn ([TRANSACTION]
  //    tags) — the structured record of buys/sells/rewards, remembered so the
  //    AI can reference what was bought and at what price.
  for (const t of opts.newTransactions || []) {
    pushTransactionEntry(t, time, turn);
  }
  // 7b. Reconcile the FULL transaction log — transactions recorded by paths
  //     that run after this harvest (the structured-update fallback, old
  //     saves) must still be remembered. Idempotent: an entry already in the
  //     log with the same summary is skipped, so nothing is ever forgotten
  //     and nothing is ever duplicated.
  reconcileTransactionLog(time, turn);

  // 8. NPC reactions described straight in the narration prose ("Nina reacts
  //    warmly", "Mara smiled at you"). The witness pipeline already moves
  //    stats for NPCs present on qualifying actions — this catches the purely
  //    narrative ones so a social moment is remembered even when no trigger
  //    fired. NPCs that already reacted via the pipeline this turn are
  //    skipped (their memory was recorded in step 4).
  {
    const alreadyReacted = new Set(
      (opts.reactions || [])
        .filter((r) => r && r.npcName)
        .map((r) => r.npcName.toLowerCase()),
    );
    const seen = new Set<string>();
    // Scan BOTH the narration and the player's own action text — first-person
    // phrasing ("I tell Nina a joke. Nina seems happy.") names the NPC's
    // response without the model ever writing it into the prose. Deduped by
    // npc+phrase so the same reaction in both texts collapses into one entry.
    const reactionSources = [
      ...findNpcReactions(opts.narration),
      ...findNpcReactions(opts.actionText),
    ];
    for (const r of reactionSources) {
      if (alreadyReacted.has(r.npc.toLowerCase())) continue;
      const key = `${r.npc.toLowerCase()}:${r.phrase.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pushEntry({
        summary: r.summary,
        npc: r.npc,
        category: "social",
        // Warm reactions are remembered warmly; hostile ones carry more
        // weight (they change how the AI treats the next interaction).
        intensity: r.valence > 0 ? 55 : r.valence < 0 ? 65 : 45,
        outcome: r.valence > 0 ? "warm reaction" : r.valence < 0 ? "cold reaction" : undefined,
        time,
        turn,
      });
    }
  }

  // 9. [STATE_UPDATE] deltas — the AI records money/inventory movement in its
  //    state block with NO trade verb in the prose (a balance transfer, a
  //    purchase that only shows up as "systemPoints" ticking down, an item
  //    appearing in inventory). The engine diffs the state across the turn and
  //    remembers the movement, so a trade that never got a [TRANSACTION] tag
  //    or a prose mention still lands in memory. Items already covered by a
  //    [TRANSACTION] this turn are skipped (step 7 recorded the buy/sell).
  if (opts.stateDelta) {
    const txItems = new Set(
      (opts.newTransactions || [])
        .filter((t) => t && t.itemName)
        .map((t) => t.itemName!.toLowerCase()),
    );
    const d = opts.stateDelta;
    if (d.systemPointsDelta && Math.abs(d.systemPointsDelta) >= 1) {
      const sign = d.systemPointsDelta > 0 ? "+" : "";
      pushEntry({
        summary:
          d.systemPointsDelta > 0
            ? `Earned ${d.systemPointsDelta} system points`
            : `Spent ${Math.abs(d.systemPointsDelta)} system points`,
        category: "economy",
        intensity: d.systemPointsDelta > 0 ? 35 : 40,
        outcome: `system points ${sign}${d.systemPointsDelta}`,
        time,
        turn,
      });
    }
    for (const item of d.gainedItems || []) {
      if (!item || txItems.has(item.toLowerCase())) continue;
      pushEntry({
        summary: `Acquired ${item}`,
        category: "economy",
        intensity: 40,
        outcome: "inventory gain",
        time,
        turn,
      });
    }
    for (const item of d.lostItems || []) {
      if (!item || txItems.has(item.toLowerCase())) continue;
      pushEntry({
        summary: `Lost ${item}`,
        category: "economy",
        intensity: 35,
        outcome: "inventory loss",
        time,
        turn,
      });
    }
    // Currency balance movement (USD, gold, copper, …). The model can move a
    // balance directly in its [STATE_UPDATE] with no trade verb in prose and
    // no [TRANSACTION] tag — the diff catches it so the AI remembers "I've
    // traded USD before". Movement already covered by a [TRANSACTION] tag
    // this turn (which recorded the buy/sell with its price) is skipped so
    // the same spend never becomes both "Bought X for 3 Copper" AND "Spent
    // 3 Copper".
    const txSpend = new Set(
      (opts.newTransactions || [])
        .filter(
          (t) =>
            t && t.currency && t.amount != null &&
            (t.type === "buy" || t.type === "fine"),
        )
        .map((t) => `${(t.currency || "").toLowerCase()}|${Math.abs(t.amount as number)}`),
    );
    const txEarn = new Set(
      (opts.newTransactions || [])
        .filter(
          (t) =>
            t && t.currency && t.amount != null &&
            (t.type === "sell" || t.type === "reward"),
        )
        .map((t) => `${(t.currency || "").toLowerCase()}|${Math.abs(t.amount as number)}`),
    );
    for (const c of d.currencyDeltas || []) {
      if (!c || !c.name || c.delta === 0) continue;
      // Defensive: never harvest the systemPoints pseudo-currency even if a
      // caller hand-builds a stateDelta containing it.
      if (PSEUDO_CURRENCIES.has(c.name.toLowerCase())) continue;
      const key = `${c.name.toLowerCase()}|${Math.abs(c.delta)}`;
      if (c.delta < 0 && txSpend.has(key)) continue;
      if (c.delta > 0 && txEarn.has(key)) continue;
      const sign = c.delta > 0 ? "+" : "";
      pushEntry({
        summary:
          c.delta > 0
            ? `Earned ${c.delta} ${c.name}`
            : `Spent ${Math.abs(c.delta)} ${c.name}`,
        category: "economy",
        intensity: c.delta > 0 ? 35 : 40,
        outcome: `${c.name} ${sign}${c.delta}`,
        time,
        turn,
      });
    }
  }
}

/**
 * The RECENT ACTION MEMORY block injected into every turn's payload so the
 * AI sees the MC's recent history and can COMPARE the current action against
 * it. The header explicitly forbids dismissing player references as
 * speculation — the entries are the grounding the AI was missing. Each line
 * carries the entry's stable id so the AI can reference it explicitly with
 * [MEMORY_REF] (see parseMemoryRefs) instead of paraphrasing. Empty string
 * when nothing has been remembered yet.
 */
export function getActionMemoryReminder(): string {
  const s = StateModule.state;
  const mem = s.actionMemory || [];
  if (mem.length === 0) return "";
  const nowTime = s.worldState ? s.worldState.time : undefined;
  const recent = mem.slice(-REMINDER_LIMIT).reverse();
  const lines = recent.map((e) => {
    const when = `${e.time} · turn ${e.turn}`;
    const cat = e.category ? ` — ${e.category}` : "";
    const out = e.outcome ? ` · ${e.outcome}` : "";
    const rew = e.reward ? ` · ${e.reward}` : "";
    const decay = getMemoryDecay(e.time, nowTime);
    const decayedIntensity =
      e.intensity != null
        ? Math.max(0, e.intensity + decay.intensityMod)
        : undefined;
    const inten =
      decayedIntensity != null ? ` · intensity ${decayedIntensity}` : "";
    const faded = decay.level > 0 ? ` · ${decay.label}` : "";
    const id = e.id ? ` · id ${e.id}` : "";
    // Faint memories are prefixed so the AI hedges instead of reciting faded
    // details as if they were recorded yesterday.
    const summary =
      decay.level >= 3 ? `Vaguely: ${e.summary}` : e.summary;
    return `- [${when}] ${summary}${cat}${out}${rew}${inten}${faded}${id}`;
  });
  return (
    `RECENT ACTION MEMORY — the MC's own past actions. When the player references something that happened before (\"we sparred\", \"we already kissed\", \"I traded crypto before\", \"last time this was easy\"), CHECK THIS LOG: acknowledge it, compare the current action against it (intensity/outcome/partners/amounts), and let the comparison shape the scene. Economic actions (trades, purchases, gambling) are remembered here too — never claim a trade or purchase is happening \"for the first time\" when the log shows it already happened. NEVER dismiss the player's references as speculation or claim you don't remember — the evidence is right here. Entries marked \"fading memory\", \"hazy memory\", or \"faint memory\" have faded with in-game time — recall their gist and treat their details as approximate rather than reciting them as exact, but still acknowledge the event happened. When you build on a specific past action, cite it with [MEMORY_REF] using its id from this block (see OUTPUT FORMAT SPEC #20) instead of paraphrasing.\n` +
    lines.join("\n")
  );
}

/**
 * How many turns back a reaction of a given intensity still lingers. The
 * carry-over window scales with the reaction's strength: a critical-success
 * warmth (high intensity) colors the NPC for a full day's worth of turns,
 * while a faint reaction fades by the next turn. Older reactions are past
 * history the RECENT ACTION MEMORY block already covers.
 */
export function reactionRecencyWindow(intensity: number | undefined): number {
  const i = typeof intensity === "number" ? intensity : 0;
  if (i >= 85) return 12; // critical-success warmth — lingers a full day
  if (i >= 65) return 5; // strong reaction — lingers the session
  if (i >= 40) return 2; // ordinary warm/cold — the default couple of turns
  return 1; // faint — fades by the next turn
}

/** Whether an action-memory entry is an NPC reaction (witness or prose). */
function isReactionEntry(e: {
  category?: string;
  npc?: string;
  outcome?: string;
  summary?: string;
}): boolean {
  if (!e || e.category !== "social" || !e.npc) return false;
  const out = e.outcome || "";
  const sum = e.summary || "";
  // Prose-scanner entries carry "warm reaction"/"cold reaction" outcomes;
  // witness-pipeline entries read "<NPC> reacted <label>" (e.g. "Nina
  // reacted warmly").
  return /warm reaction|cold reaction/i.test(out) || /^.{1,40} reacted /i.test(sum);
}

/** Sign of a reaction's emotional valence: 1 warm, -1 cold, 0 unknown. */
function reactionValence(e: {
  outcome?: string;
  summary?: string;
}): 1 | -1 | 0 {
  const out = e.outcome || "";
  if (/warm reaction/i.test(out)) return 1;
  if (/cold reaction/i.test(out)) return -1;
  // Witness-pipeline outcome: "Affection +10, Trust +5" — the sign of the
  // first delta carries the direction.
  const m = out.match(/(?:Affection|Trust)\s+([+-]?\d+)/);
  if (m) {
    const n = Number(m[1]);
    if (n > 0) return 1;
    if (n < 0) return -1;
  }
  // Fall back on the wording (prose reactions sometimes skip the outcome).
  const sum = e.summary || "";
  if (/warm(ly)?|generous|appreciation|pleased|smiled|soften|beams/i.test(sum)) return 1;
  if (/jealous|hostil|defen|suspicious|furious|glare|scowl|stiffen|cold/i.test(sum)) return -1;
  return 0;
}

// -----------------------------------------------------------------------------
// Gentle memory decay — entries older than a couple of in-game days fade to
// fuzzier recall instead of staying equally vivid forever. The stored entries
// are never mutated (the log stays the durable record); the decay is applied
// at READ time by the reminder so the AI sees "hazy memory" / "faint memory"
// entries as less certain — the gist survives, exact details are approximate.
// The recent-window blocks (RECENT REACTIONS, mood) are unaffected because
// their windows are already tight.
// -----------------------------------------------------------------------------

/** In-game days after which recall starts to fade. */
export const MEMORY_VIVID_DAYS = 1;
/** In-game days at which recall becomes faint. */
export const MEMORY_FAINT_DAYS = 8;

export interface MemoryDecay {
  /** Whole in-game days since the memory (0 = same/next day; negative clamped). */
  daysOld: number;
  /** 0 vivid · 1 fading · 2 hazy · 3 faint. */
  level: 0 | 1 | 2 | 3;
  /** Intensity penalty applied when presenting the memory. */
  intensityMod: number;
  /** Qualifier appended to the reminder line ("" when vivid). */
  label: string;
}

/**
 * How much an entry has faded given its time vs the current in-game clock.
 * Unparseable or future (year-wrap) times are treated as vivid (0) — never
 * invent decay where the calendar can't be read.
 */
export function getMemoryDecay(
  entryTime: string | undefined,
  nowTime: string | undefined,
): MemoryDecay {
  const then = parseWorldClock(entryTime || "");
  const now = parseWorldClock(nowTime || "");
  if (!then || !now) {
    return { daysOld: 0, level: 0, intensityMod: 0, label: "" };
  }
  const rawDays = Math.floor((now.minutes - then.minutes) / MINUTES_PER_DAY);
  const daysOld = rawDays < 0 ? 0 : rawDays;
  if (daysOld <= MEMORY_VIVID_DAYS) {
    return { daysOld, level: 0, intensityMod: 0, label: "" };
  }
  if (daysOld <= 3) {
    return { daysOld, level: 1, intensityMod: -15, label: "fading memory" };
  }
  if (daysOld < MEMORY_FAINT_DAYS) {
    return { daysOld, level: 2, intensityMod: -30, label: "hazy memory" };
  }
  return { daysOld, level: 3, intensityMod: -50, label: "faint memory" };
}

/**
 * RECENT REACTIONS — the emotional carry-over signal. An NPC who reacted
 * warmly (or coldly) within the last couple of turns does NOT reset to
 * neutral: the AI must narrate the lingering warmth or tension instead of
 * starting their mood fresh. Scans action memory for the newest reaction
 * entry per NPC (witness-pipeline and prose-scanner alike). Empty string when
 * nobody reacted recently.
 */
export function getReactionRecencyReminder(): string {
  const s = StateModule.state;
  const mem = s.actionMemory || [];
  if (mem.length === 0) return "";
  const currentTurn = s.turnCount;
  // Latest reaction entry per NPC within ITS OWN intensity-scaled window — a
  // faint reaction fades by the next turn, a critical one lingers a full day.
  const latest = new Map<
    string,
    { entry: ActionMemoryEntry; valence: 1 | -1 | 0 }
  >();
  for (const e of mem) {
    if (!isReactionEntry(e)) continue;
    const turn = typeof e.turn === "number" ? e.turn : 0;
    const cutoff = currentTurn - reactionRecencyWindow(e.intensity);
    if (turn < cutoff) continue;
    const key = (e.npc || "").toLowerCase();
    const existing = latest.get(key);
    if (!existing || turn > existing.entry.turn) {
      latest.set(key, { entry: e, valence: reactionValence(e) });
    }
  }
  if (latest.size === 0) return "";
  const lines: string[] = [];
  for (const { entry: e, valence } of latest.values()) {
    if (valence === 0) continue;
    const when =
      e.turn === currentTurn - 1 ? "LAST TURN" : `RECENTLY (turn ${e.turn})`;
    if (valence > 0) {
      lines.push(
        `- ${e.npc} reacted warmly ${when}: they do NOT reset to neutral — narrate the lingering warmth (a softer tone, the memory of the gesture) coloring their behavior this turn.`,
      );
    } else {
      lines.push(
        `- ${e.npc} reacted coldly ${when}: the tension does NOT evaporate — narrate continued wariness or resentment, not a clean slate.`,
      );
    }
  }
  if (lines.length === 0) return "";
  return (
    `RECENT REACTIONS — NPCs whose emotional reaction is still fresh do not reset to neutral; the stronger the reaction, the longer it lingers (a critical warmth colors them for a full day, a faint one fades by the next turn). Carry the mood forward: warmth lingers, tension lingers. Write it into the fiction this turn.\n` +
    lines.join("\n")
  );
}

/**
 * Parse explicit [MEMORY_REF] citations — the AI pins a past action by its
 * stable id (shown in the RECENT ACTION MEMORY block) so the engine can
 * verify the reference and the player can see what is being built on.
 * Accepts a bare id or JSON: [MEMORY_REF]am_1a2b3c[/MEMORY_REF] or
 * [MEMORY_REF]{"id":"am_1a2b3c"}[/MEMORY_REF].
 */
export function parseMemoryRefs(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /\[MEMORY_REF\](.*?)\[\/MEMORY_REF\]/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] || "").trim();
    if (!raw) continue;
    if (raw.startsWith("{")) {
      try {
        const data = JSON.parse(unwrapJsonBlock(raw));
        if (data && typeof data.id === "string" && data.id.trim()) {
          out.push(data.id.trim());
          continue;
        }
      } catch {
        /* malformed JSON — fall through to the bare form */
      }
    }
    out.push(raw.replace(/^["'`]+|["'`]+$/g, ""));
  }
  // Lenient recovery: local models routinely forget the [/MEMORY_REF] closing
  // tag ("[MEMORY_REF]am_1a2b3c, which we completed before"). A bare id right
  // after the opening tag still counts, up to the next punctuation/space — the
  // engine verifies it against the log anyway, so a false positive is just a
  // warning, never a hallucinated grounding.
  const lenient = /\[MEMORY_REF\](\{"[^"]*"\s*:[^\]]*?\}|[A-Za-z0-9_\-]+)/g;
  let l: RegExpExecArray | null;
  while ((l = lenient.exec(text)) !== null) {
    const raw = l[1] ? l[1].trim() : "";
    if (!raw) continue;
    if (raw.startsWith("{")) {
      try {
        const data = JSON.parse(raw);
        if (data && typeof data.id === "string" && data.id.trim()) {
          const id = data.id.trim();
          if (!out.includes(id)) out.push(id);
          continue;
        }
      } catch {
        /* ignore */
      }
    }
    const id = raw.replace(/^["'`]+|["'`]+$/g, "");
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Resolve a [MEMORY_REF] id against the action memory log. Returns the entry
 * when it exists, otherwise undefined (the caller emits a gentle notice so a
 * dangling citation never silently passes as if it were grounded). Matches
 * the stable id exactly, or the summary when the model copied text instead
 * of the id.
 */
export function resolveMemoryRef(ref: string | undefined): ActionMemoryEntry | undefined {
  if (!ref) return undefined;
  const mem = StateModule.state.actionMemory || [];
  const id = ref.trim();
  const byId = mem.find((e) => e.id === id);
  if (byId) return byId;
  const bySummary = mem.find((e) => e.summary && e.summary.toLowerCase() === id.toLowerCase());
  if (bySummary) return bySummary;
  return undefined;
}

/**
 * Snapshot the economy-relevant state BEFORE a turn's tags are extracted so
 * the engine can diff [STATE_UPDATE]-driven movement afterward. Captures the
 * system-points balance, the inventory (as a name -> qty map), and the
 * currency balances (USD, gold, copper, …) — the places a trade or purchase
 * can move without any trade verb.
 */
export function snapshotEconomyState(): {
  systemPoints: number;
  inventory: Record<string, number>;
  currencies: Record<string, number>;
} {
  const s = StateModule.state;
  const inv: Record<string, number> = {};
  for (const item of s.char?.inventory || []) {
    const qty = typeof item.qty === "number" ? item.qty : 1;
    inv[item.name] = (inv[item.name] || 0) + qty;
  }
  const currencies: Record<string, number> = {};
  for (const c of s.currencies || []) {
    if (!c || !c.name) continue;
    // The "systemPoints" pseudo-currency is the game's own accounting mirror
    // of char.systemPoints — it must NOT be diffed as a currency, or a single
    // balance move would double-report as BOTH "Spent 200 system points"
    // (systemPointsDelta) AND "Spent 200 systemPoints" (currencyDeltas). The
    // real system-points movement is tracked separately.
    if (PSEUDO_CURRENCIES.has(c.name.toLowerCase())) continue;
    currencies[c.name] = typeof c.amount === "number" ? c.amount : 0;
  }
  return {
    systemPoints: typeof s.char?.systemPoints === "number" ? s.char.systemPoints : 0,
    inventory: inv,
    currencies,
  };
}

/**
 * Diff a pre-turn economy snapshot against the CURRENT state and produce the
 * stateDelta the harvest consumes. Gained/lost items are name-only (qty
 * changes on an existing item are movement but not a new acquisition);
 * currency movement is per-name net deltas.
 */
export function computeEconomyDelta(
  before: {
    systemPoints: number;
    inventory: Record<string, number>;
    currencies: Record<string, number>;
  },
): {
  systemPointsDelta?: number;
  gainedItems?: string[];
  lostItems?: string[];
  currencyDeltas?: Array<{ name: string; delta: number }>;
} {
  const after = snapshotEconomyState();
  const delta: {
    systemPointsDelta?: number;
    gainedItems?: string[];
    lostItems?: string[];
    currencyDeltas?: Array<{ name: string; delta: number }>;
  } = {};
  const spDiff = after.systemPoints - before.systemPoints;
  if (spDiff !== 0) delta.systemPointsDelta = spDiff;
  const gained = Object.keys(after.inventory).filter((name) => !(name in before.inventory));
  const lost = Object.keys(before.inventory).filter((name) => !(name in after.inventory));
  if (gained.length > 0) delta.gainedItems = gained;
  if (lost.length > 0) delta.lostItems = lost;
  const currencyNames = new Set([
    ...Object.keys(before.currencies),
    ...Object.keys(after.currencies),
  ]);
  const currencyDeltas: Array<{ name: string; delta: number }> = [];
  for (const name of currencyNames) {
    const beforeAmt = before.currencies[name] || 0;
    const afterAmt = after.currencies[name] || 0;
    if (afterAmt !== beforeAmt) currencyDeltas.push({ name, delta: afterAmt - beforeAmt });
  }
  if (currencyDeltas.length > 0) delta.currencyDeltas = currencyDeltas;
  return delta;
}

/** Build the memory summary for a transaction log entry. */
function transactionSummary(t: {
  type?: string;
  itemName?: string;
  partner?: string;
}): string | undefined {
  if (!t || !t.itemName) return undefined;
  const verb =
    t.type === "sell" ? "Sold" : t.type === "reward" ? "Rewarded with" : t.type === "fine" ? "Paid" : "Bought";
  return `${verb} ${t.itemName}${t.partner ? ` from ${t.partner}` : ""}`;
}

/** Push one transaction entry into memory (used by step 7). */
function pushTransactionEntry(
  t: {
    type?: string;
    itemName?: string;
    amount?: number;
    currency?: string;
    partner?: string;
  },
  time: string,
  turn: number,
): void {
  const summary = transactionSummary(t);
  if (!summary) return;
  const price = t.amount != null ? `${t.amount} ${t.currency || ""}`.trim() : undefined;
  pushEntry({
    summary,
    category: "economy",
    intensity: t.type === "reward" ? 35 : t.type === "sell" ? 55 : 40,
    outcome: price ? `for ${price}` : undefined,
    time,
    turn,
  });
}

/**
 * Ensure every transaction the engine has recorded exists in action memory.
 * Scans the whole log and pushes entries for any not yet remembered (matched
 * by summary). Safe to call repeatedly — already-present entries are skipped.
 */
export function reconcileTransactionLog(
  time?: string,
  turn?: number,
): number {
  const s = StateModule.state;
  const log = s.transactionLog || [];
  if (log.length === 0) return 0;
  const existing = new Set(
    (s.actionMemory || []).map((e) => (e.summary || "").toLowerCase()),
  );
  let added = 0;
  for (const t of log) {
    const summary = transactionSummary(t);
    if (!summary) continue;
    const key = summary.toLowerCase();
    if (existing.has(key)) continue;
    existing.add(key);
    pushTransactionEntry(t, time ?? s.worldState.time, turn ?? s.turnCount);
    added++;
  }
  return added;
}

/**
 * FIRST-TIME CLAIM GUARD — a mechanical counterweight to the prompt rule.
 *
 * The RECENT ACTION MEMORY block tells the AI never to claim an economic
 * action is happening "for the first time" when the log shows it already
 * happened — but a live 48B run accepted the player's false "I've never
 * traded before" framing anyway, ignoring both the rule and the evidence
 * (verified in the Preview tab against the real model). This guard catches
 * the contradiction mechanically: when the PLAYER's action text claims a
 * first-time / never-done action and the memory log holds entries of that
 * same kind, it returns a hard correction line injected into the payload so
 * the model cannot miss it — even when it skims the memory block. Returns ""
 * when the claim is genuine (no matching log entries) or names no specific
 * action, so a true first time is never blocked.
 */
export function getFirstTimeGuard(userText: string): string {
  if (!userText) return "";
  const s = StateModule.state;
  const log = s.actionMemory || [];
  if (log.length === 0) return "";

  // The sentence that carries the claim — "first time", "for the first
  // time", "never …", "haven't …". A bare "never" alone ("I never go to
  // the library") is not enough; the claimed action verb below must match.
  const lower = userText.toLowerCase();
  const claim = lower.match(
    /[^.!?\n]*(?:\bfirst time\b|\bfor the first time\b|\bnever\b|\bhaven'?t\b|\bhave not\b|\bdidn'?t\b|\bdid not\b)[^.!?\n]*[.!?]?/,
  );
  if (!claim) return "";
  const sentence = claim[0];

  // Which action kind is being claimed as new — matched against the log by
  // its summary wording (the economy milestones/transactions produce
  // summaries like "Traded crypto (847.50 USD)", "Bought Dried Herbs…",
  // "Gambled", "Spent 200 USD").
  const kinds: Array<{ re: RegExp; match: RegExp; label: string; neverPhrase: string }> = [
    { re: /\btrad/, match: /trad/i, label: "trade", neverPhrase: "traded" },
    { re: /\bbought|\bpurchas/, match: /bought|purchas/i, label: "purchase", neverPhrase: "purchased" },
    { re: /\bsold\b/, match: /\bsold\b/i, label: "sale", neverPhrase: "sold" },
    { re: /\bgambl|\bbet/, match: /gambl|\bbet/i, label: "gamble", neverPhrase: "gambled" },
    { re: /\binvest/, match: /invest/i, label: "investment", neverPhrase: "invested" },
    { re: /\bspent|\bearned/, match: /spent|earned/i, label: "spending", neverPhrase: "spent" },
  ];
  const hit = kinds.find((k) => k.re.test(sentence));
  if (!hit) return "";
  const evidence = log
    .filter((e) => e.category === "economy" && hit.match.test(e.summary || ""))
    .slice(0, 2)
    .map((e) => `"${e.summary}"${e.turn ? ` (turn ${e.turn})` : ""}`)
    .join("; ");
  if (!evidence) return "";

  return (
    `[SYSTEM CORRECTION — FIRST-TIME CLAIM CONTRADICTS ACTION MEMORY: The action text says this is happening for the first time, but the memory log records earlier ${hit.label}(s): ${evidence}. ` +
    `Treat this as a CONTINUATION of past activity, not a first time — acknowledge the earlier ${hit.label} and COMPARE the current one against it (amounts, outcome, partner, platform). ` +
    `Do NOT narrate the MC as a newcomer or first-timer, do NOT claim they have never ${hit.neverPhrase} before, and do NOT treat the player's "first time" framing as fact — the log is the ground truth.]`
  );
}

export const ActionMemoryModule = {
  harvest: harvestActionMemory,
  getReminder: getActionMemoryReminder,
  getReactionRecency: getReactionRecencyReminder,
  reactionWindow: reactionRecencyWindow,
  getDecay: getMemoryDecay,
  parseRefs: parseMemoryRefs,
  resolveRef: resolveMemoryRef,
  snapshotEconomy: snapshotEconomyState,
  computeDelta: computeEconomyDelta,
  reconcileTransactions: reconcileTransactionLog,
  firstTimeGuard: getFirstTimeGuard,
};
