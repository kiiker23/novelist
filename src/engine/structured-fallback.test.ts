// =============================================================================
// structured-fallback.test.ts — Runtime recovery for tag-less AI turns.
//
// Covers: detection (hasEngineTags / describesChange / needsStructuredUpdate),
// the follow-up request builder, and the recovery pipeline through
// LoreModule with a mocked API call.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";

// Minimal document stub so UIManager (imported transitively) no-ops in a
// DOM-free test run.
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

// Minimal localStorage stub so StorageModule.autosave no-ops.
(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  key: () => null,
  length: 0,
};

const { mockGenerateResponse } = vi.hoisted(() => ({
  mockGenerateResponse: vi.fn(),
}));

vi.mock("../api/providers", () => ({
  ApiModule: { generateResponse: mockGenerateResponse, testConnection: vi.fn() },
}));

import { StateModule } from "../state/state";
import { StorageModule } from "../storage/save";
import { LoreModule } from "./lore";
import {
  hasEngineTags,
  describesChange,
  needsStructuredUpdate,
  buildFallbackRequest,
  runStructuredFallback,
  isParrotedReply,
} from "./structured-fallback";

function resetState(): void {
  const s = StateModule.state;
  s.worldState = { time: "Monday, 07:00 AM", location: "Oakhaven Market", measurement: "Metric" };
  s.char.inventory = [
    { name: "Simple Clothes", desc: "Basic attire", qty: 1, props: {} },
  ];
  s.char.health = 100;
  s.char.maxHealth = 100;
  s.char.fatigue = 0;
  s.currencies = [];
  s.memory = { facts: [], relations: [] };
  s.toggles.memory = true;
}

describe("detection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("hasEngineTags detects any engine tag, even unclosed", () => {
    expect(hasEngineTags("[FACT]Oakhaven: herbs cost 3 copper.")).toBe(true);
    expect(hasEngineTags("[RELATION]{...}")).toBe(true);
    expect(hasEngineTags("[STATE_UPDATE]{\"health\": 50}")).toBe(true);
    expect(hasEngineTags("The herbalist smiles and hands you the herbs.")).toBe(false);
  });

  it("describesChange flags purchases, NPC meetings, and health loss", () => {
    expect(describesChange("You buy a loaf of bread for 3 copper.")).toBe(true);
    expect(describesChange("You met the herbalist, Mara, at her stall.")).toBe(true);
    expect(describesChange("Your health drops to 60 as the blade cuts deep.")).toBe(true);
    expect(describesChange("You found an iron sword in the old chest.")).toBe(true);
  });

  it("describesChange is conservative about pure description", () => {
    expect(describesChange("You gaze at the horizon, feeling the wind on your face.")).toBe(false);
    // Single weak signal (movement alone) is not enough.
    expect(describesChange("You walked toward the gate.")).toBe(false);
  });

  it("describesChange triggers on a pair of weak signals", () => {
    // walked (weak) + asked (weak) = 2 weak hints -> true.
    expect(describesChange("You walked into town and asked the guard for directions.")).toBe(true);
  });

  it("needsStructuredUpdate requires BOTH a change AND missing tags", () => {
    const buying = "You buy a bundle of dried herbs for 3 copper.";
    expect(needsStructuredUpdate(buying)).toBe(true);
    // Same turn but with tags (even unclosed) -> parser handles it, no fallback.
    expect(needsStructuredUpdate("[FACT]Oakhaven: herbs cost 3 copper.\n" + buying)).toBe(false);
    // No change described -> no fallback.
    expect(needsStructuredUpdate("The wind carries the smell of bread.")).toBe(false);
  });

  it("describesChange catches quest offers, knowledge, and present-tense NPC meetings", () => {
    // Real Qwythos narrative from the Elder Li turn — matched ZERO hints before
    // the fix (present-tense "greets", "offer to", "news of").
    expect(
      describesChange(
        "He greets you warmly; from his lips comes news of bandits raiding the mountain road northward and of a jade pendant stolen from his very shrine. You bow respectfully, acknowledging both the threat and the elder's offer to seek it out.",
      ),
    ).toBe(true);
    expect(describesChange("The elder offers you a task: find his lost jade pendant.")).toBe(true);
    expect(describesChange("She tells you the price of moonflower petals.")).toBe(true);
    expect(describesChange("He asks you to retrieve the stolen scroll.")).toBe(true);
    expect(needsStructuredUpdate("The elder greets you and offers you a quest.")).toBe(true);
  });
});

describe("buildFallbackRequest", () => {
  beforeEach(() => {
    resetState();
  });

  it("includes the narrative plus the current state snapshot", () => {
    const req = buildFallbackRequest("You buy herbs for 3 copper from Mara.");
    expect(req.user).toContain("You buy herbs for 3 copper from Mara.");
    expect(req.user).toContain("Current location: Oakhaven Market");
    expect(req.user).toContain('"name":"Simple Clothes"');
    expect(req.system).toContain("output ONLY the engine update blocks");
  });

  it("truncates very long narratives to keep the follow-up call small", () => {
    const long = "word ".repeat(6000);
    const req = buildFallbackRequest(long);
    expect(req.user.length).toBeLessThan(4000);
  });

  it("uses concrete examples and forbids copying them (no template placeholders)", () => {
    const req = buildFallbackRequest("You buy herbs.");
    // The old prompt used placeholder text the model echoed back as data.
    expect(req.system).not.toContain("Group Title: the fact");
    expect(req.system).toContain("never copy the example values");
    expect(req.system).toContain("Dried herbs cost 3 copper per bundle");
  });

  it("includes a [QUEST] example so recovery can extract quests", () => {
    const req = buildFallbackRequest("The elder gives you a task.");
    expect(req.system).toContain("quest-jade-pendant");
    expect(req.system).toContain("when an NPC gives the MC a task or quest");
    expect(req.system).toContain("[/QUEST]");
  });

  it("isParrotedReply detects replies that echo the instruction prompt", () => {
    expect(
      isParrotedReply(
        "[FACT]Group Title: the fact[/FACT]\nOutput ONLY the engine update blocks that apply.",
      ),
    ).toBe(true);
    expect(
      isParrotedReply(
        "[FACT]the fact[/FACT]\nYou are a strict structured-data extractor.",
      ),
    ).toBe(true);
    expect(
      isParrotedReply(
        '[RELATION]{"name": "Greta", "disposition": "Friendly merchant", "status": "Alive"}[/RELATION]',
      ),
    ).toBe(false);
  });

  it("does not flag a legitimate extraction that matches an example VALUE", () => {
    // The narrative was "buy dried herbs for 3 copper" — a correct extraction
    // naturally matches the example fact's wording. This is NOT parroting.
    const legit = [
      "[FACT]Oakhaven Market: Dried herbs cost 3 copper per bundle.[/FACT]",
      '[RELATION]{"name": "Greta", "disposition": "Friendly merchant", "status": "Alive"}[/RELATION]',
      '[TRANSACTION]{"id": "tx-1", "type": "buy", "itemName": "Dried Herbs", "amount": 3, "currency": "copper", "timestamp": "Monday, 07:00 AM", "partner": "Greta"}[/TRANSACTION]',
    ].join("\n");
    expect(isParrotedReply(legit)).toBe(false);
  });
});

describe("runStructuredFallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetState();
  });

  it("skips without calling the API when the turn already carries tags", async () => {
    const narrative = "[FACT]Oakhaven: herbs cost 3 copper.[/FACT] You buy herbs.";
    const result = await runStructuredFallback(narrative);
    expect(result).toBe(false);
    expect(mockGenerateResponse).not.toHaveBeenCalled();
  });

  it("recovers FACT and RELATION blocks from the follow-up reply", async () => {
    mockGenerateResponse.mockResolvedValue(
      '[FACT]Oakhaven Market: Moonflower petals cost 4 copper per bundle.[/FACT]\n' +
        '[RELATION]{"name": "Greta", "disposition": "Cheerful vendor", "status": "Alive"}[/RELATION]',
    );
    const spy = vi.spyOn(StorageModule, "autosave").mockImplementation(() => {});

    const result = await runStructuredFallback(
      "You buy a bundle of dried herbs for 3 copper. The herbalist smiles.",
    );

    expect(result).toBe(true);
    expect(mockGenerateResponse).toHaveBeenCalledTimes(1);
    const bundle = StateModule.state.memory.facts.find((b) => b.title === "Oakhaven Market");
    expect(bundle?.entries).toEqual(["Moonflower petals cost 4 copper per bundle."]);
    expect(StateModule.state.memory.relations[0].name).toBe("Greta");
    expect(spy).toHaveBeenCalled();
  });

  it("accepts a follow-up whose extraction matches the example values", async () => {
    // Live regression: the model correctly extracted a herb purchase whose
    // fact wording collides with the prompt example — the old parroted-gate
    // rejected it and threw away a good [TRANSACTION] too.
    mockGenerateResponse.mockResolvedValue(
      "[FACT]Oakhaven Market: Dried herbs cost 3 copper per bundle.[/FACT]\n" +
        '[RELATION]{"name": "Greta", "disposition": "Friendly merchant", "status": "Alive"}[/RELATION]\n' +
        '[TRANSACTION]{"id": "tx-1", "type": "buy", "itemName": "Dried Herbs", "amount": 3, "currency": "copper", "timestamp": "Monday, 07:00 AM", "partner": "Greta"}[/TRANSACTION]',
    );
    const spy = vi.spyOn(StorageModule, "autosave").mockImplementation(() => {});

    const result = await runStructuredFallback(
      "You buy a bundle of dried herbs for 3 copper. The herbalist smiles.",
    );

    expect(result).toBe(true);
    expect(StateModule.state.memory.relations[0].name).toBe("Greta");
    expect(StateModule.state.transactionLog.some((t) => t.itemName === "Dried Herbs")).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it("returns false when the follow-up reply also contains no tags", async () => {
    mockGenerateResponse.mockResolvedValue("Nothing changed, have a nice day.");
    const result = await runStructuredFallback("You buy a bundle of dried herbs for 3 copper.");
    expect(result).toBe(false);
    expect(StateModule.state.memory.facts).toEqual([]);
  });

  it("retries once when the first follow-up is tag-less but the second succeeds", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce("I should emit the blocks now.")
      .mockResolvedValueOnce(
        '[FACT]Mountain Road: Bandits head north toward a pass.[/FACT]\n' +
          '[RELATION]{"name": "Bandit Leader", "disposition": "Neutral", "status": "Alive"}[/RELATION]\n' +
          '[QUEST]{"id": "quest-pendant", "title": "Retrieve the Pendant", "description": "Recover the pendant", "type": "side", "status": "active", "objectives": [], "reward": "", "assignedBy": "Elder Li"}[/QUEST]',
      );
    const spy = vi.spyOn(StorageModule, "autosave").mockImplementation(() => {});

    const result = await runStructuredFallback("The elder gives you a quest to find the pendant.");

    expect(result).toBe(true);
    expect(mockGenerateResponse).toHaveBeenCalledTimes(2);
    expect(StateModule.state.memory.relations[0].name).toBe("Bandit Leader");
    expect(StateModule.state.quests[0].id).toBe("quest-pendant");
    expect(spy).toHaveBeenCalled();
  });

  it("discards a follow-up reply that parrots the instruction prompt", async () => {
    mockGenerateResponse.mockResolvedValue(
      "[FACT]Group Title: the fact[/FACT]\nOutput ONLY the engine update blocks that apply.",
    );
    const result = await runStructuredFallback("You buy a bundle of dried herbs for 3 copper.");
    expect(result).toBe(false);
    // No junk facts reached state.
    expect(StateModule.state.memory.facts).toEqual([]);
    expect(StateModule.state.memory.relations).toEqual([]);
  });

  it("never throws when the follow-up API call fails", async () => {
    mockGenerateResponse.mockRejectedValue(new Error("Local API Error 500"));
    const result = await runStructuredFallback("You buy a bundle of dried herbs for 3 copper.");
    expect(result).toBe(false);
    // The main narrative state is untouched.
    expect(LoreModule.lastIssues.length).toBe(0);
  });
});
