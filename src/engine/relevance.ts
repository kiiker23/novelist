// =============================================================================
// relevance.ts - Fact and relation relevance filtering.
//
// Rather than dumping ALL lorebook facts and ALL relations into the system
// prompt every turn, this module selects only the subset relevant to the
// current location, time, and active NPCs. This dramatically reduces prompt
// size for long sessions with many established facts.
// =============================================================================

import { FactBundle, Relation } from "../state/GameState";

/** An NPC name reference for relevance matching. */
interface NpcRef {
  name: string;
  aliases?: string[];
}

/**
 * Scoring context passed to relevance filtering.
 */
export interface RelevanceContext {
  location?: string;
  time?: string;
  activeNpcs: NpcRef[];
  /** Minimum score threshold for a fact bundle to be included. */
  minScore: number;
}

/**
 * Score a fact bundle based on keyword matching against the context.
 * Higher score = more relevant.
 */
function scoreFactBundle(bundle: FactBundle, context: RelevanceContext): number {
  if (bundle.entries.length === 0) return 0;

  const searchText = [bundle.title, ...bundle.entries].join(" ").toLowerCase();
  let score = 0;

  // Match against active NPC names
  for (const npc of context.activeNpcs) {
    const nameLower = npc.name.toLowerCase();
    if (searchText.includes(nameLower)) {
      score += 10;
    }
    // Also check aliases
    for (const alias of npc.aliases || []) {
      if (alias.toLowerCase() !== nameLower && searchText.includes(alias.toLowerCase())) {
        score += 10;
      }
    }
  }

  // Match against location
  if (context.location) {
    const locLower = context.location.toLowerCase();
    if (searchText.includes(locLower)) {
      score += 8;
    }
    // Partial match (e.g., "School" matches "Central High School")
    const words = locLower.split(/\s+/);
    for (const word of words) {
      if (word.length > 3 && searchText.includes(word)) {
        score += 3;
      }
    }
  }

  // Match against time indicators
  if (context.time) {
    const timeLower = context.time.toLowerCase();
    const timeWords = timeLower.match(/\b\w+\b/) || [];
    for (const word of timeWords) {
      if (word.length > 3 && searchText.includes(word)) {
        score += 2;
      }
    }
  }

  // General facts (always somewhat relevant). "season" is included so the
  // persistent Season bundle (calendar state the AI replaces each season
  // change) stays visible regardless of the current location/time keywords;
  // "family" keeps the household bundle (who died, who lives at home) in
  // view even when the scene is far from home.
  const generalKeywords = [
    "general",
    "world",
    "rule",
    "always",
    "never",
    "must",
    "cannot",
    "season",
    "family",
  ];
  const bundleTitleLower = bundle.title.toLowerCase();
  for (const kw of generalKeywords) {
    if (bundleTitleLower.includes(kw)) {
      score += 1;
      break;
    }
  }

  return score;
}

/**
 * Filter fact bundles by relevance to the current context.
 * Returns only bundles scoring above minScore, sorted by relevance.
 */
export function filterFacts(
  allFacts: FactBundle[],
  context: RelevanceContext,
): FactBundle[] {
  const scored = allFacts
    .map((bundle) => ({ bundle, score: scoreFactBundle(bundle, context) }))
    .filter(({ score }) => score >= context.minScore)
    .sort((a, b) => b.score - a.score);

  return scored.map(({ bundle }) => bundle);
}

/**
 * Filter relations by relevance. Active NPCs near the current location
 * or mentioned in recent turns are prioritized. Deceased NPCs are always
 * excluded unless explicitly requested.
 */
export function filterRelations(
  allRelations: Relation[],
  context: RelevanceContext,
): { active: Relation[]; deceased: Relation[] } {
  const scored = allRelations
    .filter((r) => r.status !== "Deceased")
    .map((rel) => {
      const nameLower = rel.name.toLowerCase();
      let score = 0;

      for (const npc of context.activeNpcs) {
        const npcLower = npc.name.toLowerCase();
        if (nameLower === npcLower) {
          score = 100; // Exact match = highest priority
          break;
        }
        if (nameLower.includes(npcLower) || npcLower.includes(nameLower)) {
          score = Math.max(score, 50); // Partial match
        }
        for (const alias of npc.aliases || []) {
          if (alias.toLowerCase() === nameLower || nameLower.includes(alias.toLowerCase())) {
            score = Math.max(score, 75);
          }
        }
      }

      // Boost if the relation has active modifiers
      if (rel.modifiers && rel.modifiers.some((m) => m.duration > 0)) {
        score += 20;
      }

      return { rel, score };
    })
    .sort((a, b) => b.score - a.score);

  // All active relations are relevant (they're alive and tracked).
  // But we can optionally cap to top-N for extreme brevity.
  const maxActive = context.minScore > 0 ? scored.slice(0, 12) : scored;

  const deceased = allRelations.filter((r) => r.status === "Deceased");

  return {
    active: maxActive.map(({ rel }) => rel),
    deceased,
  };
}

/**
 * Build a relevance context from the current game state.
 */
export function buildRelevanceContext(
  location: string,
  time: string,
  relations: Relation[],
  minScore: number,
): RelevanceContext {
  const activeNpcs: NpcRef[] = relations
    .filter((r) => r.status !== "Deceased")
    .map((r) => ({ name: r.name, aliases: r.aliases || [] }));

  return { location, time, activeNpcs, minScore };
}
