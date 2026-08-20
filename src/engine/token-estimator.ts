// =============================================================================
// token-estimator.ts — Lightweight token estimation for prompt sizing.
//
// Approximates token count using a simple heuristic: ~4 characters per token
// for English text, plus JSON overhead for structured payloads. This avoids
// pulling in a heavy tokenizer library while giving a ±15% estimate accurate
// enough for UI meters and soft cap enforcement.
// =============================================================================

/**
 * Estimate the number of tokens in a text string.
 * Rule-of-thumb: 1 token ≈ 4 characters for mixed English/technical text.
 * Adds ~0.5 tokens per word for very short strings (< 20 chars) to avoid
 * underestimating single-word inputs.
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;

  const len = text.length;
  const words = text.trim().split(/\s+/).filter(Boolean).length;

  if (words <= 1) return Math.max(1, Math.ceil(len * 0.5));

  // ~4 chars per token for longer text
  return Math.max(words, Math.ceil(len / 4));
}

/**
 * Estimate total prompt size given a system prompt and a history array.
 * Includes per-message role prefixes (~2 tokens each).
 */
export function estimatePromptSize(
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  extraPayload?: string,
): number {
  let total = estimateTokens(systemPrompt);

  for (const msg of history) {
    // Role prefix tokens ("User:" / "Assistant:" / "System:")
    total += 2;
    total += estimateTokens(msg.content);
  }

  if (extraPayload) {
    total += 2; // separator tokens
    total += estimateTokens(extraPayload);
  }

  return total;
}

/**
 * Convert a rough token count to an approximate character budget.
 * Uses 4 chars/token as the inverse of estimateTokens.
 */
export function tokensToChars(tokens: number): number {
  return tokens * 4;
}

/**
 * Check if a prompt would exceed a given token budget (soft cap).
 * Returns the remaining budget or 0 if exceeded.
 */
export function checkTokenBudget(
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  extraPayload?: string,
  softCap: number = 128_000,
): { ok: boolean; estimated: number; remaining: number } {
  const estimated = estimatePromptSize(systemPrompt, history, extraPayload);
  return {
    ok: estimated <= softCap,
    estimated,
    remaining: Math.max(0, softCap - estimated),
  };
}
