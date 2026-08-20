// =============================================================================
// tag-utils.ts — Shared recovery helpers for parsing AI engine-tag payloads.
//
// Qwythos (and other small local models) emit JSON payloads with recurring
// formatting quirks: markdown emphasis around the JSON (`**{...}**`), code
// fences, and — for array fields like inventory/objectives — TWO concatenated
// arrays (`[...],[...]`) instead of one. Every engine-tag JSON parser routes
// through these helpers so one fix benefits QUEST, EQUIPMENT, TRANSACTION,
// GIFT, NPC_PROFILE, TIME_STATE, and STATE_UPDATE alike.
// =============================================================================

import { z } from "zod";
import { SafeParseResult, safeParseJson } from "../state/schema";

/**
 * Strip common AI formatting around a JSON payload inside an engine tag:
 * ``` fences (```json ... ```) and markdown emphasis (e.g. `**{...}**`,
 * which Qwythos wraps JSON in). Only leading/trailing markers are removed so
 * interior JSON string values are never corrupted.
 */
export function unwrapJsonBlock(raw: string): string {
  return raw
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .replace(/^\s*\*{1,3}\s*/g, "")
    .replace(/\s*\*{1,3}\s*$/g, "")
    .trim();
}

/**
 * Qwythos sometimes emits a JSON payload whose array field contains TWO
 * concatenated arrays, e.g.
 *   "inventory": [{"name": "Small Pouch", ...}],[{"name": "Moonflower", ...}]
 * (closing the array and opening a fresh one instead of a comma). That is
 * invalid JSON, so the whole block used to be skipped. This merges adjacent
 * array literals — [A],[B] -> [A,B] (also handling `][` with no comma) — and
 * re-validates. Returns the repaired string when the merge yields parseable
 * JSON, otherwise null so the caller can still skip the block safely.
 *
 * The repair only runs AFTER an initial parse failure, so only payloads that
 * are genuinely broken are touched.
 */
export function repairConcatenatedArrays(jsonStr: string): string | null {
  try {
    JSON.parse(jsonStr);
    return null; // already valid — nothing to repair
  } catch {
    /* fall through to repair attempt */
  }
  const merged = jsonStr
    .replace(/\]\s*,\s*\[/g, ",") // [A],[B] -> [A,B]
    .replace(/\]\s*\[/g, ","); // [A][B] -> [A,B] (missing comma)
  if (merged === jsonStr) return null; // no concatenation pattern present
  try {
    JSON.parse(merged);
    return merged;
  } catch {
    return null; // repair didn't fix it — caller skips as before
  }
}

/**
 * Parse an engine-tag JSON payload with Qwythos recovery: unwrap markdown/code
 * fences, validate, and on failure attempt the concatenated-array repair
 * before giving up. Never throws — callers check `ok` like safeParseJson.
 */
export function safeParseJsonBlock<S extends z.ZodTypeAny>(
  schema: S,
  raw: string,
): SafeParseResult<z.output<S>> {
  let jsonStr = unwrapJsonBlock(raw);
  let parsed = safeParseJson(schema, jsonStr);
  if (!parsed.ok) {
    const repaired = repairConcatenatedArrays(jsonStr);
    if (repaired) {
      jsonStr = repaired;
      parsed = safeParseJson(schema, jsonStr);
    }
  }
  return parsed;
}

/**
 * Pull the first numeric value out of a loose AI payload like "+50", "50 XP",
 * "**50**", or "fifty"? (no match -> null). Used by numeric tags such as
 * [XP_GAIN] and [CULTIVATION_CHANGE] where models append units or signs.
 */
export function extractNumber(raw: string): number | null {
  const m = unwrapJsonBlock(raw).match(/[+-]?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}
