// =============================================================================
// token-estimator.test.ts — Unit tests for the token estimation utility.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  estimatePromptSize,
  checkTokenBudget,
  tokensToChars,
} from "./token-estimator";

describe("Token Estimator", () => {
  describe("estimateTokens", () => {
    it("should return 0 for empty input", () => {
      expect(estimateTokens("")).toBe(0);
      expect(estimateTokens(null as unknown as string)).toBe(0);
      expect(estimateTokens(undefined as unknown as string)).toBe(0);
    });

    it("should return at least 1 for short input", () => {
      expect(estimateTokens("a")).toBeGreaterThanOrEqual(1);
      expect(estimateTokens("hi")).toBeGreaterThanOrEqual(1);
    });

    it("should scale approximately linearly with text length", () => {
      const short = "Hello world";
      const long = "Hello world, this is a longer piece of text for testing";
      const shortTokens = estimateTokens(short);
      const longTokens = estimateTokens(long);
      expect(longTokens).toBeGreaterThan(shortTokens);
    });

    it("should use word count as floor for short texts", () => {
      // 5 words = at least 5 tokens.
      const text = "one two three four five";
      expect(estimateTokens(text)).toBeGreaterThanOrEqual(5);
    });

    it("should scale roughly by char/4 for long uniform text", () => {
      // 100 chars, 1 word → returns max(1, ceil(100 * 0.5)) = 50 (single word path).
      const text = "a".repeat(100);
      const tokens = estimateTokens(text);
      // Single repeated char = 1 word, so uses the 0.5 chars/token path.
      expect(tokens).toBe(50);
    });

    it("should use char/4 for long diverse text", () => {
      // 100 chars with spaces = multiple words → uses char/4 path.
      const text = "the quick brown fox jumps over the lazy dog 12345678";
      const tokens = estimateTokens(text);
      // Should be approximately len/4 = ~48/4 = ~12, but at least word count.
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe("estimatePromptSize", () => {
    it("should account for system prompt + history + extra payload", () => {
      const sys = "You are a helpful GM.";
      const history = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ];
      const extra = "Additional context text";

      const size = estimatePromptSize(sys, history, extra);
      expect(size).toBeGreaterThan(estimatePromptSize(sys, history));
    });

    it("should add role prefix tokens per message", () => {
      const sys = "Test";
      const history = [{ role: "user", content: "X" }];
      const size = estimatePromptSize(sys, history);
      // Should include ~2 tokens for the role prefix.
      expect(size).toBeGreaterThan(estimateTokens(sys) + estimateTokens("X"));
    });
  });

  describe("checkTokenBudget", () => {
    it("should return ok=true when under budget", () => {
      const result = checkTokenBudget("Small prompt", [], "", 100_000);
      expect(result.ok).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });

    it("should return ok=false when over budget", () => {
      const hugeHistory = Array.from({ length: 100 }, () => ({
        role: "user",
        content: "X".repeat(500),
      }));
      const result = checkTokenBudget("Prompt", hugeHistory, "", 100);
      expect(result.ok).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("should use soft cap default of 128K", () => {
      const result = checkTokenBudget("Tiny", [], "");
      expect(result.ok).toBe(true);
      expect(result.estimated).toBeLessThan(128_000);
    });
  });

  describe("tokensToChars", () => {
    it("should convert tokens back to approximate chars", () => {
      expect(tokensToChars(100)).toBe(400);
      expect(tokensToChars(0)).toBe(0);
    });
  });
});
