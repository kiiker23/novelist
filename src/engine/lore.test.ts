// =============================================================================
// lore.test.ts — Phase 1 parser behavior tests.
//
// Covers: tag stripping, valid + BROKEN STATE_UPDATE (must be skipped, not
// partially applied), FACT bundling + reset, structured [RELATION]{json},
// legacy relation fallback, and modifier coercion.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";

// Minimal document stub so UIManager render/notice calls (invoked by
// LoreModule) no-op in a DOM-free test run.
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

import { LoreModule, normalizeTags, repairConcatenatedArrays, cleanHistoryTags, stripThinkBlocks } from "./lore";
import { StateModule } from "../state/state";

describe("LoreModule.extract (Phase 1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    StateModule.state.memory = { facts: [], relations: [] };
    StateModule.state.toggles.memory = true;
    StateModule.state.char.health = 100;
    StateModule.state.char.maxHealth = 100;
    StateModule.state.char.str = 29;
    StateModule.state.char.inventory = [];
  });

  it("strips engine tags from the narrative shown to the player", () => {
    const raw = "You wake up.\n[FACT]General: It is raining.[/FACT]";
    expect(LoreModule.extract(raw)).toBe("You wake up.");
  });

  it("applies a valid STATE_UPDATE and clamps health to maxHealth", () => {
    LoreModule.extract('Ouch.[STATE_UPDATE]{"health": 250, "location": "Alley"}[/STATE_UPDATE]');
    expect(StateModule.state.char.health).toBe(100);
    expect(StateModule.state.worldState.location).toBe("Alley");
  });

  it("SKIPS a broken STATE_UPDATE without partially applying it", () => {
    StateModule.state.char.str = 29;
    // Malformed JSON (trailing comma + unquoted) -> must be skipped entirely.
    LoreModule.extract('[STATE_UPDATE]{"str": 999, "health": }[/STATE_UPDATE]');
    expect(StateModule.state.char.str).toBe(29); // unchanged
    expect(LoreModule.lastIssues.length).toBe(1);
    expect(LoreModule.lastIssues[0].kind).toBe("STATE_UPDATE");
  });

  it("rejects a STATE_UPDATE whose field has the wrong type", () => {
    // health as string fails the number schema -> whole block skipped.
    LoreModule.extract('[STATE_UPDATE]{"health": "lots"}[/STATE_UPDATE]');
    expect(StateModule.state.char.health).toBe(100);
    expect(LoreModule.lastIssues.length).toBe(1);
  });

  it("groups facts into bundles and clears on FACT_RESET", () => {
    LoreModule.extract("[FACT]Household: Poor.[/FACT]");
    LoreModule.extract("[FACT_RESET]Household[/FACT_RESET][FACT]Household: Stable.[/FACT]");
    const bundle = StateModule.state.memory.facts.find((b) => b.title === "Household");
    expect(bundle?.entries).toEqual(["Stable."]);
  });

  it("parses a structured [RELATION]{json} update", () => {
    LoreModule.extract(
      '[RELATION]{"name": "Elder Wu", "disposition": "Wary ally", "status": "Alive"}[/RELATION]',
    );
    const rel = StateModule.state.memory.relations[0];
    expect(rel.name).toBe("Elder Wu");
    expect(rel.disposition).toBe("Wary ally");
    expect(rel.status).toBe("Alive");
  });

  it("marks a structured relation deceased and coerces loose status text", () => {
    LoreModule.extract('[RELATION]{"name": "Bandit Leader", "status": "slain in battle"}[/RELATION]');
    expect(StateModule.state.memory.relations[0].status).toBe("Deceased");
  });

  it("parses structured modifiers with durations", () => {
    LoreModule.extract(
      '[RELATION]{"name": "Tavern Keeper", "disposition": "Cheerful", "modifiers": [{"name": "Drunk", "duration": 3}]}[/RELATION]',
    );
    expect(StateModule.state.memory.relations[0].modifiers[0]).toEqual({
      name: "Drunk",
      duration: 3,
    });
  });

  it("SKIPS a broken RELATION JSON block", () => {
    LoreModule.extract('[RELATION]{"name": }[/RELATION]');
    expect(StateModule.state.memory.relations.length).toBe(0);
    expect(LoreModule.lastIssues[0].kind).toBe("RELATION");
  });

  it("falls back to the LEGACY string relation format", () => {
    LoreModule.extract(
      "[RELATION]Old Merchant: Grumpy but fair. Status: Alive. Modifiers: Rage(2)[/RELATION]",
    );
    const rel = StateModule.state.memory.relations[0];
    expect(rel.name).toBe("Old Merchant");
    expect(rel.status).toBe("Alive");
    expect(rel.modifiers[0]).toEqual({ name: "Rage", duration: 2 });
  });

  it("merges an update onto an existing relation by fuzzy name match", () => {
    LoreModule.extract('[RELATION]{"name": "Elder Wu", "disposition": "Ally"}[/RELATION]');
    LoreModule.extract('[RELATION]{"name": "Wu", "status": "Deceased"}[/RELATION]');
    expect(StateModule.state.memory.relations.length).toBe(1);
    expect(StateModule.state.memory.relations[0].status).toBe("Deceased");
    expect(StateModule.state.memory.relations[0].disposition).toBe("Ally"); // preserved
  });

  it("merges an update that references an NPC by alias onto the existing relation", () => {
    LoreModule.extract(
      '[RELATION]{"name": "Mara", "disposition": "Friendly merchant", "status": "Alive", "aliases": ["Oakhaven Herbalist"]}[/RELATION]',
    );
    LoreModule.extract('[RELATION]{"name": "Oakhaven Herbalist", "disposition": "Warm"}[/RELATION]');
    const rels = StateModule.state.memory.relations;
    expect(rels.length).toBe(1);
    expect(rels[0].name).toBe("Mara");
    expect(rels[0].disposition).toBe("Warm");
  });

  it("replaces a same-name modifier's duration instead of duplicating it", () => {
    LoreModule.extract(
      '[RELATION]{"name": "Doran", "modifiers": [{"name": "Drunk", "duration": 3}]}[/RELATION]',
    );
    LoreModule.extract(
      '[RELATION]{"name": "Doran", "modifiers": [{"name": "Drunk", "duration": 5}]}[/RELATION]',
    );
    expect(StateModule.state.memory.relations[0].modifiers).toEqual([
      { name: "Drunk", duration: 5 },
    ]);
  });

  it("keeps distinct NPCs whose names share a prefix separate (fuzzy-match guard)", () => {
    LoreModule.extract('[RELATION]{"name": "Mara", "disposition": "Friendly merchant"}[/RELATION]');
    LoreModule.extract('[RELATION]{"name": "Marabel", "disposition": "Wary guard"}[/RELATION]');
    expect(StateModule.state.memory.relations.length).toBe(2);

    // Updating one must not collapse the other.
    LoreModule.extract('[RELATION]{"name": "Mara", "disposition": "Close friend"}[/RELATION]');
    const rels = StateModule.state.memory.relations;
    expect(rels.length).toBe(2);
    expect(rels.find((r) => r.name === "Mara")?.disposition).toBe("Close friend");
    expect(rels.find((r) => r.name === "Marabel")?.disposition).toBe("Wary guard");

    // The guard is order-independent: introducing "Mara" after "Marabel"
    // also creates a separate record.
    LoreModule.extract('[RELATION]{"name": "Kaelen", "disposition": "Farmer"}[/RELATION]');
    LoreModule.extract('[RELATION]{"name": "Kael", "disposition": "Hunter"}[/RELATION]');
    const names = StateModule.state.memory.relations.map((r) => r.name);
    expect(names).toContain("Kaelen");
    expect(names).toContain("Kael");
  });

  it("auto-closes an unclosed [FACT] (models like Qwythos forget closers)", () => {
    // No [/FACT] anywhere: normalizeTags must close it at end of text.
    const clean = LoreModule.extract(
      "You approach the gate.\n[FACT]Academy Gate: Guarded by an elder disciple.",
    );
    expect(clean).toBe("You approach the gate.");
    const bundle = StateModule.state.memory.facts.find((b) => b.title === "Academy Gate");
    expect(bundle?.entries).toEqual(["Guarded by an elder disciple."]);
  });

  it("auto-closes an unclosed [RELATION]{json} and still strips it", () => {
    const clean = LoreModule.extract(
      '[RELATION]{"name": "Elder Feng", "disposition": "Stern guardian", "status": "Alive"}',
    );
    expect(clean).toBe("");
    expect(StateModule.state.memory.relations[0].name).toBe("Elder Feng");
    expect(StateModule.state.memory.relations[0].disposition).toBe("Stern guardian");
  });

  it("closes adjacent unclosed tags without one swallowing the other", () => {
    const raw =
      "[FACT]Academy Gate: Guarded by an elder.\n[RELATION]{\"name\": \"Elder Feng\", \"disposition\": \"Stern\"}";
    const clean = LoreModule.extract(raw);
    expect(clean).toBe("");
    const bundle = StateModule.state.memory.facts.find((b) => b.title === "Academy Gate");
    expect(bundle?.entries).toEqual(["Guarded by an elder."]);
    expect(StateModule.state.memory.relations[0].name).toBe("Elder Feng");
  });

  it("auto-closes an unclosed [STATE_UPDATE] containing JSON arrays", () => {
    LoreModule.extract(
      '[STATE_UPDATE]{"time": "Monday, March 17, 07:10", "inventory": [{"name": "Iron Sword", "qty": 1}]}',
    );
    expect(StateModule.state.worldState.time).toBe("Monday, March 17, 07:10");
    expect(StateModule.state.char.inventory.some((i) => i.name === "Iron Sword")).toBe(true);
  });

  it("leaves properly closed tags untouched (regression)", () => {
    const raw = "You wake up.\n[FACT]General: It is raining.[/FACT]";
    expect(normalizeTags(raw)).toBe(raw);
    expect(LoreModule.extract(raw)).toBe("You wake up.");
  });

  it("closes only the trailing unclosed block when earlier ones are paired", () => {
    const raw = "[FACT]A: one.[/FACT]\n[FACT]B: two.";
    const clean = LoreModule.extract(raw);
    expect(clean).toBe("");
    const titles = StateModule.state.memory.facts.map((b) => b.title);
    expect(titles).toEqual(["A", "B"]);
    const b = StateModule.state.memory.facts.find((x) => x.title === "B");
    expect(b?.entries).toEqual(["two."]);
  });

  it("recovers a STATE_UPDATE whose closer has a stray slash (}/[STATE_UPDATE])", () => {
    // Qwythos wrote `}]}/[STATE_UPDATE]` instead of `}]}[/STATE_UPDATE]` —
    // the `}` is the JSON's own closing brace and the `/` before the tag is
    // the typo. Previously the whole block was skipped as invalid JSON.
    LoreModule.extract(
      '[STATE_UPDATE]{"health": 90, "time": "Monday, March 17, 16:35", "location": "Bridge", "inventory": [{"name": "Rope", "qty": 1}]}/[STATE_UPDATE]',
    );
    expect(StateModule.state.char.health).toBe(90);
    expect(StateModule.state.worldState.location).toBe("Bridge");
    expect(StateModule.state.char.inventory.some((i) => i.name === "Rope")).toBe(true);
    expect(LoreModule.lastIssues.length).toBe(0);
  });

  it("parses STATE_UPDATE JSON wrapped in markdown emphasis (Qwythos style)", () => {
    LoreModule.extract(
      '[STATE_UPDATE]** { "health": 95, "time": "Monday, March 17, 07:10", "location": "Town Square" } **[/STATE_UPDATE]',
    );
    expect(StateModule.state.char.health).toBe(95);
    expect(StateModule.state.worldState.time).toBe("Monday, March 17, 07:10");
    expect(StateModule.state.worldState.location).toBe("Town Square");
  });

  it("parses RELATION JSON wrapped in markdown emphasis", () => {
    LoreModule.extract(
      '[RELATION]**{"name": "Mara", "disposition": "Friendly merchant", "status": "Alive"}**[/RELATION]',
    );
    expect(StateModule.state.memory.relations[0].name).toBe("Mara");
    expect(StateModule.state.memory.relations[0].disposition).toBe("Friendly merchant");
  });

  // --- Concatenated / duplicated inventory arrays (Qwythos quirk) ---

  it("recovers a STATE_UPDATE with two concatenated inventory arrays", () => {
    // Qwythos closes the array and opens a fresh one instead of a comma:
    //   "inventory": [{...}],[{...}]
    LoreModule.extract(
      '[STATE_UPDATE]{"health": 88, "inventory": [{"name": "Small Pouch", "qty": 1},{"name": "Iron Sword", "qty": 1}] , [{"name": "Moonflower Petals", "qty": 2}]}[/STATE_UPDATE]',
    );
    expect(StateModule.state.char.health).toBe(88); // applied, not skipped
    const names = StateModule.state.char.inventory.map((i) => i.name);
    expect(names).toEqual(["Small Pouch", "Iron Sword", "Moonflower Petals"]);
    expect(LoreModule.lastIssues.length).toBe(0);
  });

  it("recovers concatenated arrays even without a separating comma", () => {
    // ...}]  [{...} — no comma at all.
    LoreModule.extract(
      '[STATE_UPDATE]{"location": "Alley", "inventory": [{"name": "Torch", "qty": 1}]  [{"name": "Rope", "qty": 3}]}[/STATE_UPDATE]',
    );
    expect(StateModule.state.worldState.location).toBe("Alley");
    const names = StateModule.state.char.inventory.map((i) => i.name);
    expect(names).toEqual(["Torch", "Rope"]);
    expect(StateModule.state.char.inventory[1].qty).toBe(3);
  });

  it("dedupes items repeated verbatim across merged arrays", () => {
    LoreModule.extract(
      '[STATE_UPDATE]{"inventory": [{"name": "Small Pouch", "qty": 1}] , [{"name": "Small Pouch", "qty": 1}]}[/STATE_UPDATE]',
    );
    expect(StateModule.state.char.inventory).toEqual([
      { name: "Small Pouch", qty: 1, desc: "", props: {} },
    ]);
  });

  it("still SKIPS the block when the concatenation repair does not yield valid JSON", () => {
    StateModule.state.char.str = 29;
    // Concatenated arrays exist, but merging cannot fix the broken scalar.
    LoreModule.extract(
      '[STATE_UPDATE]{"str": , "inventory": [{"name": "A", "qty": 1}] , [{"name": "B", "qty": 1}]}[/STATE_UPDATE]',
    );
    expect(StateModule.state.char.str).toBe(29); // untouched
    expect(StateModule.state.char.inventory.length).toBe(0);
    expect(LoreModule.lastIssues.length).toBe(1);
    expect(LoreModule.lastIssues[0].kind).toBe("STATE_UPDATE");
  });

  it("repairConcatenatedArrays leaves valid JSON untouched", () => {
    expect(repairConcatenatedArrays('{"health": 90}')).toBeNull();
    expect(repairConcatenatedArrays('{"inventory": [{"name": "A", "qty": 1}]}')).toBeNull();
  });

  it("repairConcatenatedArrays merges concatenated arrays and rejects unfixable input", () => {
    expect(
      repairConcatenatedArrays('{"inventory": [{"name": "A"}] , [{"name": "B"}]}'),
    ).toBe('{"inventory": [{"name": "A"},{"name": "B"}]}');
    expect(repairConcatenatedArrays('{"inventory": [{"name": "A"}]  [{"name": "B"}]}')).toBe(
      '{"inventory": [{"name": "A"},{"name": "B"}]}',
    );
    expect(repairConcatenatedArrays('{"str": , "inventory": [1],[2]}')).toBeNull();
  });

  // --- Load-time cleanup of previously stored history entries ---

  it("strips leaked unclosed tags from stored assistant history on load", () => {
    const history = [
      { role: "assistant", content: "You approach the gate.\n[FACT]Academy Gate: Guarded by an elder disciple." },
      { role: "user", content: "I knock on the gate." },
    ];
    const cleaned = cleanHistoryTags(history);
    expect(cleaned).toBe(1); // only the assistant message was modified
    expect(history[0].content).toBe("You approach the gate.");
    expect(history[1].content).toBe("I knock on the gate."); // user text untouched
  });

  it("cleans multiple leaked blocks in one stored message (Qwythos style)", () => {
    const history = [
      {
        role: "assistant",
        content:
          "The herbalist smiles.\n[RELATION]{\"name\": \"Greta\", \"disposition\": \"Friendly\"}\n[STATE_UPDATE]{\"health\": 90}",
      },
    ];
    const cleaned = cleanHistoryTags(history);
    expect(cleaned).toBe(1);
    expect(history[0].content).toBe("The herbalist smiles.");
  });

  it("strips properly closed tags from stored history too", () => {
    const history = [{ role: "assistant", content: "Ouch.[STATE_UPDATE]{\"health\": 80}[/STATE_UPDATE]" }];
    expect(cleanHistoryTags(history)).toBe(1);
    expect(history[0].content).toBe("Ouch.");
  });

  it("leaves clean messages and non-assistant roles untouched", () => {
    const history = [
      { role: "assistant", content: "The morning air is crisp." },
      { role: "user", content: "I head to the market." },
      { role: "assistant", content: "" },
    ];
    expect(cleanHistoryTags(history)).toBe(0);
    expect(history.map((m) => m.content)).toEqual([
      "The morning air is crisp.",
      "I head to the market.",
      "",
    ]);
  });

  it("strips think blocks from stored history too", () => {
    const history = [
      { role: "assistant", content: "Dawn.<think>Plan: update clock.</think>[STATE_UPDATE]{\"time\": \"Tuesday, June 16, 09:00\"}[/STATE_UPDATE]" },
    ];
    expect(cleanHistoryTags(history)).toBe(1);
    expect(history[0].content).toBe("Dawn.");
  });

  it("strips [MEMORY_REF] citations from stored history and display text", () => {
    const history = [
      { role: "assistant", content: "You bow again. [MEMORY_REF]am_spar[/MEMORY_REF]" },
    ];
    expect(cleanHistoryTags(history)).toBe(1);
    expect(history[0].content).toBe("You bow again.");
    expect(LoreModule.stripTags("Rematch. [MEMORY_REF]am_spar[/MEMORY_REF]")).toBe("Rematch.");
  });
});

describe("stripThinkBlocks", () => {
  it("removes a closed <think> block, keeping surrounding text", () => {
    expect(stripThinkBlocks("Narrative. <think>I need to plan the scene.</think> More story.")).toBe(
      "Narrative.  More story.",
    );
  });

  it("handles <thinking> and <reasoning> variants", () => {
    expect(stripThinkBlocks("A. <thinking>draft</thinking> B.")).toBe("A.  B.");
    expect(stripThinkBlocks("A. <reasoning>draft</reasoning> B.")).toBe("A.  B.");
  });

  it("removes multiple blocks", () => {
    expect(
      stripThinkBlocks("A.<think>one</think>B.<think>two</think>C."),
    ).toBe("A.B.C.");
  });

  it("is case-insensitive", () => {
    expect(stripThinkBlocks("A. <THINK>plan</THINK> B.")).toBe("A.  B.");
  });

  it("leaves an unclosed <think> untouched (narrative must not be swallowed)", () => {
    const raw = "Dawn breaks. <think>The model forgot to close this block but the story continues here.";
    expect(stripThinkBlocks(raw)).toBe(raw);
  });

  it("drops a stray closing tag with no opener", () => {
    expect(stripThinkBlocks("The plan was set. </think> The first month of spring is a blur.")).toBe(
      "The plan was set.  The first month of spring is a blur.",
    );
    expect(stripThinkBlocks("A. </thinking> B.</reasoning> C.")).toBe("A.  B. C.");
  });

  it("leaves text without think blocks unchanged", () => {
    const raw = "The morning mist parts over the training grounds.";
    expect(stripThinkBlocks(raw)).toBe(raw);
    expect(stripThinkBlocks("")).toBe("");
  });

  it("ignores STATE_UPDATE drafts inside <think> while applying the real block outside", () => {
    const raw =
      'The dawn breaks. <think>Draft: [STATE_UPDATE]{"str": 99, "time": "Monday, March 17, 23:00"}[/STATE_UPDATE] which is wrong.</think> [STATE_UPDATE]{"str": 12, "time": "Tuesday, June 16, 09:00"}[/STATE_UPDATE]';
    const clean = LoreModule.extract(raw);
    expect(clean).not.toContain("think");
    expect(StateModule.state.char.str).toBe(12);
    expect(StateModule.state.worldState.time).toBe("Tuesday, June 16, 09:00");
    // The think-block draft never reached the parser — no issues at all.
    expect(LoreModule.lastIssues.length).toBe(0);
  });
});

describe("applyRelationUpdate — name discovery merge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    StateModule.state.memory = { facts: [], relations: [] };
    StateModule.state.npcProfiles = [];
    StateModule.state.toggles.memory = true;
    StateModule.state.toggles.npcDepth = true;
  });

  it("renames a role-titled entry when the AI discovers the real name via an alias", () => {
    // Seed a role-titled mother the way the backstory seeder does.
    LoreModule.applyRelationUpdate({ name: "Mother", disposition: "MC's mother", status: "Alive" });
    const renamed = LoreModule.applyRelationUpdate({
      name: "Diane",
      aliases: ["Mother"],
      disposition: "Diner waitress",
    });
    expect(renamed).toBe(false); // merged in place, NOT created
    expect(StateModule.state.memory.relations).toHaveLength(1);
    const diane = StateModule.state.memory.relations[0];
    expect(diane.name).toBe("Diane");
    expect(diane.aliases).toContain("Mother");
    expect(diane.disposition).toBe("Diner waitress");
    // The NPC profile follows the rename so the person stays in the living view.
    expect(StateModule.state.npcProfiles).toHaveLength(1);
    expect(StateModule.state.npcProfiles[0].npcName).toBe("Diane");
  });

  it("keeps the more specific existing name when the update name is just a fragment", () => {
    LoreModule.applyRelationUpdate({ name: "Elder Wu", disposition: "Merchant" });
    LoreModule.applyRelationUpdate({ name: "Wu", aliases: ["Elder Wu"], disposition: "Friendly" });
    expect(StateModule.state.memory.relations).toHaveLength(1);
    expect(StateModule.state.memory.relations[0].name).toBe("Elder Wu");
  });

  it("promotes an alias to the primary name when the update names the alias and carries the old primary", () => {
    // Named seeding: entry is "Diane" with role alias "Mother".
    LoreModule.applyRelationUpdate({
      name: "Diane",
      aliases: ["Mother"],
      disposition: "MC's mother",
      status: "Alive",
    });
    const promoted = LoreModule.applyRelationUpdate({
      name: "Mother",
      aliases: ["Diane"],
      disposition: "Exhausted from the late shift",
    });
    expect(promoted).toBe(false); // merged in place, NOT created
    expect(StateModule.state.memory.relations).toHaveLength(1);
    const rel = StateModule.state.memory.relations[0];
    expect(rel.name).toBe("Mother");
    // The old primary survives as an alias and the trail is intact.
    expect(rel.aliases).toEqual(["Diane"]);
    expect(rel.aliases).not.toContain("Mother"); // no "aka Mother" next to Mother
    expect(rel.disposition).toBe("Exhausted from the late shift");
    // The NPC profile follows the rename so the person stays in the living view.
    expect(StateModule.state.npcProfiles).toHaveLength(1);
    expect(StateModule.state.npcProfiles[0].npcName).toBe("Mother");
  });

  it("does NOT promote when the update name still matches the primary name", () => {
    LoreModule.applyRelationUpdate({
      name: "Diane",
      aliases: ["Mother"],
      disposition: "MC's mother",
      status: "Alive",
    });
    // The AI re-states the same canonical name with the same alias list —
    // nothing should be renamed or duplicated.
    LoreModule.applyRelationUpdate({
      name: "Diane",
      aliases: ["Mother"],
      disposition: "Exhausted from the late shift",
    });
    expect(StateModule.state.memory.relations).toHaveLength(1);
    const rel = StateModule.state.memory.relations[0];
    expect(rel.name).toBe("Diane");
    expect(rel.aliases).toEqual(["Mother"]);
    expect(rel.disposition).toBe("Exhausted from the late shift");
    expect(StateModule.state.npcProfiles[0].npcName).toBe("Diane");
  });

  it("refreshes the NPC profile name when the promoted alias replaces the primary", () => {
    // Profile exists under the primary name; the promotion renames it too.
    LoreModule.applyRelationUpdate({
      name: "Diane",
      aliases: ["Mother"],
      disposition: "MC's mother",
      status: "Alive",
    });
    // Add a second NPC to prove only the promoted one is renamed.
    LoreModule.applyRelationUpdate({ name: "Lily", disposition: "MC's sister", status: "Alive" });
    LoreModule.applyRelationUpdate({
      name: "Mother",
      aliases: ["Diane"],
      disposition: "Exhausted from the late shift",
    });
    const names = StateModule.state.npcProfiles.map((p) => p.npcName);
    expect(names).toContain("Mother");
    expect(names).not.toContain("Diane");
    expect(names).toContain("Lily");
    expect(StateModule.state.npcProfiles).toHaveLength(2);
  });
});
