// =============================================================================
// coherence.test.ts — Turn-response coherence guard.
//
// Covers: detection of analysis-mode rambling (reasoning preamble, excessive
// unclosed tag openings, dense self-reasoning), correct acceptance of normal
// narrative, and the retry request builder (minimal system prompt, compact
// user prompt, no engine boilerplate).
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";

// Minimal document stub so UIManager (imported transitively via xp/prompt) no-ops.
(globalThis as any).document = {
  getElementById: () => null,
  createElement: () => ({
    setAttribute() {},
    click() {},
    remove() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
  }),
  addEventListener: () => {},
  body: { appendChild() {} },
};

import {
  analyzeCoherence,
  startsWithReasoning,
  countMetaReasoning,
  countUnclosedTags,
  buildRetryRequest,
  RETRY_SYSTEM_PROMPT,
} from "./coherence";
import { StateModule } from "../state/state";

describe("analyzeCoherence — detection", () => {
  it("flags a real analysis-mode ramble (regression: Qwythos degenerate turn)", () => {
    // Shape observed live: a 35K-char turn that opened with "Let me analyze
    // this carefully...", contained dozens of unclosed tag openings, and
    // reasoned ABOUT the blocks instead of writing narrative.
    const ramble =
      "Let me analyze this carefully. The user wants to return to the village headman for bridge repair completion payment and ask Elder Li about route details. However, I notice a few things that must be checked against strict rules:\n" +
      "1. **Inventory check**: The current inventory shows Dried Moonflower Petals. But earlier in narrative we bought two bundles from Greta at market, though we lacked copper. So the spec says we must output a [STATE_UPDATE].\n" +
      "2. We must also consider whether we need to output [TRANSACTION] for the copper reward.\n".repeat(200) +
      "Let's check the NPC list. Perhaps we should output [RELATION] for Elder Li if he hasn't been recorded yet. The spec says the user hasn't asked us for [QUEST]. Now we need to output [STATE_UPDATE] with full inventory. We must include the block for copper reward and dagger. I will produce that.\n".repeat(100);
    const verdict = analyzeCoherence(ramble);
    expect(verdict.coherent).toBe(false);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it("flags excessive unclosed tag openings even in a short response", () => {
    const text = "The wind howls. [STATE_UPDATE][RELATION][FACT][QUEST][TRANSACTION][XP_GAIN]";
    const verdict = analyzeCoherence(text);
    expect(verdict.coherent).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("unclosed engine-tag openings");
  });

  it("flags a long response that opens with reasoning preamble", () => {
    const text = "Let me think about what happens next. ".repeat(120);
    const verdict = analyzeCoherence(text);
    expect(verdict.coherent).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("opens with reasoning");
  });

  it("flags dense self-reasoning phrases in an otherwise story-like text", () => {
    const text =
      "We must output the block for the transaction. The spec says we need to emit the state update. Perhaps we should check the inventory list. I will produce the json now. Let's verify the rules. " +
      "The merchant hands you the herbs. ".repeat(10);
    const verdict = analyzeCoherence(text);
    expect(verdict.coherent).toBe(false);
  });

  it("accepts normal immersive narrative with balanced tags", () => {
    const text =
      "The morning light filters through the window. You rise and step onto the wooden threshold, fresh air filling your lungs.\n" +
      "[FACT]Village: The market opens at dawn.[/FACT]\n" +
      "[RELATION]{\"name\": \"Greta\", \"disposition\": \"Friendly merchant\", \"status\": \"Alive\"}[/RELATION]\n" +
      "What would you like to do?";
    const verdict = analyzeCoherence(text);
    expect(verdict.coherent).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("accepts long prose with a couple of unclosed tags (Qwythos habit, not rambling)", () => {
    const prose =
      "You walk through the village streets, the scent of woodsmoke in the air. " +
      "The teahouse looms ahead, its red-tiled roof catching the morning light. " +
      "Greta waves from her stall as you pass, calling out the day's prices. " +
      "You nod and continue on your way, thoughts turning to the task ahead.\n" +
      "[FACT]Market: Herbs cost 3 copper per bundle.";
    const verdict = analyzeCoherence(prose);
    expect(verdict.coherent).toBe(true);
  });

  it("does not flag a short action-oriented reply", () => {
    const text = "You reach for the door handle.";
    const verdict = analyzeCoherence(text);
    expect(verdict.coherent).toBe(true);
  });

  it("flags pre-think analysis ramble that restates the request (Qwen3 live shape)", () => {
    // Shape observed live: the model plans the scene instead of writing it,
    // restating the player's request in third person and listing plan steps.
    const ramble =
      "The user wants to wake up in their dormitory at Azure Cloud Academy.I need to:- Set the time to Monday, March 17, 07:00 (as given).- Describe waking up, stretching, getting dressed.- Look out the window at the morning mist over the mountains.- Describe what is seen in line with xianxia/cultivation/school setting.- Ensure no NPCs present unless logical; likely alone for now.- Enforce metrics, time progression: minimal time taken (maybe 10 minutes). So update to 07:10.- Provide the scene richly and end with an open prompt. I will then append the required blocks carefully so the engine parses them correctly.\n".repeat(12);
    const verdict = analyzeCoherence(ramble);
    expect(verdict.coherent).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("opens with reasoning");
  });

  it("does not flag prose that merely mentions needing something without the planning colon", () => {
    const text =
      "You realize you need to cross the river before dusk. The ferryman waves you over, and you step aboard. ".repeat(40);
    const verdict = analyzeCoherence(text);
    expect(verdict.coherent).toBe(true);
  });

  it("flags the retry response that still opens with \"Here's a thinking process:\" (live Qwen3 shape)", () => {
    // Shape observed live: the simple-prompt RETRY also came back with an
    // untagged thinking preamble instead of narrative.
    const text =
      "Here's a thinking process:\n\n1.  **Analyze the User Input:**\n" +
      "    *   Context: Xianxia world, vast continent, medieval low-magic setting.\n" +
      "    *   Player Action: \"Kael practices his charm aura with his mother Diane.\"\n" +
      "    *   Constraints: Immersive interactive novel narrator. No meta-analysis. Under 400 words.\n" +
      "2.  **Drafting - Scene Construction:**\n" +
      "    *   Describe Kael's attempt, show Diane's reaction, maintain the atmospheric tone.\n" +
      "3.  **Refining & Checking Constraints:**\n" +
      "    *   Word count: ~180 words. Good.\n" +
      "    *   Style: Vivid, immersive. No meta.\n" +
      "4.  **Final Output Generation:**\n" +
      "    *   (Proceeds to generate response based on refined draft).\n" +
      "The cracked ice groans beneath Kael's boots as he turns to face her. ".repeat(30);
    const verdict = analyzeCoherence(text);
    expect(verdict.coherent).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("opens with reasoning");
  });

  it("flags the INIT-turn preamble \"Thinking Process:\n\n1. Analyze the Request:\" (live shape)", () => {
    const text =
      "Thinking Process:\n\n1.  **Analyze the Request:**\n" +
      "    *   Role: Immersive interactive novel narrator.\n" +
      "    *   Style: Flowing, vivid prose. No meta-talk, analysis, or game mechanics.\n" +
      "    *   Length constraint: Under 400 words.\n" +
      "    *   Genre: Xianxia.\n" +
      "    *   Character: Kael.\n" +
      "    *   Task: Establish world/starting situation and prompt for action.\n" +
      "2.  **Deconstruct the Setting & Tone:**\n" +
      "    *   Xianxia elements needed: Cultivation, Qi/Spirit Energy, Sects.\n" +
      "3.  **Drafting - Scene Setting:**\n" +
      "    *   Start with sensory details. Cold, wind, the feeling of the earth.\n" +
      "4.  **Final Polish:**\n" +
      "    *   Ensure smooth transition and strong ending hook.\n" +
      "Frost clings to Kael's coarse hemp robes as he kneels by the frozen stream. ".repeat(30);
    const verdict = analyzeCoherence(text);
    expect(verdict.coherent).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("opens with reasoning");
  });
});

describe("coherence helpers", () => {
  it("startsWithReasoning catches analysis preambles", () => {
    expect(startsWithReasoning("Let me analyze this carefully. The user...")).toBe(true);
    expect(startsWithReasoning("Let's check the NPC list...")).toBe(true);
    expect(startsWithReasoning("As an AI, I need to consider...")).toBe(true);
    expect(startsWithReasoning("The morning light filters through the window.")).toBe(false);
    // Pre-think request-restatement shapes (Qwen3 live).
    expect(startsWithReasoning("The user wants to wake up in their dormitory. I need to: - set the time.")).toBe(true);
    expect(startsWithReasoning("The player asked me to narrate the outcome.")).toBe(true);
    expect(startsWithReasoning("I need to: - advance the clock - describe the scene")).toBe(true);
  });

  it("countMetaReasoning counts the plan-list and request-restatement signals", () => {
    const text =
      "The user wants to wake up. I need to: - set the time - describe the scene. The player wants to train.";
    expect(countMetaReasoning(text)).toBeGreaterThanOrEqual(2);
  });

  it("countMetaReasoning counts self-reasoning phrases", () => {
    const text =
      "We must output the block. The spec says we need to emit. Let's check the inventory. Perhaps we should verify.";
    expect(countMetaReasoning(text)).toBeGreaterThanOrEqual(4);
  });

  it("countUnclosedTags counts openings minus closings", () => {
    const text = "[FACT]A[/FACT][RELATION]B[QUEST]C[STATE_UPDATE]D[/STATE_UPDATE]";
    expect(countUnclosedTags(text)).toBe(2); // RELATION + QUEST unclosed
  });
});

describe("buildRetryRequest", () => {
  beforeEach(() => {
    StateModule.state.setup = {
      genre: "xianxia, wuxia",
      worldSize: "Vast Continent",
      techStage: "Medieval Low-Magic",
    } as never;
    StateModule.state.char.name = "Wei Chen";
    StateModule.state.worldState = {
      time: "Monday, 07:10 AM",
      location: "Oakhaven Market",
      measurement: "Metric",
    };
  });

  it("uses the minimal narrator system prompt", () => {
    const req = buildRetryRequest("I buy herbs.", false);
    expect(req.system).toBe(RETRY_SYSTEM_PROMPT);
    expect(req.system).toContain("write the story");
    expect(req.system).toContain("under 400 words");
  });

  it("carries the player action and current time/location for normal turns", () => {
    const req = buildRetryRequest("I buy herbs.", false);
    expect(req.user).toContain("I buy herbs.");
    expect(req.user).toContain("Monday, 07:10 AM");
    expect(req.user).toContain("Oakhaven Market");
    // No engine boilerplate in the retry prompt.
    expect(req.user).not.toContain("STATE_UPDATE");
    expect(req.user).not.toContain("Active Inventory Schema");
  });

  it("carries world genres for the opening turn", () => {
    const req = buildRetryRequest("", true);
    expect(req.user).toContain("xianxia, wuxia");
    expect(req.user).toContain("Vast Continent");
    expect(req.user).toContain("Wei Chen");
    expect(req.user).toContain("Begin the story now");
  });
});
