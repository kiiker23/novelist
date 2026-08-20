// =============================================================================
// summarizer.test.ts — Unit tests for the rolling history summarizer.
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  initSummarizer,
  getSummary,
  prepareContext,
  setSummary,
  resetSummarizer,
  getCompressedHistory,
} from "./summarizer";
import { StateModule } from "../state/state";

describe("Summarizer", () => {
  beforeEach(() => {
    // Reset summarizer and state before each test.
    resetSummarizer();
    StateModule.state.history = [];
  });

  it("should start with an empty summary", () => {
    initSummarizer();
    expect(getSummary()).toBe("");
  });

  it("should return empty context before initialization", () => {
    const ctx = prepareContext();
    expect(ctx.summary).toBe("");
    expect(ctx.recentHistory).toEqual([]);
  });

  it("should set and retrieve a summary", () => {
    initSummarizer();
    setSummary("Lin Hao woke up in his room.");
    expect(getSummary()).toBe("Lin Hao woke up in his room.");
  });

  it("should return recent history when no summary exists", () => {
    initSummarizer();
    StateModule.state.history = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Welcome to the world..." },
    ];

    const ctx = prepareContext();
    expect(ctx.summary).toBe("");
    expect(ctx.recentHistory).toHaveLength(2);
    expect(ctx.recentHistory[0].content).toBe("Hello");
  });

  it("should prepend summary to compressed history", () => {
    initSummarizer();
    setSummary("The hero entered the forest.");
    StateModule.state.history = [
      { role: "user", content: "I walk deeper." },
      { role: "assistant", content: "The trees close around you." },
    ];

    const compressed = getCompressedHistory();
    expect(compressed).toHaveLength(3); // summary marker + 2 history
    expect(compressed[0].content).toContain("[[STORY SUMMARY]]");
    expect(compressed[0].content).toContain("The hero entered the forest.");
  });

  it("should fall back to full history when no summary", () => {
    initSummarizer();
    StateModule.state.history = [
      { role: "user", content: "Test message" },
    ];

    const compressed = getCompressedHistory();
    expect(compressed).toHaveLength(1);
    expect(compressed[0].content).toBe("Test message");
  });

  it("should respect maxHistoryTurns config", () => {
    initSummarizer({ maxHistoryTurns: 4 });
    // Push 10 turns.
    for (let i = 0; i < 10; i++) {
      StateModule.state.history.push({ role: "user", content: `Turn ${i}` });
      StateModule.state.history.push({ role: "assistant", content: `Response ${i}` });
    }

    const ctx = prepareContext();
    expect(ctx.recentHistory.length).toBeLessThanOrEqual(4);
  });

  it("should reset cleanly", () => {
    initSummarizer();
    setSummary("Some summary");
    resetSummarizer();
    expect(getSummary()).toBe("");
    expect(getCompressedHistory()).toEqual([]);
  });
});
