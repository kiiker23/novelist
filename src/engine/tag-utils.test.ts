// =============================================================================
// tag-utils.test.ts — Qwythos output-quirk recovery across engine parsers.
//
// Small local models wrap JSON payloads in markdown emphasis (`**{...}**`),
// concatenate two arrays (`[...],[...]`) instead of one, or append units to
// numeric tags ("50 XP"). Every engine-tag JSON parser should recover from
// these instead of skipping the whole block. This suite drives each module's
// real extract() with the quirked input and asserts the state landed.
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";

// Minimal document stub so UIManager render/notice calls (invoked by every
// extractor) no-op in a DOM-free test run.
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
  unwrapJsonBlock,
  repairConcatenatedArrays,
  safeParseJsonBlock,
  extractNumber,
} from "./tag-utils";
import { QuestSchema, EquippedItemSchema } from "../state/schema";
import { QuestModule } from "./quest";
import { EquipmentModule } from "./equipment";
import { EconomyModule } from "./economy";
import { XpModule } from "./xp";
import { NPCProfileModule } from "./npc-profile";
import { TimeStateModule } from "./time-states";
import { GiftModule } from "./gifts";
import { CultivationModule } from "./cultivation";
import { StateModule } from "../state/state";

describe("tag-utils helpers", () => {
  it("unwrapJsonBlock strips markdown emphasis and code fences", () => {
    expect(unwrapJsonBlock("**{ \"health\": 90 }**")).toBe('{ "health": 90 }');
    expect(unwrapJsonBlock("```json\n{\"health\": 90}\n```")).toBe('{"health": 90}');
    expect(unwrapJsonBlock("** {\"a\": 1} **")).toBe('{"a": 1}');
  });

  it("repairConcatenatedArrays merges adjacent arrays and returns null for valid JSON", () => {
    expect(repairConcatenatedArrays('{"a": [1] , [2]}')).toBe('{"a": [1,2]}');
    expect(repairConcatenatedArrays('{"a": [1]  [2]}')).toBe('{"a": [1,2]}');
    expect(repairConcatenatedArrays('{"a": 1}')).toBeNull();
  });

  it("safeParseJsonBlock unwraps then repairs in one call", () => {
    const ok = safeParseJsonBlock(
      QuestSchema,
      '**{"id": "q1", "title": "T", "description": "D", "objectives": [{"description": "A"}] , [{"description": "B"}]}**',
    );
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.data) {
      expect(ok.data.objectives).toHaveLength(2);
    }
  });

  it("safeParseJsonBlock still reports failure on unfixable JSON", () => {
    const bad = safeParseJsonBlock(EquippedItemSchema, '**{"slot": }**');
    expect(bad.ok).toBe(false);
  });

  it("extractNumber pulls a number out of loose payloads", () => {
    expect(extractNumber("50")).toBe(50);
    expect(extractNumber("+50")).toBe(50);
    expect(extractNumber("50 XP")).toBe(50);
    expect(extractNumber("**50**")).toBe(50);
    expect(extractNumber("fifty")).toBeNull();
  });
});

describe("QuestModule recovery (Qwythos quirks)", () => {
  beforeEach(() => {
    StateModule.state.quests = [];
  });

  it("parses a [QUEST] block wrapped in markdown emphasis", () => {
    QuestModule.extract(
      '[QUEST]**{"id": "q1", "title": "Find the Pendant", "description": "Recover the stolen jade.", "type": "main", "objectives": [{"description": "Reach the camp"}]}**[/QUEST]',
    );
    const q = StateModule.state.quests.find((x) => x.id === "q1");
    expect(q?.title).toBe("Find the Pendant");
    expect(q?.objectives[0].description).toBe("Reach the camp");
  });

  it("recovers from two concatenated objectives arrays", () => {
    QuestModule.extract(
      '[QUEST]{"id": "q2", "title": "Two Tasks", "description": "Do the things.", "objectives": [{"description": "First"}] , [{"description": "Second"}]}[/QUEST]',
    );
    const q = StateModule.state.quests.find((x) => x.id === "q2");
    expect(q?.objectives.map((o) => o.description)).toEqual(["First", "Second"]);
  });
});

describe("EquipmentModule recovery", () => {
  beforeEach(() => {
    StateModule.state.equipped = [];
  });

  it("parses an [EQUIPMENT] block wrapped in markdown emphasis", () => {
    EquipmentModule.extract(
      '[EQUIPMENT]**{"itemId": "sword-1", "name": "Iron Sword", "slot": "weapon", "rarity": "uncommon", "stats": {"str": 2}, "desc": "A solid blade."}**[/EQUIPMENT]',
    );
    const item = StateModule.state.equipped.find((e) => e.itemId === "sword-1");
    expect(item?.name).toBe("Iron Sword");
    expect(item?.equipped).toBe(true);
    expect(item?.stats.str).toBe(2);
  });
});

describe("EconomyModule recovery", () => {
  beforeEach(() => {
    StateModule.state.currencies = [{ name: "Copper", amount: 10, props: {} }];
    StateModule.state.transactionLog = [];
  });

  it("parses a [TRANSACTION] block wrapped in markdown emphasis", () => {
    EconomyModule.extract(
      '[TRANSACTION]**{"id": "tx1", "type": "buy", "itemName": "Moonflower Petals", "amount": 3, "currency": "Copper", "timestamp": "2026-08-11T10:00:00Z", "partner": "Greta"}**[/TRANSACTION]',
    );
    const tx = StateModule.state.transactionLog.find((t) => t.id === "tx1");
    expect(tx?.itemName).toBe("Moonflower Petals");
    expect(StateModule.state.currencies[0].amount).toBe(7); // 10 - 3
  });
});

describe("XpModule recovery", () => {
  beforeEach(() => {
    StateModule.state.char.xp = 0;
    StateModule.state.char.level = 1;
    StateModule.state.char.skillPoints = 0;
    StateModule.state.char.learnedSkills = [];
  });

  it.each([
    "[XP_GAIN]50[/XP_GAIN]",
    "[XP_GAIN]+50[/XP_GAIN]",
    "[XP_GAIN]50 XP[/XP_GAIN]",
    "[XP_GAIN]**50**[/XP_GAIN]",
  ])("awards XP from a loose payload: %s", (tag) => {
    XpModule.extract(`You grow stronger. ${tag}`);
    expect(StateModule.state.char.xp).toBe(50);
  });
});

describe("CultivationModule recovery", () => {
  beforeEach(() => {
    StateModule.state.char.cultivation = 0;
    StateModule.state.char.breakthroughs = [];
  });

  it("applies a [CULTIVATION_CHANGE] wrapped in markdown emphasis", () => {
    CultivationModule.extract("[CULTIVATION_CHANGE]**+0.5**[/CULTIVATION_CHANGE]");
    expect(StateModule.state.char.cultivation).toBe(0.5);
  });

  it("applies a signed [CULTIVATION_CHANGE] with a trailing label", () => {
    CultivationModule.extract("[CULTIVATION_CHANGE]+0.2 tier[/CULTIVATION_CHANGE]");
    expect(StateModule.state.char.cultivation).toBeCloseTo(0.2);
  });
});

describe("NPCProfileModule recovery", () => {
  beforeEach(() => {
    StateModule.state.npcProfiles = [];
  });

  it("parses an [NPC_PROFILE] block wrapped in markdown emphasis", () => {
    NPCProfileModule.extract(
      '[NPC_PROFILE]**{"npcName": "Greta", "traits": ["generous"], "trust": 60}**[/NPC_PROFILE]',
    );
    const p = StateModule.state.npcProfiles.find((x) => x.npcName === "Greta");
    expect(p?.trust).toBe(60);
    expect(p?.traits).toContain("generous");
  });
});

describe("TimeStateModule recovery", () => {
  beforeEach(() => {
    StateModule.state.timeStates = [];
  });

  it("parses a [TIME_STATE] block wrapped in markdown emphasis", () => {
    TimeStateModule.extract(
      '[TIME_STATE]**{"id": "poison", "name": "Poisoned", "target": "mc", "severity": 30, "durationMinutes": 120}**[/TIME_STATE]',
    );
    const ts = StateModule.state.timeStates.find((x) => x.id === "poison");
    expect(ts?.name).toBe("Poisoned");
    expect(ts?.severity).toBe(30);
  });
});

describe("GiftModule recovery", () => {
  beforeEach(() => {
    StateModule.state.giftLog = [];
  });

  it("parses a [GIFT] block wrapped in markdown emphasis", () => {
    GiftModule.extract(
      '[GIFT]**{"giver": "MC", "recipient": "Greta", "itemName": "Silk Scarf", "relationshipChange": "+10 affection", "timestamp": "2026-08-11T10:00:00Z", "accepted": true}**[/GIFT]',
    );
    const g = StateModule.state.giftLog.find((x) => x.itemName === "Silk Scarf");
    expect(g?.giver).toBe("MC");
    expect(g?.relationshipChange).toBe("+10 affection");
  });
});
