// =============================================================================
// lore.ts - Phase 1 hardened parser + Phase 3 quest/equipment/economy integration.
// Phase 4: XP gain, skill unlocks, and cultivation breakthrough parsing.
// =============================================================================

import { Relation, RelationModifier } from "../state/GameState";
import {
  StateUpdateSchema,
  RelationUpdateSchema,
  RelationUpdate,
  safeParseJson,
} from "../state/schema";
import { StateModule } from "../state/state";
import { getSeasonFromTime, normalizeSeasonWord } from "./seasons";
import { UIManager } from "../ui/UIManager";
import { unwrapJsonBlock, repairConcatenatedArrays, safeParseJsonBlock } from "./tag-utils";
import { normalizeFamilyReferences } from "./family-names";
export { repairConcatenatedArrays };
import { QuestModule } from "./quest";
import { EquipmentModule } from "./equipment";
import { EconomyModule } from "./economy";
import { XpModule } from "./xp";
import { SkillModule } from "./skill";
import { CultivationModule } from "./cultivation";
import { NPCProfileModule } from "./npc-profile";
import { TimeStateModule } from "./time-states";
import { GiftModule } from "./gifts";

export interface ParseIssue {
  kind:
    | "STATE_UPDATE"
    | "RELATION"
    | "QUEST"
    | "EQUIPMENT"
    | "TRANSACTION"
    | "SCENE"
    | "SEASON_SHIFT"
    | "CHECK";
  error: string;
}

/** Engine tags the AI is asked to emit (opening + closing pair). */
const PARSE_TAGS = [
  "FACT",
  "FACT_RESET",
  "RELATION",
  "STATE_UPDATE",
  "QUEST",
  "EQUIPMENT",
  "TRANSACTION",
  "OBJECTIVE_COMPLETE",
  "XP_GAIN",
  "SKILL_LEARNED",
  "SKILL_UNLOCK",
  "CULTIVATION_CHANGE",
  "NPC_PROFILE",
  "TIME_STATE",
  "TIME_STATE_REMOVE",
  "GIFT",
  "NPC_GIFT",
  "SCENE",
  "SEASON_SHIFT",
  "CHECK",
];

/** Any engine tag-like marker: [TAG] or [/TAG] (uppercase names only). */
const TAG_MARKER_RE = /\[[A-Z][A-Z_]*\]|\[\/[A-Z][A-Z_]*\]/g;

/**
 * Matches model reasoning blocks: `<think>...</think>`, `<thinking>...</thinking>`,
 * `<reasoning>...</reasoning>` (case-insensitive). Reasoning models (Qwen3,
 * DeepSeek R1, ...) emit long internal monologues in these blocks, frequently
 * including malformed [STATE_UPDATE] drafts and planning text.
 */
const THINK_BLOCK_RE = /<(think|thinking|reasoning)>[\s\S]*?<\/(?:think|thinking|reasoning)>/gi;

/** Stray closing tags (a `</think>` with no opener) are pure model noise. */
const THINK_STRAY_CLOSER_RE = /<\/(?:think|thinking|reasoning)>/gi;

/**
 * Remove model reasoning blocks from an AI response so internal monologue
 * never reaches the tag parsers, the chat log, or the stored history. Only
 * well-formed CLOSED blocks are removed — an unclosed `<think>` is left
 * untouched, so a model that forgets the closer doesn't lose its actual
 * narrative (which would otherwise be swallowed to end-of-text). Stray
 * CLOSERS (a `</think>` with no opener) carry no narrative, so they are
 * always dropped.
 */
export function stripThinkBlocks(text: string): string {
  if (!text) return text;
  return text.replace(THINK_BLOCK_RE, "").replace(THINK_STRAY_CLOSER_RE, "");
}

/**
 * Some models (e.g. Qwythos) open tags like [FACT] or [RELATION] but forget
 * the matching [/FACT] closing half. Every parser here requires both halves,
 * so an unclosed tag would leak into the story AND silently drop its state
 * update. This inserts the missing closing tag at the next tag boundary (or
 * end of text) so every opening is balanced before parsing. Properly closed
 * blocks are left untouched.
 */
export function normalizeTags(text: string): string {
  let out = text;
  for (const name of PARSE_TAGS) {
    // Qwythos sometimes writes a closer with a stray slash — `}/[STATE_UPDATE]`
    // — instead of `}[/STATE_UPDATE]` (the `}` is the JSON's own closing
    // brace). Rewrite it so the block is properly closed and its payload
    // survives instead of being skipped as invalid JSON.
    out = out.replace(new RegExp(`\\}/\\[${name}\\]`, "g"), `}[/${name}]`);

    const openRe = new RegExp(`\\[${name}\\]`, "g");
    const closeRe = new RegExp(`\\[/${name}\\]`, "g");
    // Compute against a snapshot so earlier insertions don't shift indices.
    const snapshot = out;
    const closePos: number[] = [];
    let m: RegExpExecArray | null;
    closeRe.lastIndex = 0;
    while ((m = closeRe.exec(snapshot)) !== null) closePos.push(m.index);
    const openPos: number[] = [];
    openRe.lastIndex = 0;
    while ((m = openRe.exec(snapshot)) !== null) openPos.push(m.index);

    // Walk openings backwards; each pairs with the closest later closing tag,
    // or gets auto-closed at the next tag marker / end of text.
    const insertions: number[] = [];
    for (let k = openPos.length - 1; k >= 0; k--) {
      const open = openPos[k];
      const pairIdx = closePos.findIndex((c) => c > open);
      if (pairIdx >= 0) {
        closePos.splice(pairIdx, 1); // consumed by this opening
        continue;
      }
      const rest = snapshot.slice(open + name.length + 2);
      TAG_MARKER_RE.lastIndex = 0;
      const next = TAG_MARKER_RE.exec(rest);
      insertions.push(next ? open + name.length + 2 + next.index : snapshot.length);
    }
    // Apply from the end so earlier positions stay valid.
    insertions.sort((a, b) => b - a);
    for (const pos of insertions) {
      out = out.slice(0, pos) + `[/${name}]` + out.slice(pos);
    }
  }
  return out;
}

/**
 * True when `needle` appears inside `haystack` as a whole word — an exact
 * match, or a substring not glued to letters on either side ("Elder Wu"
 * contains "Wu"; "Marabel" does NOT contain "Mara" as a word).
 *
 * This is the guard on the relation fuzzy matcher: legitimate substring
 * references and aliases ("Elder Wu" -> "Wu", "Mara" -> "Oakhaven
 * Herbalist") still merge onto the existing relation, while distinct NPCs
 * whose names merely share a prefix ("Mara" vs "Marabel", "Kael" vs
 * "Kaelen") stay separate records instead of collapsing into one.
 */
function isWordContained(haystack: string, needle: string): boolean {
  if (haystack === needle) return true;
  const idx = haystack.indexOf(needle);
  if (idx === -1) return false;
  const before = idx > 0 ? haystack[idx - 1] : "";
  const after = idx + needle.length < haystack.length ? haystack[idx + needle.length] : "";
  return !/[a-z]/i.test(before) && !/[a-z]/i.test(after);
}

/** Chat message shape stored in engine history. */
export interface HistoryMessage {
  role: string;
  content: string;
}

/**
 * Clean leaked engine tags out of stored history entries. Turns saved before
 * unclosed-tag normalization existed may hold raw fragments like a dangling
 * `[FACT]...` with no closing half — which would leak into the story feed and
 * the model context on resume. Each assistant message is normalized (unclosed
 * tags auto-closed) then stripped of every engine block. Properly closed tags
 * are stripped too, so display and model context never see tag machinery.
 * Returns the number of messages that were modified.
 */
export function cleanHistoryTags(history: HistoryMessage[]): number {
  let cleaned = 0;
  for (const msg of history) {
    if (!msg || msg.role !== "assistant" || typeof msg.content !== "string") continue;
    const clean = LoreModule.stripTags(normalizeTags(stripThinkBlocks(msg.content))).trim();
    if (clean !== msg.content) {
      msg.content = clean;
      cleaned++;
    }
  }
  return cleaned;
}

export const LoreModule = {
  lastIssues: [] as ParseIssue[],

  extract(aiText: string): string {
    // Remove model reasoning blocks BEFORE tag balancing/parsing so think-
    // block drafts (malformed [STATE_UPDATE] attempts, planning text) never
    // reach the parsers or produce issues.
    aiText = stripThinkBlocks(aiText);
    // Balance unclosed engine tags before any parsing/stripping runs.
    aiText = normalizeTags(aiText);

    let newFactsFound = false;
    let uiNeedsUpdate = false;
    const issues: ParseIssue[] = [];

    const s = StateModule.state;
    s.memory = s.memory || { facts: [], relations: [] };
    s.memory.facts = s.memory.facts || [];
    s.memory.relations = s.memory.relations || [];
    s.char.inventory = s.char.inventory || [];
    s.modifiers = s.modifiers || {};

    // 1. STATE_UPDATE
    const stateRegex = /\[STATE_UPDATE\](.*?)\[\/STATE_UPDATE\]/gs;
    let stateMatch: RegExpExecArray | null;
    while ((stateMatch = stateRegex.exec(aiText)) !== null) {
      const parsed = safeParseJsonBlock(StateUpdateSchema, stateMatch[1]);
      if (!parsed.ok || !parsed.data) {
        const err = parsed.error ?? "unknown error";
        console.error("Skipped invalid STATE_UPDATE:", err, stateMatch[1]);
        issues.push({ kind: "STATE_UPDATE", error: err });
        continue;
      }
      const data = parsed.data;
      const char = s.char;
      if (data.health !== undefined)
        char.health = Math.max(0, Math.min(char.maxHealth, data.health));
      if (data.fatigue !== undefined) char.fatigue = Math.max(0, Math.min(100, data.fatigue));
      if (data.str !== undefined) char.str = data.str;
      if (data.agi !== undefined) char.agi = data.agi;
      if (data.int !== undefined) char.int = data.int;
      if (data.cha !== undefined) char.cha = data.cha;
      if (data.cultivation !== undefined) char.cultivation = data.cultivation;
      if (data.systemPoints !== undefined) char.systemPoints = Math.max(0, data.systemPoints);
      if (data.xp !== undefined) char.xp = Math.max(0, data.xp);
      if (data.level !== undefined) char.level = Math.max(1, data.level);
      if (data.skillPoints !== undefined) char.skillPoints = Math.max(0, data.skillPoints);
      if (data.inventory !== undefined) {
        // A merged concatenated array may repeat an item verbatim; drop
        // exact duplicates so the inventory stays clean.
        const seen = new Set<string>();
        char.inventory = data.inventory.filter((item) => {
          const key = JSON.stringify(item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      if (data.modifiers !== undefined) s.modifiers = data.modifiers;
      if (data.time !== undefined) s.worldState.time = data.time;
      if (data.location !== undefined) s.worldState.location = data.location;
      if (data.currencies !== undefined && Array.isArray(data.currencies)) {
        // Merge by name: amounts are replaced, any extra props on existing
        // entries (conversion rates, notes) survive the update.
        const merged = (s.currencies || []).map((c) => ({ ...c }));
        for (const c of data.currencies) {
          if (!c || typeof c.name !== "string" || !c.name) continue;
          const idx = merged.findIndex((m) => m.name === c.name);
          if (idx >= 0) merged[idx].amount = c.amount;
          else merged.push({ name: c.name, amount: c.amount, props: {} });
        }
        s.currencies = merged;
      }
      StateModule.recalculateSubskills();
      uiNeedsUpdate = true;

      // Phase 4: Enforce stat cap — if cultivation is 0, stats cannot exceed MAX_HUMAN_STAT
      const constants = StateModule.state.statConstants;
      if (constants && char.cultivation <= 0) {
        char.str = Math.min(char.str, constants.MAX_HUMAN_STAT);
        char.agi = Math.min(char.agi, constants.MAX_HUMAN_STAT);
        char.int = Math.min(char.int, constants.MAX_HUMAN_STAT);
        char.cha = Math.min(char.cha, constants.MAX_HUMAN_STAT);
      }
    }

    // 1a. SEASON_SHIFT: the story deliberately changes the season (time skip,
    // cursed realm, eternal winter) — records it as canon so [SCENE] seasons
    // stop being flagged against the calendar.
    const shiftRegex = /\[SEASON_SHIFT\](.*?)\[\/SEASON_SHIFT\]/gs;
    let shiftMatch: RegExpExecArray | null;
    while ((shiftMatch = shiftRegex.exec(aiText)) !== null) {
      try {
        const data = JSON.parse(shiftMatch[1]);
        if (data && typeof data.season === "string" && data.season.trim()) {
          const canon = normalizeSeasonWord(data.season) ?? data.season.trim();
          s.seasonOverride = canon;
          uiNeedsUpdate = true;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Skipped invalid SEASON_SHIFT:", msg, shiftMatch[1]);
        issues.push({ kind: "SEASON_SHIFT", error: msg });
      }
    }

    // 1b. SCENE (Descriptive Scenes module): remember a location's
    // environmental description so it can be re-fed when the MC returns.
    const sceneRegex = /\[SCENE\](.*?)\[\/SCENE\]/gs;
    let sceneMatch: RegExpExecArray | null;
    while ((sceneMatch = sceneRegex.exec(aiText)) !== null) {
      try {
        const data = JSON.parse(sceneMatch[1]);
        if (
          data &&
          typeof data.location === "string" &&
          typeof data.description === "string"
        ) {
          s.sceneLog = s.sceneLog || {};
          const key = data.location.trim().toLowerCase();
          const desc = data.description.trim();
          if (key && desc) {
            // Season validation: the canonical season (a story-driven
            // [SEASON_SHIFT] override, else the calendar) is authoritative. If
            // the AI's recorded season contradicts it, correct the stored
            // value and surface a gentle note — never silently overwrite a
            // mismatch (or store a wrong season).
            let season =
              typeof data.season === "string" ? data.season.trim() : undefined;
            let seasonNote: string | undefined;
            const authority = s.seasonOverride || getSeasonFromTime(s.worldState.time);
            if (season && authority) {
              const canonical = normalizeSeasonWord(season);
              if (canonical && canonical !== authority) {
                seasonNote = s.seasonOverride
                  ? `Scene recorded "${season}" but the established season is ${authority} — using ${authority}.`
                  : `Scene recorded "${season}" but the calendar says ${authority} — using ${authority}.`;
                season = authority;
              }
            }

            // Optional ambient conditions ride along so weather/lighting/season
            // stay consistent when the MC returns to the location.
            s.sceneLog[key] = {
              description: desc,
              weather: typeof data.weather === "string" ? data.weather.trim() : undefined,
              lighting: typeof data.lighting === "string" ? data.lighting.trim() : undefined,
              season,
              seasonNote,
            };
            uiNeedsUpdate = true;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Skipped invalid SCENE:", msg, sceneMatch[1]);
        issues.push({ kind: "SCENE", error: msg });
      }
    }

    if (s.toggles.memory) {
      // 2. FACT_RESET
      const resetRegex = /\[FACT_RESET\](.*?)\[\/FACT_RESET\]/gs;
      let resetMatch: RegExpExecArray | null;
      while ((resetMatch = resetRegex.exec(aiText)) !== null) {
        const bundleTitle = resetMatch[1].trim();
        if (bundleTitle) {
          const idx = s.memory.facts.findIndex(
            function(b: { title: string }) { return b.title.toLowerCase() === bundleTitle.toLowerCase(); },
          );
          if (idx > -1) {
            s.memory.facts.splice(idx, 1);
            newFactsFound = true;
          }
        }
      }

      // 2b. FACT bundles
      const factRegex = /\[FACT\](.*?)\[\/FACT\]/gs;
      let match: RegExpExecArray | null;
      while ((match = factRegex.exec(aiText)) !== null) {
        const rawFact = match[1].trim();
        if (!rawFact) continue;
        const parts = rawFact.split(":");
        let bundleTitle = "General World Facts";
        let entryText = rawFact;
        if (parts.length > 1) {
          bundleTitle = parts[0].trim();
          entryText = parts.slice(1).join(":").trim();
        }
        let bundle = s.memory.facts.find(
          function(b: { title: string }) { return b.title.toLowerCase() === bundleTitle.toLowerCase(); },
        );
        if (!bundle) {
          bundle = { title: bundleTitle, entries: [] };
          s.memory.facts.push(bundle);
        }
        // Resolve casual family mentions ("Mom came home late") to the
        // canonical relation name ("Diane") so the fact is durably linked
        // to the right person: relevance hits the canonical name, duplicate
        // phrasings collapse, and the Knowledge panel shows the real name.
        const linkedEntry = normalizeFamilyReferences(entryText, s.memory.relations);
        if (!bundle.entries.includes(linkedEntry)) {
          bundle.entries.push(linkedEntry);
          newFactsFound = true;
        }
      }

      // 3. RELATION
      const relRegex = /\[RELATION\](.*?)\[\/RELATION\]/gs;
      let relMatch: RegExpExecArray | null;
      while ((relMatch = relRegex.exec(aiText)) !== null) {
        const relRaw = relMatch[1].trim();
        if (!relRaw) continue;
        const unwrapped = unwrapJsonBlock(relRaw);
        const looksLikeJson = unwrapped.startsWith("{");
        let update: RelationUpdate | null = null;
        if (looksLikeJson) {
          const parsed = safeParseJson(RelationUpdateSchema, unwrapped);
          if (parsed.ok && parsed.data) {
            update = parsed.data;
          } else {
            const err = parsed.error ?? "unknown error";
            console.error("Skipped invalid RELATION JSON:", err, relRaw);
            issues.push({ kind: "RELATION", error: err });
            continue;
          }
        } else {
          update = LoreModule.parseLegacyRelation(relRaw);
        }
        if (update) {
          if (LoreModule.applyRelationUpdate(update)) uiNeedsUpdate = true;
          newFactsFound = true;
        }
      }
    }

    // Phase 3: Quest, Equipment, Economy parsers.
    QuestModule.extract(aiText);
    EquipmentModule.extract(aiText);
    EconomyModule.extract(aiText);

    // Phase 4: XP, Skill, Cultivation parsers.
    XpModule.extract(aiText);
    SkillModule.extract(aiText);
    CultivationModule.extract(aiText);

    // Phase 4: Check for automatic breakthroughs after cultivation changes.
    CultivationModule.checkBreakthroughs();

    // Phase 5: NPC profiles, time states, and gifts.
    // Each extractor reports whether it changed state so the sidebars
    // re-render even when the response carries no STATE_UPDATE tag.
    if (NPCProfileModule.extract(aiText)) uiNeedsUpdate = true;
    if (TimeStateModule.extract(aiText)) uiNeedsUpdate = true;
    if (GiftModule.extract(aiText)) uiNeedsUpdate = true;
    if (GiftModule.extractNPCEquipment(aiText)) uiNeedsUpdate = true;

    const cleanText = LoreModule.stripTags(aiText);
    LoreModule.lastIssues = issues;
    if (issues.length > 0) UIManager.showParseNotice(issues);
    if (newFactsFound) UIManager.renderMemoryPanel();
    if (uiNeedsUpdate) UIManager.renderAllSidebars();
    return cleanText;
  },

  /**
   * Apply a relation update to memory. Returns true when a new NPC profile
   * was auto-generated (caller should re-render the NPC sidebar).
   */
  applyRelationUpdate(update: RelationUpdate): boolean {
    const s = StateModule.state;
    const relations = s.memory.relations;
    const search = update.name.toLowerCase();
    // Phase 1 — fuzzy match with the whole-word guard: "Elder Wu" matches an
    // update naming "Wu", but "Marabel" never matches an update naming "Mara".
    // Matches the update's NAME against existing names AND aliases.
    let existing = relations.find(function(c: Relation) {
      const existingName = c.name.toLowerCase();
      if (isWordContained(existingName, search) || isWordContained(search, existingName)) {
        return true;
      }
      return (c.aliases || []).some(function(a: string) {
        const alias = a.toLowerCase();
        return isWordContained(alias, search) || isWordContained(search, alias);
      });
    });
    // Phase 2 — NAME DISCOVERY: the update calls the person by a NEW name
    // while listing the OLD name as an alias ("Diane" + aliases ["Mother"]
    // when the entry is still named "Mother"). Match via the update's own
    // aliases so the entry is RENAMED instead of duplicated, and any NPC
    // profile follows the rename (otherwise the profile would drop out of
    // the living-NPC view).
    let discoveredName = false;
    if (!existing && update.aliases && update.aliases.length > 0) {
      for (const alias of update.aliases) {
        const a = alias.toLowerCase();
        const hit = relations.find(function(c: Relation) {
          const cn = c.name.toLowerCase();
          return isWordContained(cn, a) || isWordContained(a, cn);
        });
        if (hit) {
          existing = hit;
          discoveredName = true;
          break;
        }
      }
    }
    const modifiers: RelationModifier[] | undefined = update.modifiers;
    if (existing) {
      if (update.disposition) existing.disposition = update.disposition;
      if (update.status) existing.status = update.status;
      const oldName = existing.name;
      const oldNameLower = oldName.toLowerCase();
      const nameCoversPrimary =
        isWordContained(oldNameLower, search) || isWordContained(search, oldNameLower);
      // ALIAS PROMOTION (the reverse of name discovery): the update's NAME
      // matched an existing ALIAS rather than the primary, and its own alias
      // list carries the current primary name — the AI is promoting the alias
      // to canonical (entry "Diane" with alias "Mother" + update
      // {name:"Mother", aliases:["Diane"]}). Rename entry AND its NPC profile,
      // keeping the old primary as an alias so nothing silently drops out.
      let promotedAlias = false;
      if (!nameCoversPrimary && update.aliases && update.aliases.length > 0) {
        promotedAlias = update.aliases.some(function(a: string) {
          const al = a.toLowerCase();
          return isWordContained(al, oldNameLower) || isWordContained(oldNameLower, al);
        });
      }
      if (discoveredName || promotedAlias) {
        // Only rename when the new name is genuinely new — if it's already
        // part of the entry's own name ("Elder Wu" + update "Wu"), the
        // more specific existing name wins and there's nothing to discover.
        if (!nameCoversPrimary) {
          if (!existing.aliases.includes(oldName)) existing.aliases.push(oldName);
          existing.name = update.name;
          const prof = s.npcProfiles.find(
            (p) => p.npcName.toLowerCase() === oldNameLower,
          );
          if (prof) prof.npcName = update.name;
        }
        // Union the update's aliases instead of replacing (the old name the
        // update matched on must survive as an alias).
        if (update.aliases) {
          for (const a of update.aliases) {
            if (!existing.aliases.some((x) => x.toLowerCase() === a.toLowerCase())) {
              existing.aliases.push(a);
            }
          }
        }
        // Drop any alias that duplicates the (new) primary name so the UI
        // never shows "Mother (aka Mother)".
        existing.aliases = existing.aliases.filter(
          (a) => a.toLowerCase() !== existing.name.toLowerCase(),
        );
      } else if (update.aliases) {
        existing.aliases = update.aliases;
      }
      if (modifiers && modifiers.length > 0) {
        existing.modifiers = existing.modifiers || [];
        modifiers.forEach(function(newMod: RelationModifier) {
          const idx = existing.modifiers.findIndex(
            function(m: RelationModifier) { return m.name.toLowerCase() === newMod.name.toLowerCase(); },
          );
          if (idx > -1) existing.modifiers[idx].duration = newMod.duration;
          else existing.modifiers.push(newMod);
        });
      }
      return false;
    }

    const rel: Relation = {
      name: update.name,
      aliases: update.aliases ?? [],
      disposition: update.disposition ?? "",
      status: update.status ?? "Alive",
      modifiers: modifiers ?? [],
    };
    relations.push(rel);

    // Phase 5: auto-generate a profile for newly met NPCs so the NPC panel
    // reflects them immediately instead of waiting for an explicit
    // [NPC_PROFILE] tag from the AI.
    if (s.toggles.npcDepth) {
      const hasProfile = s.npcProfiles.some(
        (p) => p.npcName.toLowerCase() === rel.name.toLowerCase(),
      );
      if (!hasProfile) {
        s.npcProfiles.push(
          NPCProfileModule.profileFromRelation(rel.name, rel.disposition, rel.aliases),
        );
        return true;
      }
    }
    return false;
  },

  parseLegacyRelation(relRaw: string): RelationUpdate | null {
    const parts = relRaw.split(":");
    const rawName = parts[0].trim();
    if (!rawName) return null;
    const rest = parts.slice(1).join(":").trim();
    const lower = rest.toLowerCase();
    const status: "Alive" | "Deceased" =
      /deceased|status: dead|status: deceased|\bdead\b|killed|slain/.test(lower)
        ? "Deceased"
        : "Alive";
    const modifiers: RelationModifier[] = [];
    const modMatch = rest.match(/modifiers:\s*(.*?)(?:\.|$)/i);
    if (modMatch) {
      modMatch[1].split(",").forEach(function(m) {
        const cleanMod = m.trim();
        if (!cleanMod) return;
        const durationMatch = cleanMod.match(/(.*?)\((\d+)\)/);
        if (durationMatch) {
          modifiers.push({ name: durationMatch[1].trim(), duration: parseInt(durationMatch[2], 10) });
        } else {
          modifiers.push({ name: cleanMod, duration: 4 });
        }
      });
    }
    const disposition = rest
      .replace(/status:\s*\w+/i, "")
      .replace(/modifiers:\s*[^.]*/i, "")
      .replace(/\s*\.\s*/g, ". ")
      .trim();
    return { name: rawName, disposition, status, modifiers };
  },

  stripTags(aiText: string): string {
    return aiText
      .replace(/\[FACT\](.*?)\[\/FACT\]/gs, "")
      .replace(/\[RELATION\](.*?)\[\/RELATION\]/gs, "")
      .replace(/\[STATE_UPDATE\](.*?)\[\/STATE_UPDATE\]/gs, "")
      .replace(/\[FACT_RESET\](.*?)\[\/FACT_RESET\]/gs, "")
      .replace(/\[QUEST\](.*?)\[\/QUEST\]/gs, "")
      .replace(/\[EQUIPMENT\](.*?)\[\/EQUIPMENT\]/gs, "")
      .replace(/\[TRANSACTION\](.*?)\[\/TRANSACTION\]/gs, "")
      .replace(/\[OBJECTIVE_COMPLETE\](.*?)\[\/OBJECTIVE_COMPLETE\]/gs, "")
      .replace(/\[XP_GAIN\](.*?)\[\/XP_GAIN\]/gs, "")
      .replace(/\[SKILL_LEARNED\](.*?)\[\/SKILL_LEARNED\]/gs, "")
      .replace(/\[SKILL_UNLOCK\](.*?)\[\/SKILL_UNLOCK\]/gs, "")
      .replace(/\[CULTIVATION_CHANGE\](.*?)\[\/CULTIVATION_CHANGE\]/gs, "")
      .replace(/\[NPC_PROFILE\](.*?)\[\/NPC_PROFILE\]/gs, "")
      .replace(/\[TIME_STATE\](.*?)\[\/TIME_STATE\]/gs, "")
      .replace(/\[TIME_STATE_REMOVE\](.*?)\[\/TIME_STATE_REMOVE\]/gs, "")
      .replace(/\[GIFT\](.*?)\[\/GIFT\]/gs, "")
      .replace(/\[NPC_GIFT\](.*?)\[\/NPC_GIFT\]/gs, "")
      .replace(/\[SCENE\](.*?)\[\/SCENE\]/gs, "")
      .replace(/\[SEASON_SHIFT\](.*?)\[\/SEASON_SHIFT\]/gs, "")
      .replace(/\[CHECK\](.*?)\[\/CHECK\]/gs, "")
      .replace(/\[MEMORY_REF\](.*?)\[\/MEMORY_REF\]/gs, "")
      .trim();
  },
};
