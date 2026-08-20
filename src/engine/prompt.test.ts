// =============================================================================
// prompt.test.ts — Output format spec tightening.
//
// Covers: the consolidated OUTPUT FORMAT SPEC sits immediately before the
// style instruction, uses MUST-language with concrete triggers, and includes
// one worked example per tag ([FACT], [RELATION], [STATE_UPDATE], ...).
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";

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

// Minimal localStorage stub so StorageModule no-ops in a DOM-free test run.
(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  key: () => null,
  length: 0,
};

import { StateModule } from "../state/state";
import { buildSystemPrompt } from "./prompt";

/** Reset the live state to defaults the way a fresh game would look. */
function resetState(): void {
  const s = StateModule.state;
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
  s.toggles = {
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
    descriptiveScenes: true,
    schedules: true,
  };
  s.worldState = { time: "Monday, March 17, 07:00", location: "Starting Location", measurement: "Metric" };
  s.history = [];
  s.memory = { facts: [], relations: [] };
  s.directorNotes = [];
}

describe("buildSystemPrompt output format spec", () => {
  beforeEach(() => {
    resetState();
  });

  it("places the OUTPUT FORMAT SPEC immediately before the STYLE INSTRUCTION", () => {
    const prompt = buildSystemPrompt();
    const specIdx = prompt.indexOf("=== OUTPUT FORMAT SPEC");
    const styleIdx = prompt.indexOf("STYLE INSTRUCTION:");
    expect(specIdx).toBeGreaterThan(-1);
    expect(styleIdx).toBeGreaterThan(specIdx);
    // Nothing but the style instruction (and the spec's own tail) between them.
    const between = prompt.slice(specIdx, styleIdx);
    expect(between).toContain("MUST FOLLOW");
  });

  it("uses MUST-language with a concrete trigger for [FACT]", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(
      "[FACT] — NEW KNOWLEDGE. MUST emit when the MC learns any persistent fact",
    );
    expect(prompt).toContain("MC asks the herbalist the price, so you MUST emit");
    // Worked example is present and closed.
    expect(prompt).toContain("[FACT]Oakhaven Market: Dried herbs cost 3 copper per bundle.[/FACT]");
  });

  it("uses MUST-language with a concrete trigger for [RELATION]", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(
      "[RELATION] — RELATIONSHIPS. MUST emit for EVERY new NPC the MC meets or interacts with",
    );
    expect(prompt).toContain("MC meets the herbalist, so you MUST emit");
    expect(prompt).toContain(
      '[RELATION]{"name": "Mara", "disposition": "Friendly merchant", "status": "Alive", "aliases": ["Oakhaven Herbalist"]}[/RELATION]',
    );
  });

  it("uses MUST-language with a worked example for [STATE_UPDATE]", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(
      "[STATE_UPDATE] — DYNAMIC STATE. MUST emit every turn in which health, fatigue, core stats",
    );
    expect(prompt).toContain("MC buys herbs, so you MUST emit (with YOUR current values)");
    expect(prompt).toContain(
      '"time": "Monday, March 17, 07:10", "location": "Oakhaven Market"',
    );
    expect(prompt).toContain('"name": "Dried Herbs"');
    expect(prompt).toContain("[/STATE_UPDATE]");
  });

  it("gives [QUEST] a worked example tied to an NPC task offer", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(
      "[QUEST] — QUEST CHANGES. MUST emit when a new quest is given",
    );
    expect(prompt).toContain("the elder offers the MC a task, so you MUST emit");
    expect(prompt).toContain("quest-jade-pendant");
    expect(prompt).toContain('"assignedBy": "Elder Li"}[/QUEST]');
  });

  it("ends the spec with a narrative-to-tag self-check checklist", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("FINAL SELF-CHECK BEFORE FINISHING");
    expect(prompt).toContain("Introduced or met an NPC? -> [RELATION]");
    expect(prompt).toContain("learned a price, route, schedule, rumor, or location detail? -> [FACT]");
    expect(prompt).toContain("given a task, quest, errand, or favor? -> [QUEST]");
    expect(prompt).toContain("bought, sold, or was paid? -> [TRANSACTION]");
    // The checklist is the last spec content before the style instruction.
    const specIdx = prompt.indexOf("=== OUTPUT FORMAT SPEC");
    const styleIdx = prompt.indexOf("STYLE INSTRUCTION:");
    const between = prompt.slice(specIdx, styleIdx);
    expect(between.lastIndexOf("FINAL SELF-CHECK")).toBeGreaterThan(
      between.lastIndexOf("[NPC_PROFILE]"),
    );
  });

  it("warns against markdown-wrapped payloads, split arrays, and stray-slash closers in the self-check", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("FORMAT SELF-CHECK");
    expect(prompt).toContain("Never wrap any block payload in markdown");
    expect(prompt).toContain('"inventory": [{...}],[{...}] is INVALID');
    expect(prompt).toContain("ONE complete array");
    expect(prompt).toContain("close with [/STATE_UPDATE], not }/[STATE_UPDATE]");
    // The format self-check sits inside the final self-check, after the
    // narrative-to-tag checklist, and still before the style instruction.
    const specIdx = prompt.indexOf("=== OUTPUT FORMAT SPEC");
    const styleIdx = prompt.indexOf("STYLE INSTRUCTION:");
    const between = prompt.slice(specIdx, styleIdx);
    expect(between.lastIndexOf("FORMAT SELF-CHECK")).toBeGreaterThan(
      between.lastIndexOf("bought, sold, or was paid?"),
    );
    expect(between.lastIndexOf("FORMAT SELF-CHECK")).toBeLessThan(styleIdx - specIdx);
  });

  it("keeps one worked example per engine tag in the spec", () => {
    const prompt = buildSystemPrompt();
    // [FACT], [FACT_RESET], [RELATION], [STATE_UPDATE] always on in this config.
    expect(prompt).toContain("[FACT_RESET]Household[/FACT_RESET]");
    expect(prompt).toContain("[QUEST]");
    expect(prompt).toContain("[EQUIPMENT]");
    expect(prompt).toContain("[TRANSACTION]");
    expect(prompt).toContain("[XP_GAIN]");
    expect(prompt).toContain("[NPC_PROFILE]");
    expect(prompt).toContain("[TIME_STATE]");
    expect(prompt).toContain("[GIFT]");
    expect(prompt).toContain("[NPC_GIFT]");
  });

  it("omits the [FACT]/[RELATION] instructions when the memory toggle is off", () => {
    StateModule.state.toggles.memory = false;
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("[FACT] — NEW KNOWLEDGE");
    expect(prompt).not.toContain("[RELATION] — RELATIONSHIPS");
    expect(prompt).not.toContain("[FACT_RESET]");
    // Narrative instruction (established facts context) also gone.
    expect(prompt).not.toContain("ESTABLISHED FACTS");
  });

  it("omits the [STATE_UPDATE] instructions when mcInfo and health toggles are off", () => {
    StateModule.state.toggles.mcInfo = false;
    StateModule.state.toggles.health = false;
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("[STATE_UPDATE] — DYNAMIC STATE");
  });

  describe("schedule awareness module", () => {
    it("injects the SCHEDULE CONTEXT block with logical anchors when enabled", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("=== SCHEDULE CONTEXT");
      expect(prompt).toContain("school runs roughly 08:30–15:30");
      expect(prompt).toContain("follow the story");
    });

    it("omits the block entirely when the toggle is off", () => {
      StateModule.state.toggles.schedules = false;
      const prompt = buildSystemPrompt();
      expect(prompt).not.toContain("SCHEDULE CONTEXT");
    });

    it("reflects the current clock: the household is asleep at 04:00", () => {
      StateModule.state.worldState.time = "Monday, March 17, 04:00";
      StateModule.state.memory.relations = [
        {
          name: "Mother",
          aliases: ["Mom"],
          disposition: "MC's mother",
          status: "Alive",
          modifiers: [],
        },
        {
          name: "Younger Sister",
          aliases: ["Sis"],
          disposition: "MC's younger sister",
          status: "Alive",
          modifiers: [],
        },
      ];
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("deep night");
      expect(prompt).toContain("The world is asleep");
      expect(prompt).toContain("Mother (mc's mother, household): asleep at home");
      expect(prompt).toContain("Younger Sister (mc's younger sister, student): asleep at home");
    });
  });

  describe("descriptive scenes module", () => {
    it("injects the DESCRIPTIVE SCENES block and [SCENE] format when enabled", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("=== DESCRIPTIVE SCENES (ACTIVE) ===");
      expect(prompt).toContain(
        '[SCENE]{"location":"<Location>","description":"<2-4 sentence environmental description>","weather":"<current weather>","lighting":"<current lighting>","season":"<current season>"}[/SCENE]',
      );
      expect(prompt).toContain("weather/lighting/season fields are OPTIONAL");
      // Story-driven season shifts are documented as canon.
      expect(prompt).toContain('[SEASON_SHIFT]{"season":"<Season>"}[/SEASON_SHIFT]');
      expect(prompt).toContain("treats it as canon");
    });

    it("omits the block entirely when the toggle is off", () => {
      StateModule.state.toggles.descriptiveScenes = false;
      const prompt = buildSystemPrompt();
      expect(prompt).not.toContain("DESCRIPTIVE SCENES");
      expect(prompt).not.toContain("[SCENE]");
    });

    it("re-injects the remembered CURRENT SCENE for the MC's current location", () => {
      StateModule.state.worldState.location = "MC Bedroom";
      StateModule.state.sceneLog = {
        "mc bedroom": {
          description:
            "A single bed, a study desk with a laptop and chair, and a curtained window.",
        },
      };
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("CURRENT SCENE");
      expect(prompt).toContain("A single bed, a study desk with a laptop and chair");
    });

    it("re-injects ambient conditions alongside the description", () => {
      StateModule.state.worldState.location = "High School";
      StateModule.state.sceneLog = {
        "high school": {
          description: "The schoolyard is nearly empty.",
          weather: "cold drizzle",
          lighting: "grey overcast light",
        },
      };
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("AMBIENT CONDITIONS");
      expect(prompt).toContain("weather: cold drizzle");
      expect(prompt).toContain("lighting: grey overcast light");
      // No season recorded -> no season entry in the ambient line.
      expect(prompt).not.toContain("season:");
    });

    it("re-injects a season consistency note alongside ambient conditions", () => {
      StateModule.state.worldState.location = "High School";
      StateModule.state.sceneLog = {
        "high school": {
          description: "The schoolyard is empty.",
          season: "Spring",
          seasonNote:
            'Scene recorded "Winter" but the calendar says Spring — using Spring.',
        },
      };
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("SCENE NOTE (consistency)");
      expect(prompt).toContain("calendar says Spring");
    });

    it("shows no CURRENT SCENE when the current location has no remembered description", () => {
      StateModule.state.worldState.location = "High School";
      StateModule.state.sceneLog = {
        "mc bedroom": { description: "A quiet bedroom." },
      };
      const prompt = buildSystemPrompt();
      expect(prompt).not.toContain("CURRENT SCENE");
    });
  });
});
