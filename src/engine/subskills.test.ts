// =============================================================================
// subskills.test.ts — How subskills connect into interactions.
//
// Covers the full pipeline end-to-end:
//   1. StateModule.recalculateSubskills — subskill values derived from
//      cultivation-scaled effective stats.
//   2. GenreModule gating — which subskills are available per genre (drives
//      the sidebar panel).
//   3. buildSystemPrompt — the 4 derived skills injected into the system
//      prompt the AI sees every turn.
//   4. GameEngine.executeTurn — the same values re-anchored in the per-turn
//      state reminder attached to every player action (via a mocked API call).
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

// Minimal localStorage stub so StorageModule.autosave (called at the end of
// every turn) no-ops in a DOM-free test run.
(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  key: () => null,
  length: 0,
};

// Capture what the engine actually sends to the AI so we can assert the
// subskill values travel into the interaction payload.
const { mockGenerateResponse } = vi.hoisted(() => ({
  mockGenerateResponse: vi.fn(),
}));

vi.mock("../api/providers", () => ({
  ApiModule: { generateResponse: mockGenerateResponse, testConnection: vi.fn() },
}));

import { StateModule } from "../state/state";
import { EquipmentSlot } from "../state/GameState";
import { GenreModule, SUBSKILLS } from "./genre-system";
import { buildSystemPrompt } from "./prompt";
import { GameEngine } from "./turn";

/** Reset the live state to defaults the way a fresh game would look. */
function resetState(): void {
  const s = StateModule.state;
  // `setup` is typed `SetupState | Record<string, never>`, so mutate through
  // a loose alias rather than reassigning the field.
  const setup = s.setup as { activeGenres?: string[]; genre?: string };
  setup.activeGenres = [];
  setup.genre = "";
  s.char.name = "Unnamed Protagonist";
  s.char.str = 10;
  s.char.agi = 10;
  s.char.int = 10;
  s.char.cha = 10;
  s.char.end = 10;
  s.char.wil = 10;
  s.char.lck = 10;
  s.char.per = 10;
  s.char.cultivation = 0;
  s.toggles.subskills = true;
  s.subskills = {};
  s.equipped = [];
  s.worldState = { time: "Monday, 07:00 AM", location: "Starting Location", measurement: "Metric" };
  s.history = [];
  s.memory = { facts: [], relations: [] };
  StateModule.recalculateSubskills();
  mockGenerateResponse.mockReset();
}

/**
 * Helper: push an equipped item straight into state for subskill math tests.
 * Mirrors the engine: equipping gear triggers a subskill recalc (the turn
 * pipeline runs recalculateSubskills after equipment extraction).
 */
function equipGear(stats: Record<string, number>, slot: EquipmentSlot): void {
  StateModule.state.equipped = [
    {
      itemId: "test-gear-" + slot,
      name: "Test Gear",
      slot,
      rarity: "rare",
      stats,
      desc: "Test item",
      equipped: true,
    },
  ];
  StateModule.recalculateSubskills();
}

const SEDUCTION = SUBSKILLS.find((sk) => sk.id === "seduction")!;
const MELEE = SUBSKILLS.find((sk) => sk.id === "melee")!;
const QI_SENSING = SUBSKILLS.find((sk) => sk.id === "qi_sensing")!;
const ALCHEMY = SUBSKILLS.find((sk) => sk.id === "alchemy")!;

describe("Subskills → interactions pipeline", () => {
  beforeEach(() => {
    resetState();
  });

  describe("1. StateModule.recalculateSubskills — computation from stats", () => {
    it("computes the 4 derived skills from default stats", () => {
      // All stats 10, cultivation 0:
      //   seduction    = (10+10)/2        = 10
      //   sneaking     = 10*1.5           = 15
      //   negotiation  = 10*1.5 - 10*0.2  = 13
      //   intimidation = (10+10)/2        = 10
      expect(StateModule.state.subskills).toEqual({
        seduction: 10,
        sneaking: 15,
        negotiation: 13,
        intimidation: 10,
      });
    });

    it("scales subskills with cultivation-tier effective stats", () => {
      // Cultivation 1.0 → 20% effective-stat multiplier (1.2).
      StateModule.state.char.cultivation = 1.0;
      StateModule.recalculateSubskills();
      // eff = floor(10 * 1.2) = 12 for all stats
      expect(StateModule.state.subskills).toEqual({
        seduction: Math.floor((12 + 12) / 2), // 12
        sneaking: Math.floor(12 * 1.5), // 18
        negotiation: Math.floor(12 * 1.5 - 12 * 0.2), // 15
        intimidation: Math.floor((12 + 12) / 2), // 12
      });
    });

    it("recomputes from live stat changes (STR lowers negotiation)", () => {
      StateModule.state.char.str = 20;
      StateModule.recalculateSubskills();
      // negotiation = 10*1.5 - 20*0.2 = 15 - 4 = 11
      expect(StateModule.state.subskills.negotiation).toBe(11);
    });
  });

  describe("1b. GenreModule.computeSubskill — extended subskills use gear-aware effective stats", () => {
    it("STR/AGI gear raises Melee Combat", () => {
      equipGear({ str: 4, agi: 2 }, "hands");
      // eff = floor(base) + bonus: STR 14, AGI 12 → floor(14*1.2 + 12*0.3) = 20
      expect(GenreModule.computeSubskill(MELEE)).toBe(20);
    });

    it("INT gear raises Alchemy", () => {
      equipGear({ int: 2 }, "ring");
      // effINT = 12 → floor(12*1.5) = 18 (base 15)
      expect(GenreModule.computeSubskill(ALCHEMY)).toBe(18);
    });

    it("secondary-stat formulas stay base-driven (END gear has no channel yet)", () => {
      equipGear({ str: 4 }, "hands");
      const ENDURANCE = SUBSKILLS.find((sk) => sk.id === "endurance_c")!;
      // Endure Blows = floor(END * 1.5) — STR gear must not touch it.
      expect(GenreModule.computeSubskill(ENDURANCE)).toBe(15);
      // Qi Sensing = (WIL + PER) / 2 — INT/STR gear must not touch it.
      expect(GenreModule.computeSubskill(QI_SENSING)).toBe(10);
    });

    it("matches the four core derived skills that already use effective stats", () => {
      equipGear({ str: 4, agi: 2 }, "hands");
      const NEGOTIATION = SUBSKILLS.find((sk) => sk.id === "negotiation")!;
      const INTIMIDATION = SUBSKILLS.find((sk) => sk.id === "intimidation")!;
      const SNEAKING = SUBSKILLS.find((sk) => sk.id === "sneaking")!;
      // Same formulas as recalculateSubskills, fed by the same eff stats.
      expect(GenreModule.computeSubskill(NEGOTIATION)).toBe(
        StateModule.state.subskills.negotiation,
      );
      expect(GenreModule.computeSubskill(INTIMIDATION)).toBe(
        StateModule.state.subskills.intimidation,
      );
      expect(GenreModule.computeSubskill(SNEAKING)).toBe(
        StateModule.state.subskills.sneaking,
      );
    });
  });

  describe("2. GenreModule gating — which subskills are available", () => {
    it("genre-gated subskills are hidden with no active genres", () => {
      expect(GenreModule.isSubskillAvailable(MELEE)).toBe(true); // universal
      expect(GenreModule.isSubskillAvailable(SEDUCTION)).toBe(false); // needs romance/adult/harem
      expect(GenreModule.isSubskillAvailable(QI_SENSING)).toBe(false); // needs cultivation/xianxia/wuxia
    });

    it("enables seduction when a romance-line genre is active", () => {
      StateModule.state.setup.activeGenres = ["romance"];
      expect(GenreModule.isSubskillAvailable(SEDUCTION)).toBe(true);
      expect(GenreModule.getAvailableSubskills().map((s) => s.id)).toContain("seduction");
    });

    it("enables qi_sensing for xianxia and groups it under the arcane tab", () => {
      StateModule.state.setup.activeGenres = ["xianxia"];
      expect(GenreModule.isSubskillAvailable(QI_SENSING)).toBe(true);
      const tabs = GenreModule.getSubskillsByTab();
      expect(tabs.arcane.map((s) => s.id)).toEqual(
        expect.arrayContaining(["qi_sensing", "willforce", "spirit_sense"]),
      );
      // Alchemy is xianxia-eligible; hacking (scifi/urban) and riding
      // (medieval/historical/darkfantasy) are not.
      expect(tabs.craft.map((s) => s.id)).toContain("alchemy");
      expect(tabs.craft.map((s) => s.id)).not.toContain("hacking");
      expect(tabs.craft.map((s) => s.id)).not.toContain("riding");
      expect(tabs.craft.map((s) => s.id)).toContain("sneaking"); // universal
    });

    it("always returns all four tabs in display order", () => {
      const tabs = GenreModule.getSubskillsByTab();
      expect(Object.keys(tabs)).toEqual(["combat", "social", "craft", "arcane"]);
    });
  });

  describe("3. buildSystemPrompt — subskills injected into the system prompt", () => {
    it("embeds the computed derived skills when the toggle is on", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain(
        "Derived Skills - Seduction: 10, Sneaking: 15, Negotiation: 13, Intimidation: 10.",
      );
    });

    it("prompt values match the live subskills state exactly", () => {
      StateModule.state.char.str = 20;
      StateModule.recalculateSubskills();
      const prompt = buildSystemPrompt();
      expect(prompt).toContain(`Negotiation: ${StateModule.state.subskills.negotiation}`);
      expect(StateModule.state.subskills.negotiation).toBe(11);
    });

    it("omits the derived skills line when the toggle is off", () => {
      StateModule.state.toggles.subskills = false;
      expect(buildSystemPrompt()).not.toContain("Derived Skills");
    });
  });

  describe("4. GameEngine.executeTurn — subskills re-anchored per interaction", () => {
    it("attaches the subskill values to the per-turn state reminder", async () => {
      mockGenerateResponse.mockResolvedValue("The barmaid raises an eyebrow.");
      await GameEngine.executeTurn("I try to charm the barmaid.", false);

      expect(mockGenerateResponse).toHaveBeenCalledTimes(1);
      const [sysPrompt, payloadText] = mockGenerateResponse.mock.calls[0];
      // System prompt carries the derived skills.
      expect(sysPrompt).toContain(
        "Derived Skills - Seduction: 10, Sneaking: 15, Negotiation: 13, Intimidation: 10.",
      );
      // The per-turn reminder re-anchors the AI on the exact values.
      expect(payloadText).toContain(
        "Subskills: Seduction 10, Sneaking 15, Negotiation 13, Intimidation 10.",
      );
    });

    it("reflects stat changes in the same interaction payload", async () => {
      StateModule.state.char.str = 20;
      StateModule.recalculateSubskills();
      mockGenerateResponse.mockResolvedValue("He glares back.");
      await GameEngine.executeTurn("I intimidate the guard.", false);

      const [, payloadText] = mockGenerateResponse.mock.calls[0];
      expect(payloadText).toContain("Subskills: Seduction 10, Sneaking 15, Negotiation 11, Intimidation 15");
    });

    it("omits subskills from the payload when the toggle is off", async () => {
      StateModule.state.toggles.subskills = false;
      mockGenerateResponse.mockResolvedValue("Nothing happens.");
      await GameEngine.executeTurn("I look around.", false);

      const [, payloadText] = mockGenerateResponse.mock.calls[0];
      expect(payloadText).not.toContain("Subskills:");
    });
  });
});
