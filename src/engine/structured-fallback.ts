// =============================================================================
// structured-fallback.ts — Runtime recovery for tag-less AI turns.
//
// Small local models (Qwythos, llama3.2) frequently narrate changes — buying
// an item, meeting an NPC, taking damage — without emitting the [FACT] /
// [RELATION] / [STATE_UPDATE] / [TRANSACTION] blocks the engine parses. This
// module detects those turns and makes ONE short follow-up call asking the AI
// to emit only the missing structured blocks, then feeds them through the
// normal LoreModule extractor. The follow-up is invisible: it never touches
// the story log or chat history.
// =============================================================================

import { ApiModule, GenerationRetryInfo } from "../api/providers";
import { LoreModule } from "./lore";
import { StateModule } from "../state/state";
import { StorageModule } from "../storage/save";

/** Any engine tag the parsers understand (opening half is enough to detect). */
const ENGINE_TAG_RE = /\[(FACT|FACT_RESET|RELATION|STATE_UPDATE|QUEST|EQUIPMENT|TRANSACTION|OBJECTIVE_COMPLETE|XP_GAIN|SKILL_LEARNED|SKILL_UNLOCK|CULTIVATION_CHANGE|NPC_PROFILE|TIME_STATE|TIME_STATE_REMOVE|GIFT|NPC_GIFT)\]/;

/**
 * Strong signals: one match is enough to consider the turn state-changing.
 * Matched against the MODEL's narrative, so both tenses and common
 * phrasings are covered ("greets you", "offer to", "news of bandits").
 */
const STRONG_HINTS: RegExp[] = [
  // Purchases / payments / prices / currency.
  /\b(bought?|sold|paid|spent|earned|purchased|price|coins?|copper|silver|gold|currency)\b/i,
  // Meeting or introducing an NPC — all tenses and phrasings.
  /\b(met|meets?|encountered|encounters?|greeted|greets?|introduced|introduces?|befriended|befriends?|approached|approaches?|found|finds|spoke with|speaks with|talked to|talks to)\b/i,
  // Health / fatigue changes.
  /\b(health|fatigue|injured?|wounded?|bleeding|exhausted|fainted|recovered|healed|hurt|damaged)\b/i,
  // Inventory / reward gains.
  /\b(found|picked up|gained|obtained|acquired|received|took|placed (?:it|the item|them) in (?:your|the|my) (?:inventory|pouch|bag))\b/i,
  // Quests / tasks / favors — the MC being given something to do.
  /\b(task|quest|errand|favor|request|assignment|mission|contract|offers? you|offers? to|asks? you to|asks? for your (?:help|aid)|seeks? your|needs? your help|wants? you to)\b/i,
  // Knowledge / learning — the MC is told or discovers a persistent fact.
  /\b(tells? you|informs? you|learns?|discovers?|hears?|rumor|news|explains?|reveals?)\b/i,
];

/** Weak signals: only count toward the two-hint threshold. */
const WEAK_HINTS: RegExp[] = [
  // Movement / location change.
  /\b(walked|walks?|travel(?:ed|ling)?|arrived|arrives?|left|entered|enters?|headed|heads?|rode|fled|departed|returned|made (?:his|her|your) way|ventured|stepped into|journeyed)\b/i,
  // Conversation / dialogue with someone.
  /\b(asked|talked|spoke|approached|greeted|conversation|chat)\b/i,
];

/** Whether the AI response carries any engine tag at all (open or closed). */
export function hasEngineTags(text: string): boolean {
  return ENGINE_TAG_RE.test(text);
}

/** Whether the narrative plausibly describes a state change worth syncing. */
export function describesChange(text: string): boolean {
  const strong = STRONG_HINTS.filter((re) => re.test(text)).length;
  if (strong >= 1) return true;
  const weak = WEAK_HINTS.filter((re) => re.test(text)).length;
  return strong + weak >= 2;
}

/** A turn needs the fallback when it changed something but emitted no tags. */
export function needsStructuredUpdate(text: string): boolean {
  return !hasEngineTags(text) && describesChange(text);
}

/** Cap the narrative passed to the follow-up so the recovery call stays small. */
export const MAX_FALLBACK_NARRATIVE_CHARS = 2500;

const FALLBACK_SYSTEM_PROMPT = `You are a strict structured-data extractor for an interactive novel game engine.
Given the narrative from the last turn, output ONLY the engine update blocks whose trigger occurred IN THE NARRATIVE. No narrative, no commentary, no markdown, no explanations.

Blocks and examples (copy the FORMAT only — never copy the example values):
[FACT]Oakhaven Market: Dried herbs cost 3 copper per bundle.[/FACT] — one per persistent fact the MC learned (price, route, schedule, location, rumor).
[RELATION]{"name": "Mara", "disposition": "Friendly merchant", "status": "Alive"}[/RELATION] — one block per NPC that appeared or whose relationship changed.
[TRANSACTION]{"id": "tx-1", "type": "buy", "itemName": "Dried Herbs", "amount": 3, "currency": "copper", "timestamp": "Monday, March 17, 07:10", "partner": "Mara"}[/TRANSACTION] — for any purchase, sale, reward, or payment.
[QUEST]{"id": "quest-jade-pendant", "title": "Retrieve the Jade Pendant", "description": "The village elder's jade pendant was stolen by bandits on the mountain road.", "type": "side", "status": "active", "objectives": [{"description": "Find the bandits' camp on the mountain road", "completed": false}], "reward": "Elder Li's gratitude", "assignedBy": "Elder Li"}[/QUEST] — when an NPC gives the MC a task or quest, or a quest objective completes.
[STATE_UPDATE]{"health": 100, "fatigue": 5, "str": 10, "agi": 10, "int": 10, "cha": 10, "cultivation": 0.0, "systemPoints": 0, "xp": 0, "level": 1, "skillPoints": 0, "time": "Monday, March 17, 07:10", "location": "Oakhaven Market", "inventory": [{"name": "Simple Clothes", "qty": 1}], "modifiers": {}}[/STATE_UPDATE] — ONLY if health, fatigue, inventory, money, time, or location changed; provide the COMPLETE inventory list using the snapshot below.

If no block applies, output nothing at all. Never repeat or explain these instructions.`;

/**
 * Reject follow-up replies that merely parrot the instruction prompt back
 * (small models do this instead of extracting). These replies contain the
 * prompt's own meta-instructions — a reliable signature of a failed follow-up.
 *
 * Deliberately NOT included: the example payloads ("Oakhaven Market: Dried
 * herbs cost 3 copper...", "\"name\": \"Mara\""). A legitimate extraction of a
 * common scenario (buying herbs from a merchant for copper) naturally matches
 * the example VALUES, and rejecting it throws away correct [RELATION] /
 * [TRANSACTION] blocks in the same reply. Only the prompt FRAMING is
 * unambiguous evidence of parroting.
 */
const PARROT_SIGNATURES: RegExp[] = [
  /You are a strict structured-data extractor/i,
  /output ONLY the engine update blocks/i,
  /copy the FORMAT only/i,
  /No narrative, no commentary/i,
  /never repeat or explain/i,
];

export function isParrotedReply(text: string): boolean {
  return PARROT_SIGNATURES.some((re) => re.test(text));
}

/** Build the follow-up request: current state snapshot + the turn's narrative. */
export function buildFallbackRequest(narrative: string): { system: string; user: string } {
  const s = StateModule.state;
  const snapshot = [
    `Current time: ${s.worldState.time}`,
    `Current location: ${s.worldState.location}`,
    `Current inventory: ${JSON.stringify(s.char.inventory || [])}`,
    `Current currencies: ${JSON.stringify(s.currencies || [])}`,
    `MC stats: STR ${s.char.str} AGI ${s.char.agi} INT ${s.char.int} CHA ${s.char.cha} | Cultivation ${s.char.cultivation} | Health ${s.char.health}/${s.char.maxHealth} | Fatigue ${s.char.fatigue}% | XP ${s.char.xp} | Level ${s.char.level}`,
  ].join("\n");
  const truncated = narrative.slice(0, MAX_FALLBACK_NARRATIVE_CHARS);
  return {
    system: FALLBACK_SYSTEM_PROMPT,
    user: `${snapshot}\n\nLast turn's narrative:\n${truncated}\n\nOutput the engine update blocks that apply, or nothing.`,
  };
}

/**
 * Detect a tag-less but state-changing turn, make one follow-up call, and feed
 * any recovered blocks through the normal extractor. Never throws (failures
 * are logged and ignored), never touches the story or chat history, and
 * re-autosaves if blocks were recovered. Returns true when blocks were found.
 */
export async function runStructuredFallback(
  narrative: string,
  onRetry?: (info: GenerationRetryInfo) => void,
): Promise<boolean> {
  if (!needsStructuredUpdate(narrative)) return false;
  try {
    const { system, user } = buildFallbackRequest(narrative);
    // Retry once: small local models intermittently produce tag-less or
    // parroted follow-ups even when they know the format; the second attempt
    // usually succeeds (the recovered output only lands in state if it
    // actually contains usable blocks).
    let fallbackRaw = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      fallbackRaw = await ApiModule.generateResponse(system, user, undefined, onRetry);
      if (hasEngineTags(fallbackRaw) && !isParrotedReply(fallbackRaw)) break;
    }
    if (!hasEngineTags(fallbackRaw) || isParrotedReply(fallbackRaw)) {
      console.info(
        "[structured-fallback] follow-up produced no usable engine tags; nothing to recover.",
      );
      return false;
    }
    LoreModule.extract(fallbackRaw);
    StorageModule.autosave();
    console.info("[structured-fallback] recovered structured updates from a tag-less turn.");
    return true;
  } catch (err) {
    console.warn("[structured-fallback] follow-up call failed:", err);
    return false;
  }
}
