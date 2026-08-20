// =============================================================================
// coherence.ts — Turn-response coherence guard.
//
// Small local models (Qwythos, llama3.2) occasionally degenerate from
// narrating the story into "analysis mode": instead of prose they emit long
// chains of self-reasoning ("Let me analyze this carefully... we must output
// the block... the spec says...") with dozens of unclosed engine-tag openings
// and little or no narrative. Such a turn is useless — and worse, it gets
// stored in history and re-fed to the model next turn.
//
// This module (1) detects the degenerate pattern, and (2) builds a short,
// simple retry request — a minimal system prompt and a compact user prompt
// with no game-engine boilerplate — so the caller can recover with ONE extra
// call before anything is shown to the player.
// =============================================================================

import { StateModule } from "../state/state";
import { ApiModule, GenerationRetryInfo } from "../api/providers";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Engine tags whose OPENING counts as an attempted structured block. */
const TAG_OPEN_RE =
  /\[(FACT|FACT_RESET|RELATION|STATE_UPDATE|QUEST|EQUIPMENT|TRANSACTION|OBJECTIVE_COMPLETE|XP_GAIN|SKILL_LEARNED|SKILL_UNLOCK|CULTIVATION_CHANGE|NPC_PROFILE|TIME_STATE|TIME_STATE_REMOVE|GIFT|NPC_GIFT)\]/g;
const TAG_CLOSE_RE =
  /\[\/(FACT|FACT_RESET|RELATION|STATE_UPDATE|QUEST|EQUIPMENT|TRANSACTION|OBJECTIVE_COMPLETE|XP_GAIN|SKILL_LEARNED|SKILL_UNLOCK|CULTIVATION_CHANGE|NPC_PROFILE|TIME_STATE|TIME_STATE_REMOVE|GIFT|NPC_GIFT)\]/g;

/**
 * Responses that open with reasoning preamble instead of narrative.
 * Includes the pre-think request-restatement shape seen live from Qwen3:
 * "The user wants to wake up... I need to: - set the time..." — the model
 * plans the scene instead of writing it.
 */
const REASONING_PREAMBLE_RE =
  /^\s*(?:let me (?:analyze|think|consider|check|figure|decide)|let'?s (?:analyze|check|consider|think)|(?:first|okay|alright|so),?\s*(?:let|i (?:need|must|should|have to|want to))|i (?:need|must|should|have to|want to) (?:to )?(?:analyze|think|consider|check|figure|decide)|the (?:user|player) (?:wants|asked|requested|told) (?:me )?to|i need to:|as an? (?:ai|assistant|language model|llm)|hmm|(?:thinking|analysis|reasoning|thought|plan)(?: process| steps?| so far)?[:：]|here'?s (?:my|the) (?:analysis|plan|approach|thinking)|here'?s (?:a |an )?(?:thinking|analysis|reasoning|thought)(?: process| steps?| so far)?[:：]|step[- ]by[- ]step (?:analysis|plan|guide))/i;

/**
 * Self-reasoning phrases typical of analysis-mode rambling: the model talks
 * ABOUT the output it must produce instead of producing it.
 */
const META_REASONING_RE: RegExp[] = [
  /(?:we|i) (?:must|need to|should|have to) (?:output|emit|provide|consider|check|ensure|make sure|verify|reflect|decide)/gi,
  /let'?s (?:check|consider|look at|verify|think|analyze|see)/gi,
  /the (?:spec|system|engine|rules?|prompt|instructions?) (?:says|requires|states|demands|asks)/gi,
  /(?:no need|not (?:needed|required)|doesn'?t require|isn'?t required|unnecessary) (?:to|for)/gi,
  /(?:perhaps|maybe|probably) (?:i|we) (?:should|need|can|must)/gi,
  /(?:i'?ll|i will|we'?ll|we will) (?:output|emit|produce|provide|craft) (?:the|a|an) (?:block|json|state|tag|update)/gi,
  /(?:inventory|state) (?:check|must|needs?|should|will) (?:be|include|list|reflect)/gi,
  // "I need to: - set the time - describe..." — a colon-led plan list.
  /i need to:\s*(?:-|\u2022|\*|\n|$)/gi,
  // Restating the player's request instead of fulfilling it, mid-text.
  /the (?:user|player) (?:wants|asked|requested|told) (?:me )?to/gi,
  // Untagged thinking headers seen live from local models ("Thinking
  // Process:\n\n1. **Analyze the Request:**").
  /^(?:thinking|analysis|reasoning|thought)s?[:：]?\s*(?:process|steps?)?/gim,
  /analy(?:ze|zing|sis) (?:the|this) (?:request|prompt|user|scene)/gi,
  // Meta "about the output" spec lines the model parrots while planning.
  /(?:role|style|tone|genre|world|setting|ending requirement|length constraint)s?:/gi,
  /\*\s*(?:role|style|tone|length|format|ending)/gi,
];

/** Whether the text begins with reasoning rather than story. */
export function startsWithReasoning(text: string): boolean {
  return REASONING_PREAMBLE_RE.test(text);
}

/** Count of self-reasoning phrases in the text (any of the signatures). */
export function countMetaReasoning(text: string): number {
  let total = 0;
  for (const re of META_REASONING_RE) {
    re.lastIndex = 0;
    const matches = text.match(re);
    if (matches) total += matches.length;
  }
  return total;
}

/** Unclosed engine-tag openings: openings minus closings (clamped at 0). */
export function countUnclosedTags(text: string): number {
  TAG_OPEN_RE.lastIndex = 0;
  TAG_CLOSE_RE.lastIndex = 0;
  const opens = (text.match(TAG_OPEN_RE) || []).length;
  const closes = (text.match(TAG_CLOSE_RE) || []).length;
  return Math.max(0, opens - closes);
}

export interface CoherenceVerdict {
  coherent: boolean;
  reasons: string[];
}

/**
 * Decide whether a turn response is coherent narrative. A response is flagged
 * as analysis-mode rambling when any of these hold:
 *   1. far more engine-tag openings than closings (> 8) — the model is
 *      repeatedly *attempting* blocks while reasoning, not emitting them;
 *   2. the response opens with a reasoning preamble AND is long (> 1500
 *      chars) — prose never starts with "Let me analyze this carefully" or
 *      "The user wants to... I need to:...";
 *   3. dense self-reasoning phrases (>= 10 hits, >= 4 per 1000 chars) even
 *      when the text starts story-like.
 * These are deliberately conservative: a few unclosed tags or a couple of
 * "we must" phrases in an otherwise long narrative are NOT flagged.
 */
export function analyzeCoherence(text: string): CoherenceVerdict {
  const reasons: string[] = [];
  const len = text.length;

  const unclosed = countUnclosedTags(text);
  if (unclosed > 5) {
    reasons.push(`${unclosed} unclosed engine-tag openings`);
  }

  if (startsWithReasoning(text) && len > 1500) {
    reasons.push("opens with reasoning instead of narrative");
  }

  const meta = countMetaReasoning(text);
  if (meta >= 4 && meta / (len / 1000) >= 4) {
    reasons.push(`${meta} self-reasoning phrases (analysis mode)`);
  }

  return { coherent: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * Minimal narrator system prompt for the coherence retry: no engine rules, no
 * output-format spec, no state reminder — just "write the story". The goal is
 * to drag the model out of analysis mode and back into prose with the least
 * possible instruction surface.
 */
export const RETRY_SYSTEM_PROMPT =
  "You are an immersive interactive novel narrator. Continue the story in flowing, vivid prose. Do NOT analyze, plan, reason, or describe game mechanics — write the story itself. Keep the response under 400 words. End by asking the player what they do next.";

/**
 * Build the retry request: the minimal system prompt above plus a compact
 * user prompt carrying only what the model needs to continue the story
 * (genres/world for the opening turn; time/location + the player's action for
 * normal turns). Deliberately omits the engine-tag spec and inventory dump —
 * those are exactly what sends small models into analysis mode.
 */
export function buildRetryRequest(
  userText: string,
  isInitial: boolean,
): { system: string; user: string } {
  const s = StateModule.state;
  const setup = s.setup as { genre?: string; worldSize?: string; techStage?: string };
  const user = isInitial
    ? [
        `Genres: ${setup.genre || "unspecified"}. World size: ${setup.worldSize || "unspecified"}. Tech/magic stage: ${setup.techStage || "unspecified"}.`,
        `Player character: ${s.char.name}.`,
        "Begin the story now: establish the world and the character's starting situation, then end with an open prompt for the player's first action.",
      ].join("\n\n")
    : [
        `Current time: ${s.worldState.time}. Current location: ${s.worldState.location}.`,
        `Player action: ${userText}`,
        "Narrate the outcome of this action as a story, then end with an open prompt for the next action.",
      ].join("\n\n");
  return { system: RETRY_SYSTEM_PROMPT, user };
}

/**
 * Make ONE retry with the simple prompt. Never throws — a failed retry
 * returns null so the caller can keep the original response. If the retry is
 * itself incoherent, it is still returned (a shorter ramble is usually a
 * better prompt for the player than a 35K-char one), and the caller logs it.
 */
export async function retryWithSimplePrompt(
  userText: string,
  isInitial: boolean,
  onRetry?: (info: GenerationRetryInfo) => void,
): Promise<string | null> {
  try {
    const { system, user } = buildRetryRequest(userText, isInitial);
    const raw = await ApiModule.generateResponse(system, user, undefined, onRetry);
    const verdict = analyzeCoherence(raw);
    if (!verdict.coherent) {
      console.warn(
        `[coherence] retry also incoherent (${verdict.reasons.join(", ")}); keeping it as the last attempt.`,
      );
    }
    return raw;
  } catch (err) {
    console.warn("[coherence] retry call failed; keeping the original response.", err);
    return null;
  }
}
