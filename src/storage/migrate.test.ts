// =============================================================================
// migrate.test.ts - Versioned save migration tests.
// =============================================================================

import { describe, it, expect } from "vitest";
import { migrate } from "./migrate";
import { SCHEMA_VERSION } from "../state/GameState";

describe("migrate", () => {
  it("upgrades an unversioned (v0) save to the current version", () => {
    const raw = { setup: {}, char: { name: "MC" } };
    const result = migrate(raw as any);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(SCHEMA_VERSION);
    expect(result.migrated).toBe(false);
    expect(result.state.version).toBe(SCHEMA_VERSION);
  });

  it("converts a legacy array `memory` into { facts, relations }", () => {
    const raw = { setup: {}, char: { name: "MC" }, memory: ["A fact", "Another"] };
    const { state } = migrate(raw as any);
    expect(state.memory.facts[0].title).toBe("General Facts");
    expect(state.memory.facts[0].entries).toEqual(["A fact", "Another"]);
    expect(state.memory.relations).toEqual([]);
  });

  it("converts a flat string[] facts list into nested bundles", () => {
    const raw = {
      setup: {},
      char: { name: "MC" },
      memory: { facts: ["Old fact"], relations: [] },
    };
    const { state } = migrate(raw as any);
    expect(state.memory.facts[0].entries).toEqual(["Old fact"]);
  });

  it("backfills missing containers (modifiers, inventory, worldState, history)", () => {
    const raw = { setup: {}, char: { name: "MC" } };
    const { state } = migrate(raw as any);
    expect(state.modifiers).toEqual({});
    expect(state.char.inventory).toEqual([]);
    expect(state.worldState.measurement).toBe("Metric");
    expect(Array.isArray(state.history)).toBe(true);
  });

  it("normalizes legacy string directorNotes into DirectorNote objects", () => {
    const raw = {
      setup: {},
      char: { name: "MC" },
      directorNotes: ["The realm opens in 2 days.", "A noble declares a tournament."],
    };
    const { state } = migrate(raw as any);
    expect(state.turnCount).toBe(0);
    expect(state.directorNotes.length).toBe(2);
    expect(state.directorNotes[0].text).toBe("The realm opens in 2 days.");
    expect(state.directorNotes[0].id).toMatch(/^dn_/);
    expect(state.directorNotes[0].fired).toBe(false);
    expect(state.directorNotes[0].createdAtTurn).toBe(0);
  });

  it("leaves already-typed directorNotes untouched", () => {
    const raw = {
      setup: {},
      char: { name: "MC" },
      turnCount: 7,
      directorNotes: [
        { id: "dn_x", text: "Event.", createdAtTurn: 2, fired: false, deadlineMinutes: 2880 },
      ],
    };
    const { state } = migrate(raw as any);
    expect(state.directorNotes[0].id).toBe("dn_x");
    expect(state.directorNotes[0].deadlineMinutes).toBe(2880);
  });

  it("normalizes legacy relations to the current field shape", () => {
    const raw = {
      setup: {},
      char: { name: "MC" },
      memory: { facts: [], relations: [{ name: "Guard", status: "Deceased" }] },
    };
    const { state } = migrate(raw as any);
    const rel = state.memory.relations[0];
    expect(rel.aliases).toEqual([]);
    expect(rel.disposition).toBe("");
    expect(rel.status).toBe("Deceased");
    expect(rel.modifiers).toEqual([]);
  });

  it("preserves reaction system lines in history through a v4->v5 migration", () => {
    const raw = {
      version: 4,
      setup: { location: "MC Bedroom" },
      char: { name: "Lin Hao", inventory: [] },
      memory: { facts: [], relations: [] },
      modifiers: {},
      history: [
        { role: "user", content: "I cook dinner for my sister." },
        { role: "system", content: "⏰ EVENT NOW: The realm opens NOW." },
        { role: "system", content: "Lin Mei reacts warmly — Affection +6, Trust +4" },
        { role: "assistant", content: "The kitchen smells of garlic." },
      ],
    };
    const { state, fromVersion, migrated } = migrate(raw as any);
    expect(fromVersion).toBe(4);
    expect(migrated).toBe(true);
    expect(state.version).toBe(SCHEMA_VERSION);
    // The v4->v5 patch adds npcProfiles/timeStates/giftLog and converts
    // relations, but must leave the chat history — the fired-event and
    // reaction system lines included — untouched and in order.
    expect(state.history).toEqual([
      { role: "user", content: "I cook dinner for my sister." },
      { role: "system", content: "⏰ EVENT NOW: The realm opens NOW." },
      { role: "system", content: "Lin Mei reacts warmly — Affection +6, Trust +4" },
      { role: "assistant", content: "The kitchen smells of garlic." },
    ]);
  });

  it("backfills checkLog and checkMomentum on pre-framework saves", () => {
    // A save at the current schema version but written before the stat-check
    // framework existed: migration must add empty containers so momentum
    // lookups never hit undefined.
    const raw = {
      version: SCHEMA_VERSION,
      setup: {},
      char: { name: "MC", inventory: [] },
      memory: { facts: [], relations: [] },
      modifiers: {},
      worldState: { time: "t", location: "l", measurement: "Metric" },
      history: [],
    };
    const { state } = migrate(raw as any);
    expect(state.checkLog).toEqual([]);
    expect(state.checkMomentum).toEqual({});
    expect(state.checkEscalation).toEqual({});
    expect(state.lastFailedCheck).toBeNull();
    expect(state.actionMemory).toEqual([]);
  });

  it("seeds action memory from the persisted check log on pre-memory saves", () => {
    // A save that predates the action-memory feature: it has resolved checks
    // (yesterday's sparring, escapes, negotiations) but no memory log. On
    // load, those checks become the AI's durable memory so it can compare
    // today's actions against them.
    const raw = {
      version: SCHEMA_VERSION,
      setup: {},
      char: { name: "Lin Hao", inventory: [] },
      memory: { facts: [], relations: [] },
      modifiers: {},
      worldState: { time: "Monday, March 17, 08:20", location: "Dojo", measurement: "Metric" },
      history: [],
      checkLog: [
        {
          turn: 6,
          stat: "STR",
          difficulty: "hard",
          outcome: "major_success",
          context: "arm-wrestling Rook",
        },
        {
          turn: 7,
          stat: "CHA",
          difficulty: "moderate",
          outcome: "minor_failure",
          context: "convincing the guard",
        },
      ],
    };
    const { state } = migrate(raw as any);
    expect(state.actionMemory).toHaveLength(2);
    expect(state.actionMemory[0]).toMatchObject({
      summary: "arm-wrestling Rook",
      category: "combat",
      intensity: 80,
      outcome: "major success (STR hard)",
      turn: 6,
    });
    expect(state.actionMemory[1]).toMatchObject({
      summary: "convincing the guard",
      category: "social",
      intensity: 45,
      outcome: "minor failure (CHA moderate)",
    });
  });

  it("backfills economic milestones from the persisted chat history so trades survive restarts", () => {
    // A save where the MC traded crypto 20 turns ago: the trades live ONLY in
    // the chat prose (the model never emitted [TRANSACTION] tags for them),
    // which is exactly why the AI later claimed "first time". On load the
    // history is scanned and the economic actions become durable memory.
    const raw = {
      version: SCHEMA_VERSION,
      setup: {},
      char: { name: "Lin Hao", inventory: [] },
      memory: { facts: [], relations: [] },
      modifiers: {},
      worldState: { time: "Monday, March 17, 08:20", location: "School", measurement: "Metric" },
      checkLog: [],
      history: [
        { role: "user", content: "I open the crypto trading platform and use all 547.50 USD to trade." },
        { role: "assistant", content: "The exchange churns; your position climbs to 847.50 USD." },
        { role: "user", content: "Gambling and extorting others are too risky — I stick to the marketplace." },
        { role: "assistant", content: "You browse the collectibles marketplace for an hour." },
      ],
    };
    const { state } = migrate(raw as any);
    const econ = state.actionMemory.filter((e: any) => e.category === "economy");
    // The real trades are remembered with amounts (no "first time" possible).
    expect(econ.some((e: any) => e.summary.includes("Traded crypto") && e.summary.includes("547.50"))).toBe(true);
    // Browsing the marketplace is a lighter memory, not a sale.
    expect(econ.some((e: any) => e.summary.includes("Browsed the marketplace"))).toBe(true);
    // The PLAN to gamble/extort is NOT a memory — no "Gambled" entry.
    expect(econ.some((e: any) => e.summary.includes("Gambled"))).toBe(false);
    // Idempotent: migrating the migrated state adds no duplicates.
    const { state: state2 } = migrate({ ...state, version: SCHEMA_VERSION } as any);
    expect(state2.actionMemory.length).toBe(state.actionMemory.length);
  });

  it("backfills narration-only NPC reactions from history so social moments survive restarts", () => {
    // The AI described Nina's warm reaction purely in prose (no reaction tag,
    // no [MEMORY]) — without this backfill the save would forget it entirely.
    const raw = {
      version: SCHEMA_VERSION,
      setup: {},
      char: { name: "Lin Hao", inventory: [] },
      memory: {
        facts: [],
        relations: [{ name: "Nina", aliases: [], disposition: "Classmate", status: "Alive", modifiers: [] }],
      },
      npcProfiles: [{ npcName: "Nina" }],
      modifiers: {},
      worldState: { time: "Monday, March 17, 11:00", location: "School", measurement: "Metric" },
      checkLog: [],
      history: [
        { role: "user", content: "I give Nina a small gift." },
        { role: "assistant", content: "Nina reacts warmly to the gift, her eyes lighting up." },
      ],
    };
    const { state } = migrate(raw as any);
    const entry = state.actionMemory.find((e: any) => e.summary.includes("Nina reacts warmly"));
    expect(entry).toMatchObject({
      npc: "Nina",
      category: "social",
      outcome: "warm reaction",
      turn: 0,
    });
    // Idempotent — migrating again adds nothing.
    const { state: state2 } = migrate({ ...state, version: SCHEMA_VERSION } as any);
    expect(state2.actionMemory.length).toBe(state.actionMemory.length);
  });

  it("backfills the persisted transaction log into action memory so recorded buys/sells survive", () => {
    // The engine recorded these transactions (via [TRANSACTION] tags or the
    // structured fallback), but the save predates the transaction-memory
    // harvest — reconciliation on load makes them durable memories.
    const raw = {
      version: SCHEMA_VERSION,
      setup: {},
      char: { name: "Lin Hao", inventory: [] },
      memory: { facts: [], relations: [] },
      modifiers: {},
      worldState: { time: "Monday, March 17, 11:00", location: "School", measurement: "Metric" },
      checkLog: [],
      history: [{ role: "user", content: "I shop around." }],
      transactionLog: [
        { id: "tx-herbs", type: "buy", itemName: "Dried Herbs", amount: 3, currency: "Copper", partner: "Greta" },
        { id: "tx-reward", type: "reward", itemName: "System Points", amount: 120, currency: "systemPoints", partner: "Mother" },
      ],
    };
    const { state } = migrate(raw as any);
    const econ = state.actionMemory.filter((e: any) => e.category === "economy");
    expect(econ.some((e: any) => e.summary === "Bought Dried Herbs from Greta" && e.outcome === "for 3 Copper")).toBe(true);
    expect(econ.some((e: any) => e.summary === "Rewarded with System Points from Mother" && e.outcome === "for 120 systemPoints")).toBe(true);
    // Idempotent — migrating again adds nothing.
    const { state: state2 } = migrate({ ...state, version: SCHEMA_VERSION } as any);
    expect(state2.actionMemory.length).toBe(state.actionMemory.length);
  });

  it("backfills currency-balance history from the transaction log (Spent/Earned N currency)", () => {
    // The save predates the state-delta diff, so the item transactions were
    // never accompanied by the balance-level story — "Spent 3 Copper",
    // "Earned 120 systemPoints" — that the live harvest step 9 produces.
    const raw = {
      version: SCHEMA_VERSION,
      setup: {},
      char: { name: "Lin Hao", inventory: [] },
      memory: { facts: [], relations: [] },
      modifiers: {},
      worldState: { time: "Monday, March 17, 11:00", location: "School", measurement: "Metric" },
      checkLog: [],
      history: [{ role: "user", content: "I buy herbs and get rewarded." }],
      transactionLog: [
        { id: "tx-herbs", type: "buy", itemName: "Dried Herbs", amount: 3, currency: "Copper", partner: "Greta", timestamp: "Monday, March 17, 10:00" },
        { id: "tx-sell", type: "sell", itemName: "Iron Sword", amount: 40, currency: "Copper", partner: "Market", timestamp: "Monday, March 17, 10:15" },
        { id: "tx-reward", type: "reward", itemName: "System Points", amount: 120, currency: "systemPoints", partner: "Mother" },
      ],
    };
    const { state } = migrate(raw as any);
    const econ = state.actionMemory.filter((e: any) => e.category === "economy");
    // Balance movements mirror the live harvest: spent on buy, earned on
    // sell/reward, with the same summaries/outcomes/intensities.
    expect(econ.some((e: any) => e.summary === "Spent 3 Copper" && e.outcome === "Copper -3")).toBe(true);
    expect(econ.some((e: any) => e.summary === "Earned 40 Copper" && e.outcome === "Copper +40" && e.intensity === 35)).toBe(true);
    expect(econ.some((e: any) => e.summary === "Earned 120 systemPoints" && e.outcome === "systemPoints +120")).toBe(true);
    // The item-level memories are still there too (both sides of the story).
    expect(econ.some((e: any) => e.summary === "Bought Dried Herbs from Greta" && e.outcome === "for 3 Copper")).toBe(true);
    // The transaction's own timestamp wins over the save's current time.
    const spent = econ.find((e: any) => e.summary === "Spent 3 Copper");
    expect(spent && spent.time).toBe("Monday, March 17, 10:00");
    // Idempotent — migrating again adds nothing.
    const { state: state2 } = migrate({ ...state, version: SCHEMA_VERSION } as any);
    expect(state2.actionMemory.length).toBe(state.actionMemory.length);
  });

  it("backfills sceneLog and enables descriptiveScenes on pre-module saves", () => {
    const raw = {
      version: 4,
      setup: { location: "MC Bedroom" },
      char: { name: "Lin Hao", inventory: [] },
      memory: { facts: [], relations: [] },
      toggles: {
        mcInfo: true,
        statChecks: true,
        health: true,
        subskills: true,
        time: true,
        memory: true,
        quests: true,
        equipment: true,
        economy: true,
        xp: true,
        npcDepth: true,
      },
      history: [],
    };
    const { state } = migrate(raw as any);
    expect(state.sceneLog).toEqual({});
    expect(state.toggles.descriptiveScenes).toBe(true);
    expect(state.toggles.schedules).toBe(true);
  });

  it("respects an explicit toggle-off instead of force-enabling modules", () => {
    const raw = {
      version: 4,
      setup: { location: "MC Bedroom" },
      char: { name: "Lin Hao", inventory: [] },
      memory: { facts: [], relations: [] },
      toggles: { descriptiveScenes: false, schedules: false },
      history: [],
    };
    const { state } = migrate(raw as any);
    expect(state.toggles.descriptiveScenes).toBe(false);
    expect(state.toggles.schedules).toBe(false);
  });

  it("preserves an existing sceneLog through migration, normalizing string entries", () => {
    const raw = {
      version: 4,
      setup: { location: "MC Bedroom" },
      char: { name: "Lin Hao", inventory: [] },
      memory: { facts: [], relations: [] },
      toggles: {},
      sceneLog: { "mc bedroom": "A single bed and a study desk with a laptop." },
      history: [],
    };
    const { state } = migrate(raw as any);
    // Pre-ambient saves stored plain strings; they upgrade to SceneEntry objects.
    expect(state.sceneLog["mc bedroom"]).toEqual({
      description: "A single bed and a study desk with a laptop.",
    });
    expect(state.toggles.descriptiveScenes).toBe(true);
  });

  it("keeps structured ambient entries untouched through migration", () => {
    const raw = {
      version: 4,
      setup: { location: "High School" },
      char: { name: "Lin Hao", inventory: [] },
      memory: { facts: [], relations: [] },
      toggles: {},
      sceneLog: {
        "high school": {
          description: "The schoolyard is nearly empty.",
          weather: "cold drizzle",
        },
      },
      history: [],
    };
    const { state } = migrate(raw as any);
    expect(state.sceneLog["high school"]).toEqual({
      description: "The schoolyard is nearly empty.",
      weather: "cold drizzle",
    });
  });

  it("leaves an already-current save unchanged (migrated=false)", () => {
    const raw = {
      version: SCHEMA_VERSION,
      setup: {},
      char: { name: "MC", inventory: [] },
      memory: { facts: [], relations: [] },
      modifiers: {},
      worldState: { time: "t", location: "l", measurement: "Metric" },
      history: [],
    };
    const result = migrate(raw as any);
    expect(result.migrated).toBe(false);
  });
});
