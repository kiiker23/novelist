// =============================================================================
// seasons.ts — Season derivation from the in-game calendar date.
//
// The engine carries a "CURRENT SEASON" line in the per-turn payload derived
// from worldState.time, and the system prompt teaches the AI to record season
// changes as [FACT]Season: ...[/FACT] memory entries (replacing the previous
// one via [FACT_RESET]Season[/FACT_RESET]). This module is the single source
// of truth for the month -> season mapping.
// =============================================================================

const MONTH_NAMES: Record<string, string> = {
  jan: "january", january: "january",
  feb: "february", february: "february",
  mar: "march", march: "march",
  apr: "april", april: "april",
  may: "may",
  jun: "june", june: "june",
  jul: "july", july: "july",
  aug: "august", august: "august",
  sep: "september", sept: "september", september: "september",
  oct: "october", october: "october",
  nov: "november", november: "november",
  dec: "december", december: "december",
};

const SEASON_OF_MONTH: Record<string, string> = {
  december: "Winter",
  january: "Winter",
  february: "Winter",
  march: "Spring",
  april: "Spring",
  may: "Spring",
  june: "Summer",
  july: "Summer",
  august: "Summer",
  september: "Autumn",
  october: "Autumn",
  november: "Autumn",
};

const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

const SEASON_WORDS: Record<string, string> = {
  winter: "Winter",
  spring: "Spring",
  summer: "Summer",
  autumn: "Autumn",
  fall: "Autumn",
};

/**
 * Extract the canonical season word from free text ("late autumn",
 * "mid-winter chill", "fall") or undefined when no season word is present
 * (e.g. "the rainy season") — used to validate AI-recorded seasons against
 * the calendar.
 */
export function normalizeSeasonWord(text: string): string | undefined {
  const lower = (text || "").toLowerCase();
  for (const [word, canon] of Object.entries(SEASON_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(lower)) return canon;
  }
  return undefined;
}

/**
 * Derive the current season from a worldState.time string
 * ("Monday, March 17, 07:00" -> "Spring"). Returns undefined when the time
 * string carries no parseable month (e.g. legacy "Day 3, 14:30" clocks).
 */
export function getSeasonFromTime(timeStr: string): string | undefined {
  const t = (timeStr || "").trim();
  if (!t) return undefined;
  const m = MONTH_RE.exec(t.toLowerCase());
  if (!m) return undefined;
  const full = MONTH_NAMES[m[1]];
  return full ? SEASON_OF_MONTH[full] : undefined;
}

/**
 * The season that is canon RIGHT NOW: a story-driven [SEASON_SHIFT] override
 * wins over the calendar-derived season, so cursed winters, time skips, and
 * out-of-sync realms stay consistent instead of fighting the clock.
 */
export function getCanonicalSeason(
  timeStr: string,
  override?: string,
): string | undefined {
  const ov = override ? normalizeSeasonWord(override) : undefined;
  return ov || getSeasonFromTime(timeStr);
}
