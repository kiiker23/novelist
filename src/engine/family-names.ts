// =============================================================================
// family-names.ts — Shared family naming data + fact normalization.
//
// A LEAF module: it imports nothing from the engine, so both family.ts (which
// owns backstory seeding) and lore.ts (which owns [FACT] extraction) can use
// it without creating a lore <-> family import cycle.
// =============================================================================

import { Relation } from "../state/GameState";

/**
 * Common casual aliases seeded alongside each family role, so AI updates
 * phrased in everyday terms ("Mom", "Dad", "Grandma") merge onto the same
 * entry instead of fragmenting into a second NPC. The role title itself is
 * also aliased when a proper name is captured ("Diane" + alias "Mother").
 */
export const ROLE_SYNONYMS: Record<string, string[]> = {
  "Younger Sister": ["Sis"],
  "Older Sister": ["Sis"],
  Sister: ["Sis"],
  "Younger Brother": ["Bro"],
  "Older Brother": ["Bro"],
  Brother: ["Bro"],
  Mother: ["Mom", "Mum", "Mama"],
  Father: ["Dad", "Papa"],
  Grandmother: ["Grandma", "Granny", "Nana"],
  Grandfather: ["Grandpa", "Gramps"],
};

/** Recognizable family role words in a registered relation's name. */
export const FAMILY_ROLE_NAME_RE =
  /\b(?:mother|mom|mum|father|dad|sister|brother|sibling|grandmother|grandma|grandfather|grandpa|aunt|uncle|cousin|niece|nephew|wife|husband|daughter|son|parents?|family)\b/i;

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word containment check — mirrors lore.ts isWordContained. "Elder Wu"
 * contains "Wu" as a word, but "Marabel" never contains "Mara" as a word.
 */
function isWordContained(haystack: string, needle: string): boolean {
  if (haystack === needle) return true;
  const idx = haystack.indexOf(needle);
  if (idx === -1) return false;
  const before = idx > 0 ? haystack[idx - 1] : "";
  const after = idx + needle.length < haystack.length ? haystack[idx + needle.length] : "";
  return !/[a-z]/i.test(before) && !/[a-z]/i.test(after);
}

/** True when phrase appears in text as a whole word (case-insensitive). */
export function containsWholeWord(text: string, phrase: string): boolean {
  if (!text || !phrase) return false;
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i").test(text);
}

/** Replace whole-word occurrences of phrase with replacement (case-insensitive). */
export function replaceWholeWord(
  text: string,
  phrase: string,
  replacement: string,
): string {
  if (!text || !phrase) return text;
  return text.replace(new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "gi"), replacement);
}

/**
 * Resolve a directive's parsed name against the registered relations: when
 * the user writes "Add my Mom to the NPC list" and the mother is already
 * seeded (as "Diane" with alias "Mom"), the directive must target the
 * EXISTING entry instead of creating a duplicate "Mom" NPC. Matches names
 * AND aliases with the same whole-word guard the relation merger uses, so
 * "Wu" resolves to "Elder Wu" but "Mara" never matches "Marabel". Returns
 * the canonical registered name, or null when nothing matches.
 */
export function resolveCanonicalRelationName(
  name: string,
  relations: Relation[],
): string | null {
  const search = (name || "").toLowerCase();
  if (!search || !relations || relations.length === 0) return null;
  for (const rel of relations) {
    const relName = (rel.name || "").toLowerCase();
    if (isWordContained(relName, search) || isWordContained(search, relName)) {
      return rel.name;
    }
    for (const a of rel.aliases || []) {
      const al = a.toLowerCase();
      if (isWordContained(al, search) || isWordContained(search, al)) {
        return rel.name;
      }
    }
  }
  return null;
}

/**
 * True when a registered relation belongs to the MC's household — either the
 * disposition carries the "MC's ..." marker (seeded from the backstory) or
 * the name/aliases use a recognizable family role title (AI/directive
 * registered). Mirrors isFamilyRelation in family.ts.
 */
function isFamilyMember(rel: Relation): boolean {
  if (!rel) return false;
  if (rel.name && FAMILY_ROLE_NAME_RE.test(rel.name)) return true;
  if ((rel.aliases || []).some((a) => FAMILY_ROLE_NAME_RE.test(a))) return true;
  const disp = (rel.disposition || "").toLowerCase();
  return /^mc's\b|family of the mc/.test(disp);
}

/**
 * Resolve casual family mentions ("Mom", "Dad", "Grandma") in a fact entry
 * to the registered canonical relation name ("Diane"), so the fact is
 * durably linked to the right person:
 *   - relevance matching hits the canonical name (stronger, stable)
 *   - "Mom came home late" and "Diane came home late" collapse into one entry
 *   - the Knowledge panel shows the real name, not the casual form
 * Only whole words are replaced (longest match first), only for registered
 * family relations — non-family NPC aliases ("Oakhaven Herbalist") and
 * coincidental substrings ("Momentum", "sister" vs alias "Sis") are left
 * untouched.
 */
export function normalizeFamilyReferences(
  entryText: string,
  relations: Relation[],
): string {
  const text = (entryText || "").trim();
  if (!text || !relations || relations.length === 0) return text;

  const replacements: Array<{ word: string; canonical: string }> = [];
  for (const rel of relations) {
    if (!isFamilyMember(rel)) continue;
    const canonical = rel.name || "";
    if (!canonical) continue;
    const canonicalLower = canonical.toLowerCase();
    const words = new Set<string>();
    // Registered aliases already carry the role title + casual synonyms for
    // seeded entries (["Mother", "Mom", "Mum", "Mama"] on "Diane").
    for (const a of rel.aliases || []) words.add(a.toLowerCase());
    // When the canonical name IS a role title ("Mother") and the relation
    // carries no alias list (AI/directive-registered), its casual synonyms
    // must still resolve to it.
    const role = Object.keys(ROLE_SYNONYMS).find(
      (r) => r.toLowerCase() === canonicalLower,
    );
    if (role) {
      for (const s of ROLE_SYNONYMS[role]) words.add(s.toLowerCase());
    }
    for (const w of words) {
      if (w && w !== canonicalLower) {
        replacements.push({ word: w, canonical });
      }
    }
  }
  if (replacements.length === 0) return text;

  // Longest word first so "younger sister" wins over "sister".
  replacements.sort((a, b) => b.word.length - a.word.length);
  let result = text;
  for (const r of replacements) {
    result = result.replace(
      new RegExp(`\\b${escapeRegExp(r.word)}\\b`, "gi"),
      r.canonical,
    );
  }
  return result;
}
