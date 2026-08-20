// =============================================================================
// pipelines.test.ts — End-to-end pipelines for how the AI uses game numbers.
//
// Three integrated systems, each exercised through full GameEngine.executeTurn
// cycles against a mocked API (state mutates via [STATE_UPDATE]/[RELATION]
// tags, and the NEXT turn's system prompt + per-turn payload are asserted):
//
//   1. Stat checks — the STAT CHECKS instructions (system prompt + per-turn
//      action instruction), base-vs-effective stat math, and how an AI-applied
//      stat change flows into the following turns.
//   2. Relationship changes — AI-emitted [RELATION] tags creating, updating,
//      and killing NPCs; modifier duration ticking; and how the prompt re-lists
//      the relationship (alive vs deceased sections) every turn.
//   3. Sub-attribute uses — derived subskills and secondary stats injected
//      into the prompt, recalculation after AI-applied stat/cultivation
//      changes, per-turn payload anchoring, and genre-specific guidance.
//
// NOTE: every mock response below carries at least one engine tag — a
// tag-less response that describes change would trigger runStructuredFallback's
// extra API call and shift the call indices asserted here.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Minimal document + localStorage stubs for UIManager / StorageModule.
// getElementById consults a per-test element registry (like
// director-notes.test.ts) so the sidebar tests can capture rendered output
// while every other id still resolves to null exactly as before.
interface TestElement {
  innerHTML: string;
  innerText: string;
  textContent: string;
  title: string;
  style: Record<string, string>;
  classList: {
    add(...c: string[]): void;
    remove(c: string): void;
    toggle(c: string): boolean;
    contains(c: string): boolean;
  };
}
const testElements = new Map<string, TestElement>();

/** Plain-element stub whose text fields coerce to strings like the real DOM. */
function makeTestElement(): TestElement {
  const backing: Record<string, string> = { innerHTML: "", innerText: "", textContent: "", title: "" };
  const classes = new Set<string>();
  const classList = {
    add: (...cs: string[]) => cs.forEach((c) => classes.add(c)),
    remove: (c: string) => classes.delete(c),
    toggle: (c: string) => {
      if (classes.has(c)) {
        classes.delete(c);
        return false;
      }
      classes.add(c);
      return true;
    },
    contains: (c: string) => classes.has(c),
  };
  const el: Record<string, unknown> = {
    style: {} as Record<string, string>,
    classList,
  };
  for (const k of ["innerHTML", "innerText", "textContent", "title"]) {
    Object.defineProperty(el, k, {
      get: () => backing[k],
      set: (v: unknown) => {
        backing[k] = String(v);
      },
    });
  }
  return el as unknown as TestElement;
}

(globalThis as any).document = {
  getElementById: (id: string) => testElements.get(id) ?? null,
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
// Recording localStorage so the save/load round-trip test can exercise the
// real StorageModule autosave -> loadAutosave path.
const storageBacking = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => storageBacking.get(k) ?? null,
  setItem: (k: string, v: string) => {
    storageBacking.set(k, String(v));
  },
  removeItem: (k: string) => {
    storageBacking.delete(k);
  },
  clear: () => storageBacking.clear(),
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
import { DirectorNote, Relation, SCHEMA_VERSION } from "../state/GameState";
import { StorageModule } from "../storage/save";
import { buildSystemPrompt } from "./prompt";
import { GameEngine } from "./turn";
import { LoreModule, cleanHistoryTags } from "./lore";
import { EquipmentModule, getEffectiveStats } from "./equipment";
import { GenreModule, SUBSKILLS } from "./genre-system";
import { seedFamilyRelations, clearFamilyAnchoringChoices } from "./family";
import { SkillModule } from "./skill";
import { NPCProfileModule, getNpcMood } from "./npc-profile";
import { VacuumSafetyModule } from "./vacuum-safety";
import { CheckModule, setCheckRng, getMomentumReminder, getEscalationReminder, resolveCheck, DIFFICULTY_BASE, TIER_MOD } from "./stat-checks";
import { ActionMemoryModule, getActionMemoryReminder, getFirstTimeGuard, getMemoryDecay, parseMemoryRefs, parseMemoryTags } from "./action-memory";
import { UIManager } from "../ui/UIManager";

/** Build a witness-capable NPC profile for reaction tests. */
function makeWitness(
  npcName: string,
  overrides: Partial<Parameters<typeof NPCProfileModule.upsertProfile>[0]> = {},
): void {
  NPCProfileModule.upsertProfile({
    npcName,
    traits: [],
    aggressionThreshold: 50,
    jealousyThreshold: 50,
    trust: 50,
    affection: 50,
    schedule: [],
    relationships: [],
    equipment: [],
    autoGenerated: true,
    knownLocation: "Starting Location",
    ...overrides,
  });
}

/** Reset the live state to defaults the way a fresh game would look. */
function resetState(): void {
  const s = StateModule.state;
  s.initialized = false;
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
  s.char.health = 100;
  s.char.maxHealth = 100;
  s.char.fatigue = 0;
  s.char.xp = 0;
  s.char.level = 1;
  s.char.skillPoints = 0;
  s.char.systemPoints = 0;
  s.char.learnedSkills = [];
  // Breakthroughs must reset too: once achieved they never re-apply, so a
  // cultivation jump in one test would silently change the next test's stats.
  s.char.breakthroughs = [];
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
  s.subskills = {};
  s.modifiers = {};
  s.sceneLog = {};
  s.worldState = { time: "Monday, March 17, 07:00", location: "Starting Location", measurement: "Metric" };
  s.history = [];
  s.memory = { facts: [], relations: [] };
  s.directorNotes = [];
  s.turnCount = 0;
  // Engine modules append to these during turns — clear them so each test
  // starts with a truly fresh world (no leaked NPCs/gifts/states/quests).
  s.npcProfiles = [];
  s.timeStates = [];
  s.giftLog = [];
  s.quests = [];
  s.equipped = [];
  s.currencies = [];
  s.transactionLog = [];
  s.checkLog = [];
  s.checkMomentum = {};
  s.checkEscalation = {};
  s.lastFailedCheck = null;
  s.actionMemory = [];
  StateModule.recalculateSubskills();
  mockGenerateResponse.mockReset();
  setCheckRng(null);
}

// ===========================================================================
// 1. Descriptive Scenes module
// ===========================================================================

describe("Descriptive Scenes module — [SCENE] tags and scene memory", () => {
  beforeEach(resetState);

  it("parses [SCENE] into sceneLog, strips it from display, and re-injects it into the next prompt", async () => {
    StateModule.state.worldState.location = "MC Bedroom";
    mockGenerateResponse.mockResolvedValue(
      'You step into the classroom.\n[SCENE]{"location":"Classroom 3B","description":"Rows of desks face a chalkboard while the teacher sorts papers at her desk."}[/SCENE]',
    );
    const spy = vi.spyOn(UIManager, "appendChat");
    await GameEngine.executeTurn("You walk into the classroom.", false);

    // Remembered per location under a lowercased key.
    expect(StateModule.state.sceneLog["classroom 3b"]).toEqual({
      description: "Rows of desks face a chalkboard while the teacher sorts papers at her desk.",
    });
    // The tag never reaches the chat display (raw history keeps it so the
    // model still sees its own tag usage).
    expect(StateModule.state.history[1].content).toContain("[SCENE]");
    expect(spy).toHaveBeenCalledWith(
      "ai",
      "You step into the classroom.",
    );
    spy.mockRestore();

    // The MC arrives — the next turn's prompt re-injects the remembered scene.
    StateModule.state.worldState.location = "Classroom 3B";
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("CURRENT SCENE");
    expect(prompt).toContain(
      "Rows of desks face a chalkboard while the teacher sorts papers at her desk.",
    );
  });

  it("stores scenes for locations the MC moves to in the same turn (STATE_UPDATE order-independent)", async () => {
    mockGenerateResponse.mockResolvedValue(
      '[STATE_UPDATE]{"location":"High School","time":"Monday, March 17, 08:00"}[/STATE_UPDATE]\n[SCENE]{"location":"High School","description":"The hallway buzzes as students hurry between classrooms."}[/SCENE]',
    );
    await GameEngine.executeTurn("You head to school.", false);
    expect(StateModule.state.worldState.location).toBe("High School");
    expect(StateModule.state.sceneLog["high school"]).toEqual({
      description: "The hallway buzzes as students hurry between classrooms.",
    });
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("CURRENT SCENE");
    expect(prompt).toContain("The hallway buzzes as students hurry between classrooms.");
  });

  it("rejects malformed [SCENE] JSON without touching sceneLog", async () => {
    StateModule.state.sceneLog = { "mc bedroom": { description: "A quiet bedroom." } };
    mockGenerateResponse.mockResolvedValue(
      "A dusty corridor.\n[SCENE]{not valid json}[/SCENE]",
    );
    await GameEngine.executeTurn("You explore the corridor.", false);
    expect(StateModule.state.sceneLog).toEqual({
      "mc bedroom": { description: "A quiet bedroom." },
    });
  });

  it("records ambient conditions in [SCENE] and re-injects them with the description", async () => {
    StateModule.state.worldState.location = "MC Bedroom";
    // NOTE: the clock is March (Spring), so the "late autumn" season in the
    // tag is a mismatch — the validation corrects it and notes the discrepancy.
    mockGenerateResponse.mockResolvedValue(
      'You step outside.\n[SCENE]{"location":"High School","description":"The schoolyard is nearly empty.","weather":"cold drizzle","lighting":"grey overcast light","season":"late autumn"}[/SCENE]',
    );
    await GameEngine.executeTurn("You head to school.", false);
    // Structured entry carries the description plus ambient conditions.
    expect(StateModule.state.sceneLog["high school"]).toEqual({
      description: "The schoolyard is nearly empty.",
      weather: "cold drizzle",
      lighting: "grey overcast light",
      season: "Spring",
      seasonNote:
        'Scene recorded "late autumn" but the calendar says Spring — using Spring.',
    });
    // A partial tag keeps the missing ambient fields absent (not empty strings).
    mockGenerateResponse.mockResolvedValue(
      '[SCENE]{"location":"Cafeteria","description":"Long tables and the smell of stew.","weather":"sunny"}[/SCENE]',
    );
    await GameEngine.executeTurn("You go to the cafeteria.", false);
    expect(StateModule.state.sceneLog["cafeteria"]).toEqual({
      description: "Long tables and the smell of stew.",
      weather: "sunny",
    });
    // The MC arrives — the next prompt re-injects description + ambient line
    // with the corrected season and the consistency note.
    StateModule.state.worldState.location = "High School";
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("The schoolyard is nearly empty.");
    expect(prompt).toContain("AMBIENT CONDITIONS");
    expect(prompt).toContain("weather: cold drizzle");
    expect(prompt).toContain("lighting: grey overcast light");
    expect(prompt).toContain("season: Spring");
    expect(prompt).toContain("SCENE NOTE (consistency)");
    expect(prompt).toContain("calendar says Spring");
  });
});

// ===========================================================================
// 1. Schedule awareness
// ===========================================================================

describe("Schedule awareness — the AI is gently told who is where at this hour", () => {
  beforeEach(resetState);

  it("a 04:00 turn keeps the household asleep and anchors school start times", async () => {
    StateModule.state.worldState.time = "Monday, March 17, 04:00";
    seedFamilyRelations(
      "The MC lives with his mother, who works at the diner, and his younger sister.",
    );
    mockGenerateResponse.mockResolvedValue("The apartment is dark and quiet.");
    await GameEngine.executeTurn("You wake up at four in the morning.", false);

    const prompt = buildSystemPrompt();
    // The world pulse says everyone is asleep at this hour.
    expect(prompt).toContain("SCHEDULE CONTEXT");
    expect(prompt).toContain("The world is asleep");
    expect(prompt).toContain("asleep at home");
    // School and work are hours away — never 05:00.
    expect(prompt).toContain("school runs roughly 08:30–15:30");
    expect(prompt).toContain("09:00–17:00");
  });

  it("the schedule block disappears when the toggle is off", async () => {
    StateModule.state.worldState.time = "Monday, March 17, 04:00";
    StateModule.state.toggles.schedules = false;
    seedFamilyRelations("The MC lives with his mother and younger sister.");
    mockGenerateResponse.mockResolvedValue("The apartment is dark and quiet.");
    await GameEngine.executeTurn("You wake up at four in the morning.", false);
    expect(buildSystemPrompt()).not.toContain("SCHEDULE CONTEXT");
  });
});

// ===========================================================================
// 1. Ambient conditions shape witnesses
// ===========================================================================

describe("Ambient conditions shape witnesses — rain, darkness, and shelter", () => {
  beforeEach(() => {
    resetState();
    VacuumSafetyModule.setAmbientRng(null);
  });

  it("computes the notice factor from weather, lighting, clock, and shelter", () => {
    const s = StateModule.state;
    // Pin Sneaking to average so the ambient-only numbers are exact (the
    // sneak synergy is covered by its own tests).
    s.subskills = { sneaking: 10 } as any;
    // Outdoor + heavy rain at 07:00 -> half the witnesses notice.
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 07:00";
    s.sceneLog = { "town square": { description: "A wet plaza.", weather: "heavy rain" } };
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(0.5);
    // Shelter: the same downpour indoors is blocked -> everyone notices.
    s.worldState.location = "MC Bedroom";
    s.sceneLog = { "mc bedroom": { description: "A tidy room.", weather: "heavy rain" } };
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(1);
    // Outdoor + night clock -> darkness halves witnesses even without a scene.
    s.worldState.location = "Forest";
    s.worldState.time = "Monday, March 17, 23:00";
    s.sceneLog = {};
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(0.5);
    // Outdoor + rain + night -> they stack: 0.5 * 0.5 = 0.25.
    s.sceneLog = { forest: { description: "Dark pines.", weather: "drizzle" } };
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(0.25);
    // Indoor + recorded unlit room -> reduced even at midday.
    s.worldState.location = "MC Bedroom";
    s.worldState.time = "Monday, March 17, 14:00";
    s.sceneLog = { "mc bedroom": { description: "A dark room.", lighting: "pitch black" } };
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(0.6);
    // Indoor + lit room at night -> normal (shelter + lights).
    s.sceneLog = { "mc bedroom": { description: "A warm room.", lighting: "warm lamp light" } };
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(1);
    // Clear day, no scene, outdoor -> everyone notices.
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 12:00";
    s.sceneLog = {};
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(1);
  });

  it("reduces witnesses under rain via the injected rng", () => {
    const s = StateModule.state;
    makeWitness("Mara", { knownLocation: "Town Square" });
    makeWitness("Wren", { knownLocation: "Town Square" });
    makeWitness("Hrogar", { knownLocation: "Town Square" });
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 07:00";
    s.sceneLog = { "town square": { description: "A wet plaza.", weather: "downpour" } };
    VacuumSafetyModule.setAmbientRng(() => 0.99);
    expect(VacuumSafetyModule.getWitnesses()).toEqual([]);
    VacuumSafetyModule.setAmbientRng(() => 0.01);
    expect(VacuumSafetyModule.getWitnesses().length).toBe(3);
    VacuumSafetyModule.setAmbientRng(null);
  });

  it("shelter blocks rain — indoor reactions still fire in a downpour", async () => {
    makeWitness("Mother", { traits: [], knownLocation: "MC Bedroom" });
    StateModule.state.worldState.location = "MC Bedroom";
    StateModule.state.worldState.time = "Monday, March 17, 07:00";
    StateModule.state.sceneLog = {
      "mc bedroom": { description: "A tidy living room.", weather: "downpour" },
    };
    const spy = vi.spyOn(UIManager, "appendChat");
    mockGenerateResponse.mockResolvedValue("Mei eats her breakfast happily.");
    await GameEngine.executeTurn("You make breakfast for your mother.", false);
    expect(spy).toHaveBeenCalledWith(
      "system",
      expect.stringContaining("Mother reacts warmly"),
    );
    spy.mockRestore();
  });

  it("outdoor rain hides the MC — witnesses drop and stats stay put", async () => {
    makeWitness("Guard", { traits: [], knownLocation: "Town Square" });
    StateModule.state.worldState.location = "Town Square";
    StateModule.state.worldState.time = "Monday, March 17, 07:00";
    StateModule.state.sceneLog = {
      "town square": { description: "A wet plaza.", weather: "heavy rain" },
    };
    VacuumSafetyModule.setAmbientRng(() => 0.99);
    const spy = vi.spyOn(UIManager, "appendChat");
    mockGenerateResponse.mockResolvedValue("The rain drums on the cobbles.");
    await GameEngine.executeTurn("You slip a coin into the beggar's cup.", false);
    expect(spy).not.toHaveBeenCalledWith("system", expect.stringContaining("reacts"));
    const guard = StateModule.state.npcProfiles.find((p) => p.npcName === "Guard");
    expect(guard?.trust).toBe(50);
    expect(guard?.affection).toBe(50);
    spy.mockRestore();
  });

  it("the vacuum note explains reduced visibility when conditions apply", () => {
    const s = StateModule.state;
    makeWitness("Guard", { knownLocation: "Town Square" });
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 23:00";
    VacuumSafetyModule.setAmbientRng(() => 0.01); // keep the witness so the note lists them
    const note = VacuumSafetyModule.generateVacuumNote("");
    expect(note).toContain("reduce how many of them notice");
    VacuumSafetyModule.setAmbientRng(null);
  });

  it("the vacuum note lists present NPCs even when ambient reduction hides them", () => {
    const s = StateModule.state;
    makeWitness("Guard", { knownLocation: "Town Square" });
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 23:00";
    // Rain/darkness + an unlucky roll: the guard would NOT notice (no reaction),
    // but they are still physically present — the note must never say "alone".
    VacuumSafetyModule.setAmbientRng(() => 0.99);
    expect(VacuumSafetyModule.getWitnesses().length).toBe(0);
    expect(VacuumSafetyModule.getPresentNPCs().length).toBe(1);
    const note = VacuumSafetyModule.generateVacuumNote("");
    expect(note).not.toContain("alone");
    expect(note).toContain("Guard");
    expect(note).toContain("reduce how many of them notice");
    VacuumSafetyModule.setAmbientRng(null);
  });

  it("the sneak synergy bonus scales with the Sneaking subskill", () => {
    const s = StateModule.state;
    s.subskills = {};
    expect(VacuumSafetyModule.ambientSneakBonus()).toBe(0);
    (s.subskills as any).sneaking = 10; // average -> no bonus
    expect(VacuumSafetyModule.ambientSneakBonus()).toBe(0);
    (s.subskills as any).sneaking = 25;
    expect(VacuumSafetyModule.ambientSneakBonus()).toBe(0.15);
    (s.subskills as any).sneaking = 60; // capped at 0.5
    expect(VacuumSafetyModule.ambientSneakBonus()).toBe(0.5);
  });

  it("sneaking tightens the notice factor only when ambient conditions apply", () => {
    const s = StateModule.state;
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 07:00";
    s.sceneLog = { "town square": { description: "Wet plaza.", weather: "heavy rain" } };
    (s.subskills as any).sneaking = 10;
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(0.5);
    (s.subskills as any).sneaking = 30;
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(0.4); // 0.5 * 0.8
    (s.subskills as any).sneaking = 60;
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(0.25); // 0.5 * 0.5 (cap)
    // Clear day: no ambient reduction -> no synergy, however sneaky.
    s.sceneLog = {};
    s.worldState.time = "Monday, March 17, 12:00";
    (s.subskills as any).sneaking = 60;
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(1);
  });

  it("the sneak synergy can push below the plain-ambient floor", () => {
    const s = StateModule.state;
    s.worldState.location = "Forest";
    s.worldState.time = "Monday, March 17, 23:00"; // night -> 0.5
    s.sceneLog = { forest: { description: "Dark pines.", weather: "drizzle" } }; // rain -> 0.25
    (s.subskills as any).sneaking = 60; // cap 0.5 -> factor 0.125
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(0.125);
  });

  it("sneaking can tip a witness from kept to excluded under identical conditions", () => {
    const s = StateModule.state;
    makeWitness("Guard", { knownLocation: "Town Square" });
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 07:00";
    s.sceneLog = { "town square": { description: "Wet plaza.", weather: "downpour" } };
    VacuumSafetyModule.setAmbientRng(() => 0.45);
    (s.subskills as any).sneaking = 10; // factor 0.5 -> 0.45 < 0.5: noticed
    expect(VacuumSafetyModule.getWitnesses().length).toBe(1);
    (s.subskills as any).sneaking = 30; // factor 0.4 -> 0.45 >= 0.4: hidden
    expect(VacuumSafetyModule.getWitnesses().length).toBe(0);
    VacuumSafetyModule.setAmbientRng(null);
  });

  it("the vacuum note mentions the MC's sneak riding the conditions", () => {
    const s = StateModule.state;
    makeWitness("Guard", { knownLocation: "Town Square" });
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 23:00";
    (s.subskills as any).sneaking = 40;
    VacuumSafetyModule.setAmbientRng(() => 0.01); // keep the witness
    const note = VacuumSafetyModule.generateVacuumNote("");
    expect(note).toContain("practiced Sneaking rides these conditions");
    VacuumSafetyModule.setAmbientRng(null);
  });

  it("sneaky non-family companions present add their own cover", () => {
    const s = StateModule.state;
    s.worldState.location = "Town Square";
    s.subskills = { sneaking: 10 } as any; // MC at average — no MC part
    // One sneaky sidekick present: contributes its own 0.15.
    makeWitness("Rook", { traits: ["sneaky"], knownLocation: "Town Square" });
    expect(VacuumSafetyModule.sneakyCompanionsPresent()).toBe(1);
    expect(VacuumSafetyModule.ambientSneakBonus()).toBe(0.15);
    // More companions stack up to the team cap (3 * 0.15 = 0.45).
    makeWitness("Vex", { traits: ["sneaky"], knownLocation: "Town Square" });
    makeWitness("Bolt", { traits: ["sneaky"], knownLocation: "Town Square" });
    expect(VacuumSafetyModule.ambientSneakBonus()).toBeCloseTo(0.45, 10);
    // A FAMILY member never counts, even with a sneaky trait.
    s.memory.relations.push({
      name: "Younger Sister",
      aliases: ["Sis"],
      disposition: "MC's younger sister",
      status: "Alive",
      modifiers: [],
    });
    makeWitness("Younger Sister", { traits: ["sneaky"], knownLocation: "Town Square" });
    expect(VacuumSafetyModule.ambientSneakBonus()).toBeCloseTo(0.45, 10);
    // A sneaky NPC elsewhere is not acting with the MC.
    makeWitness("Far Guy", { traits: ["sneaky"], knownLocation: "Diner" });
    expect(VacuumSafetyModule.ambientSneakBonus()).toBeCloseTo(0.45, 10);
  });

  it("an action explicitly involving a companion counts them even if elsewhere", () => {
    const s = StateModule.state;
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 07:00";
    s.sceneLog = { "town square": { description: "Wet plaza.", weather: "downpour" } };
    s.subskills = { sneaking: 10 } as any; // no MC part — isolate the companion
    // Rook is at the Diner, NOT present at Town Square.
    makeWitness("Rook", { traits: ["sneaky"], knownLocation: "Diner" });
    // No action mentions them -> not part of the crew here.
    expect(VacuumSafetyModule.sneakyCompanionsPresent()).toBe(0);
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(0.5);
    // The action coordinates with Rook by name -> full sneak credit.
    expect(VacuumSafetyModule.sneakyCompanionsPresent("Rook keeps watch while you slip between stalls")).toBe(1);
    expect(VacuumSafetyModule.ambientNoticeFactor("Rook keeps watch while you slip between stalls")).toBe(0.425);
  });

  it("a coordinated companion works through aliases and never counts family", () => {
    const s = StateModule.state;
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 07:00";
    s.sceneLog = { "town square": { description: "Wet plaza.", weather: "downpour" } };
    s.subskills = { sneaking: 10 } as any;
    makeWitness("Rook", { traits: ["sneaky"], knownLocation: "Diner" });
    // Alias mention counts: "Shadow" is Rook's relation alias.
    s.memory.relations.push({
      name: "Rook",
      aliases: ["Shadow"],
      disposition: "sneaky sidekick",
      status: "Alive",
      modifiers: [],
    });
    expect(VacuumSafetyModule.sneakyCompanionsPresent("Shadow distracts the merchant")).toBe(1);
    // Family stays excluded even when the action names them.
    s.memory.relations.push({
      name: "Sister",
      aliases: ["Mei"],
      disposition: "MC's younger sister",
      status: "Alive",
      modifiers: [],
    });
    makeWitness("Sister", { traits: ["sneaky"], knownLocation: "Diner" });
    // Sister never counts — naming her alone adds nothing (0), and naming
    // her alongside Rook still counts only Rook (1).
    expect(VacuumSafetyModule.sneakyCompanionsPresent("Sister helps me hide")).toBe(0);
    expect(VacuumSafetyModule.sneakyCompanionsPresent("Sister and Rook help me hide")).toBe(1);
  });

  it("a coordinated companion can tip a witness roll like a present one", () => {
    const s = StateModule.state;
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 07:00";
    s.sceneLog = { "town square": { description: "Wet plaza.", weather: "downpour" } };
    s.subskills = { sneaking: 10 } as any;
    makeWitness("Guard", { knownLocation: "Town Square" });
    makeWitness("Rook", { traits: ["sneaky"], knownLocation: "Diner" });
    VacuumSafetyModule.setAmbientRng(() => 0.46);
    // No coordination: factor 0.5 -> 0.46 < 0.5: the guard notices.
    expect(VacuumSafetyModule.getWitnesses().length).toBe(1);
    // Coordinated: factor 0.425 -> 0.46 >= 0.425: the guard misses it.
    expect(VacuumSafetyModule.getWitnesses("Rook watches the far end of the square").length).toBe(0);
    VacuumSafetyModule.setAmbientRng(null);
  });

  it("a sneaky companion tightens the notice factor under rain", () => {
    const s = StateModule.state;
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 07:00";
    s.sceneLog = { "town square": { description: "Wet plaza.", weather: "downpour" } };
    s.subskills = { sneaking: 10 } as any; // no MC part
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(0.5);
    // MC average + one sneaky companion: 0.5 * (1 - 0.15) = 0.425.
    makeWitness("Rook", { traits: ["sneaky"], knownLocation: "Town Square" });
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(0.425);
    // MC 25 (0.15) + companion (0.15) = 0.30 -> 0.5 * 0.7 = 0.35.
    (s.subskills as any).sneaking = 25;
    expect(VacuumSafetyModule.ambientNoticeFactor()).toBe(0.35);
  });

  it("a companion can tip a witness from kept to excluded under an identical roll", () => {
    const s = StateModule.state;
    makeWitness("Guard", { knownLocation: "Town Square" });
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 07:00";
    s.sceneLog = { "town square": { description: "Wet plaza.", weather: "downpour" } };
    s.subskills = { sneaking: 10 } as any;
    VacuumSafetyModule.setAmbientRng(() => 0.46);
    // No companion: factor 0.5 -> 0.46 < 0.5: the guard notices.
    expect(VacuumSafetyModule.getWitnesses().length).toBe(1);
    // A sneaky companion arrives: factor 0.425 -> 0.46 >= 0.425: hidden.
    makeWitness("Rook", { traits: ["sneaky"], knownLocation: "Town Square" });
    expect(VacuumSafetyModule.getWitnesses().length).toBe(0);
    VacuumSafetyModule.setAmbientRng(null);
  });

  it("the vacuum note mentions sneaky companions when they contribute", () => {
    const s = StateModule.state;
    makeWitness("Guard", { knownLocation: "Town Square" });
    makeWitness("Rook", { traits: ["sneaky"], knownLocation: "Town Square" });
    s.worldState.location = "Town Square";
    s.worldState.time = "Monday, March 17, 23:00";
    s.subskills = { sneaking: 10 } as any;
    VacuumSafetyModule.setAmbientRng(() => 0.01); // keep the guard listed
    const note = VacuumSafetyModule.generateVacuumNote("");
    expect(note).toContain("and a sneaky companion ride these conditions");
    VacuumSafetyModule.setAmbientRng(null);
  });

  it("a 'sneaky sidekick' disposition infers the sneaky trait", () => {
    const profile = NPCProfileModule.profileFromRelation(
      "Rook",
      "MC's loyal sneaky sidekick",
      [],
    );
    expect(profile.traits).toContain("sneaky");
  });

  it("E2E: rain + high sneak silences a reaction that low sneak would trigger", async () => {
    makeWitness("Guard", { traits: [], knownLocation: "Town Square" });
    StateModule.state.worldState.location = "Town Square";
    StateModule.state.worldState.time = "Monday, March 17, 07:00";
    StateModule.state.sceneLog = {
      "town square": { description: "Wet plaza.", weather: "downpour" },
    };
    (StateModule.state.subskills as any).sneaking = 30;
    VacuumSafetyModule.setAmbientRng(() => 0.45);
    const spy = vi.spyOn(UIManager, "appendChat");
    mockGenerateResponse.mockResolvedValue("The rain drums on the cobbles.");
    await GameEngine.executeTurn("You try to lift a coin from the merchant's stall.", false);
    expect(spy).not.toHaveBeenCalledWith("system", expect.stringContaining("reacts"));
    const guard = StateModule.state.npcProfiles.find((p) => p.npcName === "Guard");
    expect(guard?.trust).toBe(50);
    expect(guard?.affection).toBe(50);
    spy.mockRestore();
  });
});

// ===========================================================================
// 1. Season validation in [SCENE]
// ===========================================================================

describe("Season validation — the calendar corrects a mismatched [SCENE] season gently", () => {
  beforeEach(resetState);

  it("corrects a season mismatch and notes it instead of silently overwriting", async () => {
    StateModule.state.worldState.time = "Monday, March 17, 07:00"; // Spring
    mockGenerateResponse.mockResolvedValue(
      '[SCENE]{"location":"High School","description":"The schoolyard is empty.","season":"Winter"}[/SCENE]',
    );
    await GameEngine.executeTurn("You step outside.", false);
    // The calendar wins; the discrepancy is recorded as a gentle note.
    expect(StateModule.state.sceneLog["high school"]).toEqual({
      description: "The schoolyard is empty.",
      season: "Spring",
      seasonNote: 'Scene recorded "Winter" but the calendar says Spring — using Spring.',
    });
    // The next prompt re-injects the corrected season AND the note.
    StateModule.state.worldState.location = "High School";
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("season: Spring");
    expect(prompt).toContain("SCENE NOTE (consistency)");
    expect(prompt).toContain("calendar says Spring");
  });

  it("keeps a matching season with no note", async () => {
    StateModule.state.worldState.time = "Monday, December 29, 07:00"; // Winter
    mockGenerateResponse.mockResolvedValue(
      '[SCENE]{"location":"Cafeteria","description":"Steam rises from the stew pot.","season":"deep winter"}[/SCENE]',
    );
    await GameEngine.executeTurn("You enter the cafeteria.", false);
    expect(StateModule.state.sceneLog["cafeteria"].season).toBe("deep winter");
    expect(StateModule.state.sceneLog["cafeteria"].seasonNote).toBeUndefined();
  });

  it("does not validate when the calendar has no month (legacy clock)", async () => {
    StateModule.state.worldState.time = "Day 3, 14:30";
    mockGenerateResponse.mockResolvedValue(
      '[SCENE]{"location":"Camp","description":"Tents by the river.","season":"winter"}[/SCENE]',
    );
    await GameEngine.executeTurn("You return to camp.", false);
    expect(StateModule.state.sceneLog["camp"].season).toBe("winter");
    expect(StateModule.state.sceneLog["camp"].seasonNote).toBeUndefined();
  });

  it("[SEASON_SHIFT] records a story-driven season as canon", async () => {
    StateModule.state.worldState.time = "Monday, March 17, 07:00"; // calendar Spring
    mockGenerateResponse.mockResolvedValue(
      'The chill deepens overnight.\n[SEASON_SHIFT]{"season":"late winter"}[/SEASON_SHIFT]',
    );
    await GameEngine.executeTurn("The realm's seasons shift.", false);
    // Canonicalized to the season word.
    expect(StateModule.state.seasonOverride).toBe("Winter");
    // The tag is stripped from the chat display.
    expect(StateModule.state.history[1].content).toContain("[SEASON_SHIFT]");
  });

  it("an override suppresses the calendar-mismatch note for matching scenes", async () => {
    StateModule.state.worldState.time = "Monday, March 17, 07:00"; // calendar Spring
    StateModule.state.seasonOverride = "Winter";
    mockGenerateResponse.mockResolvedValue(
      '[SCENE]{"location":"Mountains","description":"Snow buries the pass.","season":"Winter"}[/SCENE]',
    );
    await GameEngine.executeTurn("You climb toward the pass.", false);
    // The calendar would say Spring — but the override is canon: no note.
    expect(StateModule.state.sceneLog["mountains"]).toEqual({
      description: "Snow buries the pass.",
      season: "Winter",
    });
    expect(StateModule.state.sceneLog["mountains"].seasonNote).toBeUndefined();
  });

  it("an override still corrects a scene that contradicts the ESTABLISHED season", async () => {
    StateModule.state.worldState.time = "Monday, March 17, 07:00";
    StateModule.state.seasonOverride = "Winter";
    mockGenerateResponse.mockResolvedValue(
      '[SCENE]{"location":"Gardens","description":"Frosted hedges.","season":"Summer"}[/SCENE]',
    );
    await GameEngine.executeTurn("You walk through the gardens.", false);
    expect(StateModule.state.sceneLog["gardens"].season).toBe("Winter");
    expect(StateModule.state.sceneLog["gardens"].seasonNote).toBe(
      'Scene recorded "Summer" but the established season is Winter — using Winter.',
    );
  });

  it("the next turn's payload carries the override as CURRENT SEASON", async () => {
    StateModule.state.worldState.time = "Monday, March 17, 07:00";
    mockGenerateResponse.mockResolvedValue(
      '[SEASON_SHIFT]{"season":"Winter"}[/SEASON_SHIFT]\nThe frost grips the realm.',
    );
    await GameEngine.executeTurn("An unnatural winter falls.", false);
    expect(StateModule.state.seasonOverride).toBe("Winter");
    // Turn 2's main-call payload must anchor the override (the calendar would
    // still say Spring — the clock didn't move months).
    mockGenerateResponse.mockClear();
    mockGenerateResponse.mockResolvedValue("The frost deepens.");
    await GameEngine.executeTurn("You bundle up.", false);
    const sawOverride = mockGenerateResponse.mock.calls.some((c) =>
      String(c[1]).includes("CURRENT SEASON: Winter"),
    );
    expect(sawOverride).toBe(true);
  });

  it("rejects malformed [SEASON_SHIFT] JSON without touching the override", async () => {
    StateModule.state.seasonOverride = undefined;
    mockGenerateResponse.mockResolvedValue(
      "A cold wind blows.\n[SEASON_SHIFT]{not json}[/SEASON_SHIFT]",
    );
    await GameEngine.executeTurn("You shiver.", false);
    expect(StateModule.state.seasonOverride).toBeUndefined();
  });
});

// ===========================================================================
// 1. Stat-check pipeline
// ===========================================================================

describe("Stat-check pipeline — how the AI is instructed to use stats", () => {
  beforeEach(resetState);

  it("instructs the AI on stat checks in the system prompt and per-turn payload", async () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(
      "STAT CHECKS ACTIVE: Compare the MC's EFFECTIVE stats against the challenge.",
    );
    expect(prompt).toContain("Do not auto-win challenges.");
    // Relationship disposition feeds into challenge difficulty (statChecks block).
    expect(prompt).toContain(
      "RELATIONSHIPS INFLUENCE ACTIONS: Hostile NPCs increase difficulty.",
    );
    // Stat caps are part of the same "use the numbers" contract.
    expect(prompt).toContain("STAT CAP ENFORCEMENT");
    expect(prompt).toContain("HUMAN PEAK RULE");

    mockGenerateResponse.mockResolvedValue("The bandit snarls.");
    await GameEngine.executeTurn("I attack the bandit.", false);

    const [, payloadText] = mockGenerateResponse.mock.calls[0] as [string, string];
    expect(payloadText).toContain(
      "[SYSTEM INSTRUCTION FOR THIS ACTION: Evaluate success/failure based on MC effective stats vs challenge difficulty.",
    );
    expect(payloadText).toContain("Cultivation tier (Tier 0) multiplies base stats by +0%");
    expect(payloadText).toContain("Effective Stats: STR 10, AGI 10, INT 10, CHA 10.");
  });

  it("a coordinated action grants +2 effective CHA for the turn's checks", async () => {
    const s = StateModule.state;
    s.char.cha = 20;
    makeWitness("Rook", { traits: ["sneaky", "loyal"], knownLocation: "Diner" });
    s.memory.relations.push({
      name: "Rook",
      aliases: ["Shadow"],
      disposition: "sneaky sidekick",
      status: "Alive",
      modifiers: [],
    });
    expect(VacuumSafetyModule.coordinatedCompanions("You and Rook work the crowd together")).toBe(1);
    expect(VacuumSafetyModule.coordinatedCompanions("You act alone")).toBe(0);

    mockGenerateResponse.mockResolvedValue("You and Rook charm the merchant.");
    await GameEngine.executeTurn("You and Rook work the crowd together, closing the deal.", false);
    const [, payloadText] = mockGenerateResponse.mock.calls[0] as [string, string];
    expect(payloadText).toContain("CHA 20 (+2 while working with Rook)");
    expect(payloadText).toContain(
      "Coordination bonus in effect: the CHA shown above includes +2 because the MC is explicitly working with Rook",
    );
  });

  it("no coordination bonus when the action names no companion — or only family", async () => {
    const s = StateModule.state;
    s.char.cha = 20;
    makeWitness("Rook", { traits: ["sneaky"], knownLocation: "Diner" });
    s.memory.relations.push({
      name: "Rook",
      aliases: ["Shadow"],
      disposition: "sneaky sidekick",
      status: "Alive",
      modifiers: [],
    });
    // Family named in the action never grants the bonus.
    s.memory.relations.push({
      name: "Sister",
      aliases: ["Mei"],
      disposition: "MC's younger sister",
      status: "Alive",
      modifiers: [],
    });
    makeWitness("Sister", { traits: [], knownLocation: "MC Bedroom" });
    expect(VacuumSafetyModule.coordinatedCompanions("Sister walks beside you")).toBe(0);

    mockGenerateResponse.mockResolvedValue("You act alone.");
    await GameEngine.executeTurn("I walk through town by myself.", false);
    const [, payloadText] = mockGenerateResponse.mock.calls[0] as [string, string];
    expect(payloadText).toContain("Effective Stats: STR 10, AGI 10, INT 10, CHA 20.");
    expect(payloadText).not.toContain("coordinated companion");
  });

  it("the coordination bonus names the crew and caps at +5 for a full team", async () => {
    const s = StateModule.state;
    s.char.cha = 20;
    makeWitness("Rook", { traits: ["sneaky"], knownLocation: "Diner" });
    makeWitness("Elle", { traits: ["honest"], knownLocation: "Library" });
    makeWitness("Mara", { traits: ["generous"], knownLocation: "Market" });
    for (const name of ["Rook", "Elle", "Mara"]) {
      s.memory.relations.push({
        name,
        aliases: [],
        disposition: "ally",
        status: "Alive",
        modifiers: [],
      });
    }
    expect(VacuumSafetyModule.coordinatedCompanionNames("Rook, Elle and Mara work the crowd together")).toEqual(["Rook", "Elle", "Mara"]);
    expect(VacuumSafetyModule.coordinatedCompanions("Rook, Elle and Mara work the crowd together")).toBe(3);

    mockGenerateResponse.mockResolvedValue("The whole crew closes the deal.");
    await GameEngine.executeTurn("Rook, Elle and Mara work the crowd together.", false);
    const [, payloadText] = mockGenerateResponse.mock.calls[0] as [string, string];
    expect(payloadText).toContain("CHA 20 (+5 while working with Rook and Elle and Mara)");
    expect(payloadText).toContain(
      "Coordination bonus in effect: the CHA shown above includes +5 because the MC is explicitly working with Rook and Elle and Mara",
    );
  });

  it("non-sneaky companions also grant the coordination bonus via alias", () => {
    const s = StateModule.state;
    makeWitness("Elle", { traits: ["honest"], knownLocation: "Library" });
    s.memory.relations.push({
      name: "Elle",
      aliases: ["El"],
      disposition: "librarian",
      status: "Alive",
      modifiers: [],
    });
    expect(VacuumSafetyModule.coordinatedCompanions("El speaks first, vouching for you")).toBe(1);
    expect(VacuumSafetyModule.coordinatedCompanions("Rook helps")).toBe(0);
  });

  it("an NPC the action is trying to get past never counts as a coordinated companion", async () => {
    const s = StateModule.state;
    s.char.cha = 20;
    // The live-test case: a hostile administrator the MC talks their way past.
    makeWitness("Zhao", { traits: ["proud"], aggressionThreshold: 75, knownLocation: "High School" });
    s.memory.relations.push({
      name: "Zhao",
      aliases: ["Vice-Principal Zhao", "Vice-Principal"],
      disposition: "Hostile administrator",
      status: "Alive",
      modifiers: [],
    });
    expect(VacuumSafetyModule.coordinatedCompanions("I try to talk my way past Vice-Principal Zhao")).toBe(0);
    expect(VacuumSafetyModule.coordinatedCompanions("I slip past Zhao to the office")).toBe(0);

    // A warm NPC is still the target when the action persuades/deceives them
    // — that is not teamwork.
    makeWitness("Elle", { traits: ["honest"], aggressionThreshold: 50, knownLocation: "Library" });
    s.memory.relations.push({
      name: "Elle",
      aliases: ["El"],
      disposition: "Friendly librarian",
      status: "Alive",
      modifiers: [],
    });
    expect(VacuumSafetyModule.coordinatedCompanions("You convince El to open the archive")).toBe(0);
    expect(VacuumSafetyModule.coordinatedCompanions("You deceive El about the heirloom")).toBe(0);
    expect(VacuumSafetyModule.coordinatedCompanions("El speaks first, vouching for you")).toBe(1);

    // E2E: the bonus must not reach the payload when the action only names
    // the person being gotten past.
    mockGenerateResponse.mockResolvedValue("The vice-principal blocks the door.");
    await GameEngine.executeTurn(
      "I try to talk my way past Vice-Principal Zhao to reach the inner office.",
      false,
    );
    const [, payloadText] = mockGenerateResponse.mock.calls[0] as [string, string];
    expect(payloadText).toContain("Effective Stats: STR 10, AGI 10, INT 10, CHA 20.");
    expect(payloadText).not.toContain("coordinated companion");
  });

  it("E2E regression: hostile NPC + 'past' yields a clean payload and a roll line naming the NPC", async () => {
    const s = StateModule.state;
    s.char.cha = 20;
    s.subskills.negotiation = 26;
    makeWitness("Zhao", { traits: ["proud"], aggressionThreshold: 75, knownLocation: "High School" });
    s.memory.relations.push({
      name: "Zhao",
      aliases: ["Vice-Principal Zhao", "Vice-Principal"],
      disposition: "Hostile administrator",
      status: "Alive",
      modifiers: [],
    });
    setCheckRng(() => 0.5); // roll 11

    // The AI narrates the confrontation and declares the check, naming Zhao
    // in the context — the exact shape of the live bug turn.
    mockGenerateResponse.mockResolvedValue(
      'Zhao blocks the corridor.\\n[CHECK]{"stat":"NEGOTIATION","difficulty":"hard","context":"talking my way past Vice-Principal Zhao"}[/CHECK]',
    );
    await GameEngine.executeTurn("I try to talk my way past Vice-Principal Zhao.", false);

    // 1) The model payload carries no coordination bonus — the fix that
    //    stops the MC being credited as "working with" the person they're
    //    trying to get PAST.
    const [, payloadText] = mockGenerateResponse.mock.calls[0] as [string, string];
    expect(payloadText).toContain("Effective Stats: STR 10, AGI 10, INT 10, CHA 20.");
    expect(payloadText).not.toContain("coordinated companion");
    expect(payloadText).not.toContain("while working with");

    // 2) The engine rolled the declared check and the system line references
    //    the NPC through the check's context — the roll is about Zhao, not a
    //    buddy lending a hand.
    const systemLines = s.history.filter((h) => h.role === "system").map((h) => h.content);
    const rollLine = systemLines.find((l) => l.includes("⚔️"));
    expect(rollLine).toBeDefined();
    expect(rollLine).toContain("Negotiation check");
    expect(rollLine).toContain("Vice-Principal Zhao");
    expect(s.checkLog[0]).toMatchObject({
      stat: "NEGOTIATION",
      difficulty: "hard",
      outcome: "critical_success",
      context: "talking my way past Vice-Principal Zhao",
    });
  });

  it("an NPC acting adversarially in the action is not a teammate", () => {
    const s = StateModule.state;
    makeWitness("Zhao", { traits: ["proud"], aggressionThreshold: 50, knownLocation: "High School" });
    s.memory.relations.push({
      name: "Zhao",
      aliases: ["Vice-Principal Zhao"],
      disposition: "neutral administrator",
      status: "Alive",
      modifiers: [],
    });
    // Neutral in state, but the action itself makes Zhao the obstacle.
    expect(VacuumSafetyModule.coordinatedCompanions("Zhao blocks the door")).toBe(0);
    expect(VacuumSafetyModule.coordinatedCompanions("Zhao refuses to let you pass")).toBe(0);
    // A noun later in the action ("to the guards") never flips a cooperative
    // mention into an adversarial one — regression for the live turn.
    expect(VacuumSafetyModule.coordinatedCompanions("Zhao vouches for me to the guards")).toBe(1);
    // A marker aimed at a different NPC ("past the guard") doesn't taint the
    // companion Zhao either.
    expect(VacuumSafetyModule.coordinatedCompanions("I slip past the guard with Zhao")).toBe(1);
    // Same NPC cooperating with the MC counts.
    expect(VacuumSafetyModule.coordinatedCompanions("Zhao vouches for you at the gate")).toBe(1);
  });

  it("an adversary recorded in state never lends sneak cover, even when present", () => {
    const s = StateModule.state;
    s.worldState.location = "Warehouse";
    makeWitness("Guard", { traits: ["sneaky", "cautious"], aggressionThreshold: 70, knownLocation: "Warehouse" });
    s.memory.relations.push({
      name: "Guard",
      aliases: [],
      disposition: "Hostile guard",
      status: "Alive",
      modifiers: [],
    });
    // Present AND sneaky, but recorded as an adversary — never a sidekick.
    expect(VacuumSafetyModule.sneakyCompanionsPresent()).toBe(0);
    expect(VacuumSafetyModule.sneakyCompanionsPresent("Rook keeps watch while you slip between stalls")).toBe(0);

    // The same guard warmed up via [RELATION] starts counting as a sidekick.
    s.memory.relations[0].disposition = "Friendly guard";
    expect(VacuumSafetyModule.sneakyCompanionsPresent()).toBe(1);
  });

  it("shows base and effective stats, scaled by cultivation tier", () => {
    expect(buildSystemPrompt()).toContain("Base STR: 10 (Effective: 10)");

    StateModule.state.char.cultivation = 1.0; // +20% per tier
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Base STR: 10 (Effective: 12)");
    expect(prompt).toContain("Base AGI: 10 (Effective: 12)");
    expect(prompt).toContain("Base INT: 10 (Effective: 12)");
    expect(prompt).toContain("Base CHA: 10 (Effective: 12)");
    expect(prompt).toContain("Cultivation Tier: 1.");
  });

  it("applies the AI's stat changes via STATE_UPDATE and feeds new effective values into later turns", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'You land a blow. [STATE_UPDATE]{"str": 16, "time": "Monday, March 17, 07:10"}[/STATE_UPDATE]',
      )
      .mockResolvedValueOnce(
        'You push through. [STATE_UPDATE]{"str": 16, "cultivation": 1.0}[/STATE_UPDATE]',
      )
      .mockResolvedValueOnce("The fight ends. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I attack the bandit.", false);
    expect(StateModule.state.char.str).toBe(16);
    expect(StateModule.state.char.cultivation).toBe(0);

    await GameEngine.executeTurn("I keep fighting.", false);
    expect(StateModule.state.char.cultivation).toBe(1.0);
    // Turn 2's prompt reflected the STR change while the MC was still mortal.
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    const turn2Payload = mockGenerateResponse.mock.calls[1][1] as string;
    expect(turn2Prompt).toContain("Base STR: 16 (Effective: 16)");
    expect(turn2Payload).toContain("Effective Stats: STR 16, AGI 10, INT 10, CHA 10.");

    // Turn 3: the cultivation jump 0 -> 1.0 auto-triggers Mortal Awakening
    // (+1 all) and Qi Gathering (+2/+2/+2/+1), so base STR is now 19, and
    // effective STR = floor(19 * 1.2) = 22. The breakthrough list also lands
    // in the next prompt.
    await GameEngine.executeTurn("I finish him.", false);
    expect(StateModule.state.char.breakthroughs.map((b) => b.id)).toContain("qi_gathering");
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    const turn3Payload = mockGenerateResponse.mock.calls[2][1] as string;
    expect(turn3Prompt).toContain("Base STR: 19 (Effective: 22)");
    expect(turn3Prompt).toContain("Cultivation Tier: 1.");
    expect(turn3Prompt).toContain("Breakthroughs Achieved:");
    expect(turn3Prompt).toContain("Qi Gathering");
    expect(turn3Payload).toContain("Effective Stats: STR 22, AGI 15, INT 15, CHA 14.");
  });

  it("omits the stat-check instructions when the toggle is off", async () => {
    StateModule.state.toggles.statChecks = false;
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("STAT CHECKS ACTIVE");
    expect(prompt).not.toContain("RELATIONSHIPS INFLUENCE ACTIONS");

    mockGenerateResponse.mockResolvedValue("Nothing happens.");
    await GameEngine.executeTurn("I try.", false);
    expect(mockGenerateResponse.mock.calls[0][1]).not.toContain(
      "SYSTEM INSTRUCTION FOR THIS ACTION",
    );
  });

  it("an active Charm Aura raises effective CHA in the prompt, payload, and CHA-based subskills", async () => {
    StateModule.state.modifiers.charm_aura =
      "active (5t/5t, 50m/50m): +20% CHA vs attracted targets";

    // System prompt: the AI compares the boosted CHA against difficulty.
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Base CHA: 10 (Effective: 12)");
    // Other stats are untouched by the aura.
    expect(prompt).toContain("Base STR: 10 (Effective: 10)");

    // Per-turn payload: the same effective numbers reach the action evaluation.
    mockGenerateResponse.mockResolvedValue("The crowd leans in.");
    await GameEngine.executeTurn("I try to charm the barmaid.", false);
    const [, payloadText] = mockGenerateResponse.mock.calls[0] as [string, string];
    expect(payloadText).toContain("Effective Stats: STR 10, AGI 10, INT 10, CHA 12.");

    // CHA-based subskills recompute off the boosted effective CHA.
    StateModule.recalculateSubskills();
    expect(StateModule.state.subskills.seduction).toBe(11); // floor((12+10)/2)
    // Genre subskills too (Deception needs no genre to be available).
    const deception = SUBSKILLS.find((sk) => sk.id === "deception")!;
    expect(GenreModule.computeSubskill(deception)).toBe(11); // floor((10+12)/2)
  });

  it("the aura's CHA bonus disappears once the effect expires", async () => {
    mockGenerateResponse.mockResolvedValueOnce(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK] [SKILL_USE]{"skill":"charm_aura","duration":2}[/SKILL_USE]',
    );
    await GameEngine.executeTurn("I activate my charm.", false);

    // Turn 2: the aura is still live (1 of 2 turns left), CHA is boosted.
    mockGenerateResponse.mockResolvedValue("You walk on.");
    await GameEngine.executeTurn("I continue.", false);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    expect(turn2Prompt).toContain("Base CHA: 10 (Effective: 12)");
    expect(turn2Prompt).toContain("charm_aura");

    // The 2-turn aura expires during turn 3's tick: the bonus is gone.
    mockGenerateResponse.mockResolvedValue("You walk on.");
    await GameEngine.executeTurn("I continue.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    expect(turn3Prompt).toContain("Base CHA: 10 (Effective: 10)");
    expect(StateModule.state.modifiers.charm_aura).toBeUndefined();
  });

  it("scales the aura's CHA bonus with the skill's level", () => {
    SkillModule.extract(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK]',
    );
    // The MC invests points: level-3 aura.
    const aura = StateModule.state.char.learnedSkills.find((sk) => sk.id === "charm_aura");
    if (aura) aura.level = 3;
    // No numeric bonus declared -> the level-scaled default applies.
    SkillModule.extract(
      '[SKILL_USE]{"skill":"charm_aura","effect":"Radiate an aura that draws others in","duration":5}[/SKILL_USE]',
    );

    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Base CHA: 10 (Effective: 14)"); // 10 + (1 base + 3 levels)
    StateModule.recalculateSubskills();
    expect(StateModule.state.subskills.seduction).toBe(12); // floor((14+10)/2)
  });
});

// ===========================================================================
// 1b. Stat-check outcome framework — [CHECK] tags, engine rolls, momentum
// ===========================================================================

describe("Stat-check outcome framework — the engine rolls, the story feels it", () => {
  beforeEach(resetState);

  it("computes target from declared difficulty and effective stat, mapping the margin to seven tiers", () => {
    const s = StateModule.state;
    s.char.str = 16;
    // roll 15 + STR 16 = 31 vs hard 14 -> margin +17 -> critical success.
    setCheckRng(() => 0.7); // floor(0.7*20)+1 = 15
    const r = resolveCheckForTest({ stat: "STR", difficulty: "hard" });
    expect(r).not.toBeNull();
    expect(DIFFICULTY_BASE.hard).toBe(14);
    expect(r!.roll).toBe(15);
    expect(r!.effectiveStat).toBe(16);
    expect(r!.target).toBe(14);
    expect(r!.score).toBe(31);
    expect(r!.outcome).toBe("critical_success");
  });

  it("a natural 1 is always a critical failure and a natural 20 always a critical success", () => {
    setCheckRng(() => 0.0); // roll 1
    const f = resolveCheckForTest({ stat: "CHA", difficulty: "trivial" });
    expect(f!.outcome).toBe("critical_failure");
    setCheckRng(() => 0.999); // roll 20
    const c = resolveCheckForTest({ stat: "CHA", difficulty: "brutal" });
    expect(c!.outcome).toBe("critical_success");
  });

  it("LCK nudges the dice: 15 LCK adds +1, 5 LCK subtracts 1, capped at ±2", () => {
    const s = StateModule.state;
    s.char.lck = 15;
    setCheckRng(() => 0.3); // roll 7
    const r = resolveCheckForTest({ stat: "INT", difficulty: "easy" });
    expect(r!.score).toBe(7 + 1 + 10); // roll + LCK + INT
    s.char.lck = 5;
    const r2 = resolveCheckForTest({ stat: "INT", difficulty: "easy" });
    expect(r2!.score).toBe(7 - 1 + 10);
    // LCK checks use the LCK stat itself (20) and don't ALSO get the LCK
    // modifier on top of themselves.
    s.char.lck = 20;
    const r3 = resolveCheckForTest({ stat: "LCK", difficulty: "easy" });
    expect(r3!.lckMod).toBe(0);
    expect(r3!.score).toBe(7 + 20);
  });

  it("maps every outcome tier to the next check's target modifier", () => {
    expect(TIER_MOD).toEqual({
      critical_failure: 4,
      major_failure: 2,
      minor_failure: 1,
      neutral: 0,
      minor_success: -1,
      major_success: -2,
      critical_success: -4,
    });
  });

  it("a critical failure makes the next same-stat check harder, escalating per streak", () => {
    const s = StateModule.state;
    setCheckRng(() => 0.0); // natural 1 -> critical_failure, every time
    // Attempt 1: clean target.
    const r1 = resolveCheckForTest({ stat: "CHA", difficulty: "moderate" });
    expect(r1!.outcome).toBe("critical_failure");
    expect(r1!.momentumMod).toBe(0);
    expect(s.checkMomentum.CHA).toEqual({ outcome: "critical_failure", streak: 1 });
    // Attempt 2: streak 1 -> +4 (streak escalation starts at streak 2).
    const r2 = resolveCheckForTest({ stat: "CHA", difficulty: "moderate" });
    expect(r2!.target).toBe(DIFFICULTY_BASE.moderate + 4);
    expect(r2!.momentumMod).toBe(4);
    expect(r2!.line).toContain("harder: +4 target");
    // Attempt 3: streak 2 -> +5.
    const r3 = resolveCheckForTest({ stat: "CHA", difficulty: "moderate" });
    expect(r3!.momentumMod).toBe(5);
    expect(s.checkMomentum.CHA.streak).toBe(3);
    // Attempt 4: streak 3 -> +6 (escalation capped at 2, then cap at 6).
    const r4 = resolveCheckForTest({ stat: "CHA", difficulty: "moderate" });
    expect(r4!.momentumMod).toBe(6);
  });

  it("a success on the same line resets the failure streak and eases the next attempt", () => {
    const s = StateModule.state;
    s.char.cha = 20;
    setCheckRng(() => 0.0); // natural 1 -> critical_failure
    resolveCheckForTest({ stat: "CHA", difficulty: "easy" });
    expect(s.checkMomentum.CHA.streak).toBe(1);
    // Now a strong roll: success breaks the streak.
    setCheckRng(() => 0.999); // natural 20 -> critical_success
    const r = resolveCheckForTest({ stat: "CHA", difficulty: "easy" });
    expect(r!.outcome).toBe("critical_success");
    expect(s.checkMomentum.CHA).toEqual({ outcome: "critical_success", streak: 1 });
    // The NEXT attempt inherits the critical success ease: -4 target.
    setCheckRng(() => 0.3);
    const r2 = resolveCheckForTest({ stat: "CHA", difficulty: "easy" });
    expect(r2!.momentumMod).toBe(-4);
    expect(r2!.line).toContain("easier: -4 target");
  });

  it("a different stat leaves the original line's momentum dormant", () => {
    const s = StateModule.state;
    setCheckRng(() => 0.0); // critical_failure on CHA
    resolveCheckForTest({ stat: "CHA", difficulty: "easy" });
    // STR check in between does not touch CHA's streak.
    resolveCheckForTest({ stat: "STR", difficulty: "easy" });
    expect(s.checkMomentum.CHA.streak).toBe(1);
    // Returning to CHA still inherits the +4 penalty.
    const back = resolveCheckForTest({ stat: "CHA", difficulty: "easy" });
    expect(back!.momentumMod).toBe(4);
  });

  it("subskill checks use the subskill value and carry their own momentum", () => {
    const s = StateModule.state;
    (s.subskills as any).sneaking = 25;
    setCheckRng(() => 0.5); // roll 11
    const r = resolveCheckForTest({ stat: "Sneaking", difficulty: "hard" });
    expect(r!.effectiveStat).toBe(25);
    expect(r!.score).toBe(11 + 25);
    expect(s.checkMomentum.SNEAKING).toBeDefined();
  });

  it("unknown stat names are skipped without touching momentum", () => {
    expect(resolveCheckForTest({ stat: "Pizzazz", difficulty: "easy" })).toBeNull();
    expect(StateModule.state.checkMomentum).toEqual({});
  });

  it("infers hard difficulty when the context names an aggressive NPC", () => {
    makeWitness("Guard", { aggressionThreshold: 70, knownLocation: "Starting Location" });
    const r = resolveCheck({ stat: "CHA", context: "convincing the guard" });
    expect(r!.difficulty).toBe("hard");
    expect(r!.target).toBe(DIFFICULTY_BASE.hard);
    expect(r!.inferred).toBe(true);
    expect(r!.line).toContain("vs hard 14");
    expect(r!.line).toContain("(inferred)");
  });

  it("an 80+ aggression target defaults to brutal", () => {
    makeWitness("Guard", { aggressionThreshold: 85, knownLocation: "Starting Location" });
    const r = resolveCheck({ stat: "CHA", context: "convincing the guard" });
    expect(r!.difficulty).toBe("brutal");
  });

  it("a hostile disposition on a relation raises the check even without a profile", () => {
    StateModule.state.memory.relations.push({
      name: "Baron Voss",
      aliases: [],
      disposition: "Hostile noble who resents the MC",
      status: "Alive",
      modifiers: [],
    });
    const r = resolveCheck({ stat: "CHA", context: "asking Baron Voss for a favor" });
    expect(r!.difficulty).toBe("hard");
  });

  it("a named friendly NPC eases the check", () => {
    makeWitness("Mara", { affection: 80, trust: 60, knownLocation: "Starting Location" });
    const r = resolveCheck({ stat: "CHA", context: "asking Mara a favor" });
    expect(r!.difficulty).toBe("easy");
  });

  it("an action working WITH a hostile NPC eases the check ('Zhao vouches for you')", () => {
    const s = StateModule.state;
    makeWitness("Zhao", { aggressionThreshold: 75, knownLocation: "Starting Location" });
    s.memory.relations.push({
      name: "Zhao",
      aliases: ["Vice-Principal Zhao", "Vice-Principal"],
      disposition: "Hostile administrator",
      status: "Alive",
      modifiers: [],
    });
    // Same NPC, same hostility in state — but the ACTION works with him, so
    // his recorded disposition no longer drives the tier.
    expect(resolveCheck({ stat: "CHA" }, "Zhao vouches for you at the gate")!.difficulty).toBe("easy");
    expect(resolveCheck({ stat: "CHA" }, "you and Zhao cover the square together")!.difficulty).toBe("easy");
    // ...and the alias resolves too ("Vice-Principal Zhao" <-> "Zhao").
    expect(resolveCheck({ stat: "CHA" }, "Zhao speaks up for you in the office")!.difficulty).toBe("easy");
  });

  it("a later noun in the action never flips cooperation into hostility", () => {
    const s = StateModule.state;
    makeWitness("Zhao", { aggressionThreshold: 75, knownLocation: "Starting Location" });
    s.memory.relations.push({
      name: "Zhao",
      aliases: ["Vice-Principal Zhao"],
      disposition: "Hostile administrator",
      status: "Alive",
      modifiers: [],
    });
    // "to the guards" is the person being persuaded — the noun must not
    // trigger the hostile-verb list for Zhao. Regression for the live turn.
    expect(resolveCheck({ stat: "CHA" }, "Zhao vouches for me to the guards")!.difficulty).toBe("easy");
    // A marker belonging to a DIFFERENT NPC ("past the guard") also never
    // marks the companion Zhao as adversarial — the check targets the first
    // registered NPC mentioned (Zhao), and he stays a cooperative ally.
    expect(resolveCheck({ stat: "CHA" }, "I slip past the guard with Zhao")!.difficulty).toBe("easy");
  });

  it("an adversarial mention of the same hostile NPC still reads as hard", () => {
    const s = StateModule.state;
    makeWitness("Zhao", { aggressionThreshold: 75, knownLocation: "Starting Location" });
    s.memory.relations.push({
      name: "Zhao",
      aliases: ["Vice-Principal Zhao"],
      disposition: "Hostile administrator",
      status: "Alive",
      modifiers: [],
    });
    // Getting past / convincing / deceiving the target keeps the hostility.
    expect(resolveCheck({ stat: "CHA" }, "I talk my way past Vice-Principal Zhao")!.difficulty).toBe("hard");
    expect(resolveCheck({ stat: "CHA" }, "I convince Zhao to sign the form")!.difficulty).toBe("hard");
    expect(resolveCheck({ stat: "CHA" }, "Zhao blocks the door")!.difficulty).toBe("hard");
    // A neutral mention (no cooperation, no opposition) also keeps state.
    expect(resolveCheck({ stat: "CHA" }, "I talk to Zhao about the timetable")!.difficulty).toBe("hard");
  });

  it("E2E: an action working with the NPC lands an easy inferred check in the system line", async () => {
    const s = StateModule.state;
    makeWitness("Zhao", { aggressionThreshold: 75, knownLocation: "Starting Location" });
    s.memory.relations.push({
      name: "Zhao",
      aliases: ["Vice-Principal Zhao", "Vice-Principal"],
      disposition: "Hostile administrator",
      status: "Alive",
      modifiers: [],
    });
    setCheckRng(() => 0.5); // roll 11
    // The AI omits difficulty entirely — the engine infers it from the
    // action, which works WITH Zhao, so it must NOT default to hard.
    mockGenerateResponse.mockResolvedValue(
      'Zhao nods and clears a path.\\n[CHECK]{"stat":"CHA","context":"getting past the guard with Zhao vouching"}[/CHECK]',
    );
    await GameEngine.executeTurn("Zhao vouches for me to the guard.", false);
    const systemLines = s.history.filter((h) => h.role === "system").map((h) => h.content);
    const rollLine = systemLines.find((l) => l.includes("⚔️"));
    expect(rollLine).toContain("vs easy 8");
    expect(rollLine).toContain("(inferred)");
    expect(s.checkLog[0]).toMatchObject({ difficulty: "easy", inferred: true, outcome: "critical_success" });
  });

  it("hostile NPCs present but unnamed raise difficulty to hard", () => {
    makeWitness("Guard", { aggressionThreshold: 65, knownLocation: "Starting Location" });
    const r = resolveCheck({ stat: "STR" });
    expect(r!.difficulty).toBe("hard");
  });

  it("a hostile crowd doesn't raise a check the action resolves by working with an ally", () => {
    makeWitness("Guard", { aggressionThreshold: 65, knownLocation: "Starting Location" });
    // The ally has no registered profile — the action text is all the engine
    // knows — so this exercises the ambient mood branch.
    expect(resolveCheck({ stat: "CHA" }, "Rook vouches for me to the guards")!.difficulty).toBe("easy");
    expect(resolveCheck({ stat: "STR" }, "Rook vouches for me")!.difficulty).toBe("moderate");
    // Without ally phrasing the hostile crowd raises exactly as before.
    expect(resolveCheck({ stat: "CHA" }, "I keep my head down")!.difficulty).toBe("hard");
    expect(resolveCheck({ stat: "CHA" })!.difficulty).toBe("hard");
  });

  it("a truly dangerous crowd still reads hard even with an ally vouching", () => {
    makeWitness("Brute", { aggressionThreshold: 85, knownLocation: "Starting Location" });
    // Brutal (85+) dampens to hard with an ally, never to moderate — the
    // crowd is still dangerous, just survivable.
    expect(resolveCheck({ stat: "CHA" }, "Rook vouches for me among the brutes")!.difficulty).toBe("hard");
  });

  it("a friendly room eases social checks but not physical ones", () => {
    makeWitness("Mara", { affection: 85, trust: 80, knownLocation: "Starting Location" });
    expect(resolveCheck({ stat: "CHA" })!.difficulty).toBe("easy");
    expect(resolveCheck({ stat: "STR" })!.difficulty).toBe("moderate");
  });

  it("adverse weather raises physical checks outdoors but not indoors", () => {
    const s = StateModule.state;
    s.worldState.location = "Town Square";
    s.sceneLog = { "town square": { description: "Wet plaza.", weather: "heavy rain" } };
    expect(resolveCheck({ stat: "STR" })!.difficulty).toBe("hard");
    expect(resolveCheck({ stat: "CHA" })!.difficulty).toBe("moderate");
    // Shelter blocks the weather entirely.
    s.worldState.location = "MC Bedroom";
    s.sceneLog = { "mc bedroom": { description: "Tidy.", weather: "heavy rain" } };
    expect(resolveCheck({ stat: "STR" })!.difficulty).toBe("moderate");
  });

  it("darkness raises PER checks and cover eases Sneaking checks", () => {
    const s = StateModule.state;
    s.worldState.location = "Forest";
    s.worldState.time = "Monday, March 17, 23:00"; // outdoor night
    s.sceneLog = {};
    expect(resolveCheck({ stat: "PER" })!.difficulty).toBe("hard");
    expect(resolveCheck({ stat: "Sneaking" })!.difficulty).toBe("easy");
    // Rain adds cover on top of the darkness (still one ease step).
    s.sceneLog = { forest: { description: "Dark pines.", weather: "downpour" } };
    expect(resolveCheck({ stat: "Sneaking" })!.difficulty).toBe("easy");
  });

  it("an explicitly declared difficulty always wins over inference", () => {
    makeWitness("Guard", { aggressionThreshold: 85, knownLocation: "Starting Location" });
    const r = resolveCheck({ stat: "CHA", difficulty: "trivial", context: "convincing the guard" });
    expect(r!.difficulty).toBe("trivial");
    expect(r!.inferred).toBe(false);
    expect(r!.line).not.toContain("(inferred)");
  });

  it("a garbled declared difficulty is treated as omitted and inferred", () => {
    makeWitness("Guard", { aggressionThreshold: 85, knownLocation: "Starting Location" });
    // Drive through the real parser so the "garbled" value is normalized away.
    const lines = CheckModule.extract(
      '[CHECK]{"stat":"CHA","difficulty":"impossible","context":"convincing the guard"}[/CHECK]',
    );
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("vs brutal");
    expect(lines[0]).toContain("(inferred)");
  });

  it("the player's action text can name the target when the context is empty", () => {
    makeWitness("Wren", { affection: 85, knownLocation: "Diner" });
    const r = resolveCheck({ stat: "CHA" }, "Wren vouches for you at the gate");
    expect(r!.difficulty).toBe("easy");
  });

  it("falls back to moderate when the scene and NPCs suggest nothing", () => {
    const r = resolveCheck({ stat: "INT", context: "solving the puzzle" });
    expect(r!.difficulty).toBe("moderate");
    expect(r!.inferred).toBe(true);
  });

  it("E2E: an omitted difficulty is inferred from a hostile NPC and shown in the line", async () => {
    makeWitness("Guard", { aggressionThreshold: 70, knownLocation: "Starting Location" });
    setCheckRng(() => 0.5);
    const spy = vi.spyOn(UIManager, "appendChat");
    mockGenerateResponse.mockResolvedValue(
      'The guard blocks your path.\n[CHECK]{"stat":"CHA","context":"convincing the guard"}[/CHECK]',
    );
    await GameEngine.executeTurn("I try to talk my way past the guard.", false);
    expect(spy).toHaveBeenCalledWith("system", expect.stringContaining("vs hard 14"));
    expect(spy).toHaveBeenCalledWith("system", expect.stringContaining("(inferred)"));
    spy.mockRestore();
  });

  it("extract parses [CHECK] blocks and returns the system lines", () => {
    setCheckRng(() => 0.0);
    const lines = CheckModule.extract(
      'You try to lift the boulder.\n[CHECK]{"stat":"STR","difficulty":"hard","context":"lifting the boulder"}[/CHECK]',
    );
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("⚔️ STR check");
    expect(lines[0]).toContain("critical failure");
    expect(StateModule.state.checkLog.length).toBe(1);
    expect(StateModule.state.checkLog[0].stat).toBe("STR");
  });

  it("an unclosed [CHECK] is auto-closed by normalization before parsing", () => {
    setCheckRng(() => 0.0);
    const lines = CheckModule.extract(
      'You roll the dice. [CHECK]{"stat":"AGI","difficulty":"moderate"}',
    );
    expect(lines.length).toBe(1);
  });

  it("E2E: a [CHECK] tag lands as a system line in history, stripped from display, and the next turn's payload carries the momentum reminder", async () => {
    const s = StateModule.state;
    s.char.str = 16;
    setCheckRng(() => 0.5); // roll 11 -> 11 + 16 = 27 vs hard 14 -> critical success
    const spy = vi.spyOn(UIManager, "appendChat");
    mockGenerateResponse.mockResolvedValue(
      'You heave the boulder.\n[CHECK]{"stat":"STR","difficulty":"hard","context":"lifting the boulder"}[/CHECK]',
    );
    await GameEngine.executeTurn("I try to lift the boulder.", false);
    // The check line is shown as a system entry and persisted in history.
    expect(spy).toHaveBeenCalledWith("system", expect.stringContaining("⚔️ STR check"));
    expect(spy).toHaveBeenCalledWith("system", expect.stringContaining("critical success"));
    const historyLines = s.history.filter((h) => h.role === "system").map((h) => h.content);
    expect(historyLines.some((l) => l.includes("⚔️ STR check"))).toBe(true);
    // The [CHECK] tag itself never reaches the chat display (stripped), while
    // the raw history keeps it so the model sees its own tag usage.
    expect(spy).toHaveBeenCalledWith("ai", "You heave the boulder.");
    expect(s.history[1].content).toContain("[CHECK]");
    spy.mockRestore();

    // Turn 2's payload tells the AI the last STR check was a critical success
    // and consecutive STR checks are easier.
    mockGenerateResponse.mockClear();
    mockGenerateResponse.mockResolvedValue("You dust off your hands.");
    await GameEngine.executeTurn("I keep going.", false);
    const turn2Payload = mockGenerateResponse.mock.calls[0][1] as string;
    expect(turn2Payload).toContain("CHECK MOMENTUM");
    expect(turn2Payload).toContain("last STR check was a critical success");
    expect(turn2Payload).toContain("-4 target this turn");
  });

  it("E2E: consecutive critical failures escalate the penalty the AI sees next turn", async () => {
    setCheckRng(() => 0.0); // natural 1 -> critical_failure
    mockGenerateResponse.mockResolvedValue(
      'You try again.\n[CHECK]{"stat":"CHA","difficulty":"moderate"}[/CHECK]',
    );
    await GameEngine.executeTurn("I try to persuade her again.", false);
    // Turn 2's payload reflects the single failure from turn 1: +4 target.
    mockGenerateResponse.mockClear();
    await GameEngine.executeTurn("I try again.", false);
    const turn2Payload = mockGenerateResponse.mock.calls[0][1] as string;
    expect(turn2Payload).toContain("CHECK MOMENTUM");
    expect(turn2Payload).toContain("streak 1");
    expect(turn2Payload).toContain("+4 target this turn");
    // Turn 3's payload reflects the two consecutive failures: escalated +5.
    mockGenerateResponse.mockClear();
    await GameEngine.executeTurn("I try a third time.", false);
    const turn3Payload = mockGenerateResponse.mock.calls[0][1] as string;
    expect(turn3Payload).toContain("streak 2");
    expect(turn3Payload).toContain("+5 target this turn");
  });

  it("E2E: one turn resolves several checks of DIFFERENT stats, each with its own line", async () => {
    const s = StateModule.state;
    s.char.cha = 12;
    s.char.agi = 12;
    setCheckRng(() => 0.5); // roll 11 both
    mockGenerateResponse.mockResolvedValue(
      'You talk fast.\n[CHECK]{"stat":"CHA","difficulty":"hard","context":"talking your way out"}[/CHECK]\n' +
        'You throw yourself aside.\n[CHECK]{"stat":"AGI","difficulty":"moderate","context":"dodging the sword"}[/CHECK]',
    );
    await GameEngine.executeTurn("I talk my way out, and if that fails I dodge.", false);
    const sys = s.history
      .filter((h) => h.role === "system")
      .map((h) => h.content)
      .filter((l) => l.includes("⚔️"));
    expect(sys.length).toBe(2);
    expect(sys[0]).toContain("CHA check");
    expect(sys[1]).toContain("AGI check");
    expect(s.checkLog.map((c) => c.stat)).toEqual(["CHA", "AGI"]);
  });

  it("same-turn same-stat checks chain momentum: the second sees the first's failure", () => {
    const s = StateModule.state;
    s.char.cha = 12;
    setCheckRng(() => 0.0); // natural 1 -> critical_failure
    CheckModule.extract(
      'First attempt.\n[CHECK]{"stat":"CHA","difficulty":"easy","context":"first try"}[/CHECK]\n' +
        'Second attempt.\n[CHECK]{"stat":"CHA","difficulty":"easy","context":"second try"}[/CHECK]',
    );
    expect(s.checkLog[0].target).toBe(8); // easy 8
    expect(s.checkLog[1].target).toBe(12); // easy 8 + 4 (critical failure momentum, same turn)
  });

  it("a fallback check after a failed check is harder (+2 target) and flagged in the line", () => {
    const s = StateModule.state;
    s.char.cha = 12;
    s.char.agi = 12;
    setCheckRng(() => 0.0); // natural 1 on both
    const lines = CheckModule.extract(
      'You talk.\n[CHECK]{"stat":"CHA","difficulty":"moderate","context":"talking your way out"}[/CHECK]\n' +
        'You dodge.\n[CHECK]{"stat":"AGI","difficulty":"moderate","fallback":true,"context":"dodging after the talk fails"}[/CHECK]',
    );
    expect(s.checkLog[0].outcome).toBe("critical_failure");
    // The critical failure imparts +4 on the CHA line; half (2) carries into
    // the dodge on top of the flat +2 — the chain is NOT a fresh roll.
    expect(s.checkLog[1].target).toBe(15); // moderate 11 + 2 fallback + 2 inherited
    expect(s.checkLog[1].fallback).toBe(true);
    expect(s.checkLog[1].fallbackMod).toBe(4);
    expect(s.checkLog[1].fallbackInheritedMod).toBe(2);
    expect(s.checkLog[1].fallbackFrom).toBe("CHA");
    expect(lines[1]).toContain(
      "fallback (+4 target after the previous failure; half the failed CHA check's momentum carries over)",
    );
  });

  it("a major failure imparts half its penalty (+1) into the fallback", () => {
    const s = StateModule.state;
    s.char.cha = 5; // low CHA so a brutal check can actually fail
    s.char.agi = 12;
    // Roll 3 -> margin -10 on brutal 18 -> major_failure (imparts +2, half = 1).
    setCheckRng(() => 0.1);
    const lines = CheckModule.extract(
      'You talk.\n[CHECK]{"stat":"CHA","difficulty":"brutal","context":"facing the thug"}[/CHECK]\n' +
        'You dodge.\n[CHECK]{"stat":"AGI","difficulty":"moderate","fallback":true,"context":"dodging after the talk fails"}[/CHECK]',
    );
    expect(s.checkLog[0].outcome).toBe("major_failure");
    expect(s.checkLog[1].fallbackMod).toBe(3); // 2 flat + 1 inherited
    expect(s.checkLog[1].fallbackInheritedMod).toBe(1);
    expect(s.checkLog[1].target).toBe(14); // moderate 11 + 3
    expect(lines[1]).toContain("half the failed CHA check's momentum carries over");
  });

  it("a minor failure imparts nothing (its +1 penalty halves to 0)", () => {
    const s = StateModule.state;
    s.char.cha = 5; // low CHA so a brutal check can actually fail
    s.char.agi = 12;
    // Roll 8 -> margin -5 on brutal 18 -> minor_failure (imparts +1, half = 0).
    setCheckRng(() => 0.35);
    const lines = CheckModule.extract(
      'You talk.\n[CHECK]{"stat":"CHA","difficulty":"brutal","context":"facing the thug"}[/CHECK]\n' +
        'You dodge.\n[CHECK]{"stat":"AGI","difficulty":"moderate","fallback":true,"context":"dodging after the talk fails"}[/CHECK]',
    );
    expect(s.checkLog[0].outcome).toBe("minor_failure");
    expect(s.checkLog[1].fallbackMod).toBe(2); // flat only
    expect(s.checkLog[1].fallbackInheritedMod).toBeUndefined();
    expect(s.checkLog[1].target).toBe(13);
    expect(lines[1]).toContain("fallback (+2 target after the previous failure)");
  });

  it("a deepening failure streak on the primary pours more pressure into the fallback", () => {
    const s = StateModule.state;
    s.char.cha = 12;
    s.char.agi = 12;
    setCheckRng(() => 0.0); // natural 1 -> critical failure every roll
    const lines = CheckModule.extract(
      'One.\n[CHECK]{"stat":"CHA","difficulty":"moderate"}[/CHECK]\n' +
        'Two.\n[CHECK]{"stat":"CHA","difficulty":"moderate"}[/CHECK]\n' +
        'Three.\n[CHECK]{"stat":"CHA","difficulty":"moderate"}[/CHECK]\n' +
        'You dodge.\n[CHECK]{"stat":"AGI","difficulty":"moderate","fallback":true,"context":"dodging after the talk fails"}[/CHECK]',
    );
    // CHA streak 3: imparts 4 + 2 (escalation) = 6; half = 3 carries over.
    expect(s.checkLog[2].outcome).toBe("critical_failure");
    expect(s.checkMomentum.CHA.streak).toBe(3);
    expect(s.checkLog[3].fallbackMod).toBe(5); // 2 flat + 3 inherited
    expect(s.checkLog[3].fallbackInheritedMod).toBe(3);
    expect(s.checkLog[3].target).toBe(16); // moderate 11 + 5
    expect(lines[3]).toContain("fallback (+5 target after the previous failure; half the failed CHA check's momentum carries over)");
  });

  it("a same-stat fallback does NOT double-inherit: full momentum applies, no extra fraction", () => {
    const s = StateModule.state;
    s.char.cha = 12;
    setCheckRng(() => 0.0); // natural 1 on both
    CheckModule.extract(
      'You talk.\n[CHECK]{"stat":"CHA","difficulty":"moderate"}[/CHECK]\n' +
        'You try talking again.\n[CHECK]{"stat":"CHA","difficulty":"moderate","fallback":true,"context":"retrying the talk"}[/CHECK]',
    );
    // momentum 4 (critical failure, streak 1) + flat 2 — the +4 is already
    // the FULL line penalty, so no inherited fraction on top.
    expect(s.checkLog[1].target).toBe(17); // moderate 11 + 4 + 2
    expect(s.checkLog[1].fallbackMod).toBe(2);
    expect(s.checkLog[1].fallbackInheritedMod).toBeUndefined();
    expect(s.checkLog[1].fallbackFrom).toBeUndefined();
  });

  it("a fallback after a SUCCESS carries no penalty", () => {
    const s = StateModule.state;
    s.char.cha = 12;
    s.char.agi = 12;
    setCheckRng(() => 0.95); // natural 20 -> critical success
    CheckModule.extract(
      'You talk.\n[CHECK]{"stat":"CHA","difficulty":"moderate","context":"talking your way out"}[/CHECK]\n' +
        'You dodge.\n[CHECK]{"stat":"AGI","difficulty":"moderate","fallback":true,"context":"dodging anyway"}[/CHECK]',
    );
    expect(s.checkLog[0].outcome).toBe("critical_success");
    expect(s.checkLog[1].target).toBe(11); // no penalty after a success
    expect(s.checkLog[1].fallbackMod).toBeUndefined();
  });

  it("E2E: a fallback chain (talk fails, then dodge) lands both lines with the fallback flag", async () => {
    const s = StateModule.state;
    s.char.cha = 12;
    s.char.agi = 12;
    setCheckRng(() => 0.0); // both natural 1
    mockGenerateResponse.mockResolvedValue(
      'You talk fast, but Zhao is unmoved.\n[CHECK]{"stat":"CHA","difficulty":"hard","context":"talking your way out"}[/CHECK]\n' +
        'You dive aside.\n[CHECK]{"stat":"AGI","difficulty":"moderate","fallback":true,"context":"dodging after the talk fails"}[/CHECK]',
    );
    await GameEngine.executeTurn("I talk my way out, and if that fails I dodge.", false);
    const sys = s.history
      .filter((h) => h.role === "system")
      .map((h) => h.content)
      .filter((l) => l.includes("⚔️"));
    expect(sys.length).toBe(2);
    expect(sys[0]).toContain("CHA check");
    expect(sys[0]).toContain("critical failure");
    expect(sys[1]).toContain("AGI check");
    expect(sys[1]).toContain(
      "fallback (+4 target after the previous failure; half the failed CHA check's momentum carries over)",
    );
    expect(s.checkLog[1]).toMatchObject({
      stat: "AGI",
      fallback: true,
      fallbackMod: 4,
      fallbackInheritedMod: 2,
      fallbackFrom: "CHA",
      target: 15,
    });
  });

  it("a fallback declared on the NEXT turn still inherits half the previous turn's failed primary", () => {
    const s = StateModule.state;
    s.char.cha = 12;
    s.char.agi = 12;
    // Turn 1: the talk blows up (critical failure, imparts +4 on the CHA line).
    s.turnCount = 2;
    setCheckRng(() => 0.0);
    CheckModule.extract(
      '[CHECK]{"stat":"CHA","difficulty":"moderate","context":"the talk"}[/CHECK]',
      "I try to talk my way out.",
    );
    expect(s.lastFailedCheck).toMatchObject({ stat: "CHA", statLabel: "CHA", imparted: 4, turn: 2 });
    // Turn 2: the player dodges — the persisted failure feeds the fallback.
    s.turnCount = 3;
    setCheckRng(() => 0.95); // natural 20 -> the dodge itself succeeds
    const lines = CheckModule.extract(
      '[CHECK]{"stat":"AGI","difficulty":"moderate","fallback":true,"context":"dodging the day after"}[/CHECK]',
      "I dodge out of the way.",
    );
    expect(s.checkLog[1].fallbackMod).toBe(4); // 2 flat + 2 inherited
    expect(s.checkLog[1].fallbackInheritedMod).toBe(2);
    expect(s.checkLog[1].fallbackFrom).toBe("CHA");
    expect(s.checkLog[1].target).toBe(15); // moderate 11 + 4
    expect(lines[0]).toContain(
      "fallback (+4 target after the previous failure; half the failed CHA check's momentum carries over)",
    );
    // The success resolves the pressure — the persisted failure is cleared.
    expect(s.lastFailedCheck).toBeNull();
  });

  it("a fallback declared two turns after the failure does NOT inherit (fresh scene)", () => {
    const s = StateModule.state;
    s.char.cha = 12;
    s.char.agi = 12;
    s.turnCount = 2;
    setCheckRng(() => 0.0);
    CheckModule.extract('[CHECK]{"stat":"CHA","difficulty":"moderate"}[/CHECK]');
    s.turnCount = 4; // two turns later
    setCheckRng(() => 0.0);
    const lines = CheckModule.extract(
      '[CHECK]{"stat":"AGI","difficulty":"moderate","fallback":true,"context":"dodging much later"}[/CHECK]',
    );
    // With no failed primary in range there is nothing to recover from, so
    // the fallback carries no penalty at all (still flagged as a fallback).
    expect(s.checkLog[1].fallback).toBe(true);
    expect(s.checkLog[1].fallbackMod).toBeUndefined();
    expect(s.checkLog[1].fallbackInheritedMod).toBeUndefined();
    expect(lines[0]).not.toContain("fallback (");
  });

  it("a failed check against a named hostile NPC ARMS the scene (weapon drawn, stage 1)", () => {
    const s = StateModule.state;
    s.char.cha = 5;
    s.memory.relations.push({
      name: "Vice-Principal Zhao",
      aliases: ["Zhao"],
      disposition: "Hostile administrator",
      status: "Alive",
      modifiers: [],
    });
    s.npcProfiles.push({
      npcName: "Vice-Principal Zhao",
      traits: [],
      aggressionThreshold: 60,
      jealousyThreshold: 50,
      trust: 10,
      affection: 5,
      schedule: [],
      relationships: [],
      equipment: [],
    });
    setCheckRng(() => 0.0); // natural 1 -> critical failure
    const lines = CheckModule.extract(
      '[CHECK]{"stat":"CHA","difficulty":"easy","context":"talking my way past Vice-Principal Zhao"}[/CHECK]',
      "I try to talk my way past Vice-Principal Zhao.",
    );
    expect(s.checkEscalation["vice-principal zhao"]).toMatchObject({
      npc: "Vice-Principal Zhao",
      failures: 1,
      stage: 1,
    });
    // First failure carries no escalation penalty yet.
    expect(s.checkLog[0].escalationMod).toBeUndefined();
    expect(lines[0]).not.toContain("has drawn a weapon");
  });

  it("the SECOND attempt against the armed NPC is harder (+2 target) and the line names the weapon", () => {
    const s = StateModule.state;
    s.char.cha = 5;
    s.memory.relations.push({
      name: "Vice-Principal Zhao",
      aliases: ["Zhao"],
      disposition: "Hostile administrator",
      status: "Alive",
      modifiers: [],
    });
    s.npcProfiles.push({
      npcName: "Vice-Principal Zhao",
      traits: [],
      aggressionThreshold: 60,
      jealousyThreshold: 50,
      trust: 10,
      affection: 5,
      schedule: [],
      relationships: [],
      equipment: [],
    });
    // Pre-arm the scene: one failure already happened last turn, which also
    // left critical-failure momentum on the CHA line (the same pressure).
    s.checkEscalation["vice-principal zhao"] = {
      npc: "Vice-Principal Zhao",
      failures: 1,
      lastFailTurn: 1,
      stage: 1,
    };
    s.checkMomentum.CHA = { outcome: "critical_failure", streak: 1 };
    s.turnCount = 2;
    setCheckRng(() => 0.0); // fails again
    const lines = CheckModule.extract(
      '[CHECK]{"stat":"CHA","difficulty":"easy","context":"trying to talk my way past Vice-Principal Zhao again"}[/CHECK]',
      "I try talking my way past Vice-Principal Zhao again.",
    );
    // easy 8 + 4 (critical-failure momentum) + 2 (one prior failure) = 14.
    expect(s.checkLog[0].target).toBe(14);
    expect(s.checkLog[0].escalationMod).toBe(2);
    expect(s.checkLog[0].escalationNpc).toBe("Vice-Principal Zhao");
    expect(lines[0]).toContain("Vice-Principal Zhao has drawn a weapon");
    expect(lines[0]).toContain("the scene has escalated: +2 target");
    // The second failure deepens the escalation.
    expect(s.checkEscalation["vice-principal zhao"]).toMatchObject({ failures: 2, stage: 2 });
  });

  it("a success against the armed NPC defuses the scene", () => {
    const s = StateModule.state;
    s.char.cha = 12;
    s.memory.relations.push({
      name: "Vice-Principal Zhao",
      aliases: ["Zhao"],
      disposition: "Hostile administrator",
      status: "Alive",
      modifiers: [],
    });
    s.npcProfiles.push({
      npcName: "Vice-Principal Zhao",
      traits: [],
      aggressionThreshold: 60,
      jealousyThreshold: 50,
      trust: 10,
      affection: 5,
      schedule: [],
      relationships: [],
      equipment: [],
    });
    s.checkEscalation["vice-principal zhao"] = {
      npc: "Vice-Principal Zhao",
      failures: 2,
      lastFailTurn: 1,
      stage: 2,
    };
    s.turnCount = 2;
    setCheckRng(() => 0.95); // natural 20 -> critical success
    CheckModule.extract(
      '[CHECK]{"stat":"CHA","difficulty":"easy","context":"apologizing to Vice-Principal Zhao"}[/CHECK]',
      "I apologize sincerely to Vice-Principal Zhao.",
    );
    expect(s.checkEscalation["vice-principal zhao"]).toBeUndefined();
  });

  it("a failed check against a WARM NPC never arms the scene (no absurd weapon draw)", () => {
    const s = StateModule.state;
    s.char.cha = 5;
    s.memory.relations.push({
      name: "Librarian Elle",
      aliases: ["Elle"],
      disposition: "Friendly librarian",
      status: "Alive",
      modifiers: [],
    });
    s.npcProfiles.push({
      npcName: "Librarian Elle",
      traits: [],
      aggressionThreshold: 20,
      jealousyThreshold: 50,
      trust: 60,
      affection: 60,
      schedule: [],
      relationships: [],
      equipment: [],
    });
    setCheckRng(() => 0.0);
    CheckModule.extract(
      '[CHECK]{"stat":"CHA","difficulty":"easy","context":"chatting with Elle"}[/CHECK]',
      "I chat with Elle about the archive.",
    );
    expect(s.checkEscalation["librarian elle"]).toBeUndefined();
  });

  it("an adversarial action arms the scene even when the recorded disposition is warm", () => {
    const s = StateModule.state;
    s.char.cha = 5;
    s.memory.relations.push({
      name: "Librarian Elle",
      aliases: ["Elle"],
      disposition: "Friendly librarian",
      status: "Alive",
      modifiers: [],
    });
    s.npcProfiles.push({
      npcName: "Librarian Elle",
      traits: [],
      aggressionThreshold: 20,
      jealousyThreshold: 50,
      trust: 60,
      affection: 60,
      schedule: [],
      relationships: [],
      equipment: [],
    });
    setCheckRng(() => 0.0);
    CheckModule.extract(
      '[CHECK]{"stat":"CHA","difficulty":"easy","context":"talking my way past Elle"}[/CHECK]',
      "I try to talk my way past Elle.",
    );
    expect(s.checkEscalation["librarian elle"]).toMatchObject({ failures: 1, stage: 1 });
  });

  it("a stale escalation (no new failure within the TTL) does not color a later check", () => {
    const s = StateModule.state;
    s.char.cha = 5;
    s.memory.relations.push({
      name: "Vice-Principal Zhao",
      aliases: ["Zhao"],
      disposition: "Hostile administrator",
      status: "Alive",
      modifiers: [],
    });
    s.npcProfiles.push({
      npcName: "Vice-Principal Zhao",
      traits: [],
      aggressionThreshold: 60,
      jealousyThreshold: 50,
      trust: 10,
      affection: 5,
      schedule: [],
      relationships: [],
      equipment: [],
    });
    // Armed two turns ago, then nothing — the scene cooled down.
    s.checkEscalation["vice-principal zhao"] = {
      npc: "Vice-Principal Zhao",
      failures: 2,
      lastFailTurn: 0,
      stage: 2,
    };
    s.turnCount = 5;
    setCheckRng(() => 0.0);
    CheckModule.extract(
      '[CHECK]{"stat":"CHA","difficulty":"easy","context":"trying again after a long gap"}[/CHECK]',
      "I try to talk my way past Vice-Principal Zhao.",
    );
    expect(s.checkLog[0].escalationMod).toBeUndefined();
    // The new failure re-arms it fresh (1 failure, not 3).
    expect(s.checkEscalation["vice-principal zhao"]).toMatchObject({ failures: 1, stage: 1 });
  });

  it("the escalation reminder names the armed NPC, the weapon, and the raised target", () => {
    const s = StateModule.state;
    s.checkEscalation["vice-principal zhao"] = {
      npc: "Vice-Principal Zhao",
      failures: 2,
      lastFailTurn: 3,
      stage: 2,
    };
    s.turnCount = 4;
    const r = getEscalationReminder();
    expect(r).toContain("Vice-Principal Zhao");
    expect(r).toContain("brandishes a weapon");
    expect(r).toContain("2 failed attempts in a row");
    expect(r).toContain("+4 target this turn");
  });

  it("a stale escalation is pruned by the reminder", () => {
    const s = StateModule.state;
    s.checkEscalation["zhao"] = { npc: "Zhao", failures: 1, lastFailTurn: 0, stage: 1 };
    s.turnCount = 5;
    expect(getEscalationReminder()).toBe("");
    expect(s.checkEscalation["zhao"]).toBeUndefined();
  });

  it("E2E: a second failed talk against the same hostile NPC escalates (target rises, weapon drawn) and the next payload carries the reminder", async () => {
    const s = StateModule.state;
    s.char.cha = 5;
    s.memory.relations.push({
      name: "Vice-Principal Zhao",
      aliases: ["Zhao"],
      disposition: "Hostile administrator",
      status: "Alive",
      modifiers: [],
    });
    s.npcProfiles.push({
      npcName: "Vice-Principal Zhao",
      traits: [],
      aggressionThreshold: 60,
      jealousyThreshold: 50,
      trust: 10,
      affection: 5,
      schedule: [],
      relationships: [],
      equipment: [],
    });
    setCheckRng(() => 0.0); // natural 1 -> critical failure both turns
    mockGenerateResponse.mockResolvedValue(
      'Zhao does not budge.\n[CHECK]{"stat":"CHA","difficulty":"easy","context":"talking my way past Vice-Principal Zhao"}[/CHECK]',
    );
    await GameEngine.executeTurn("I try to talk my way past Vice-Principal Zhao.", false);
    expect(s.checkEscalation["vice-principal zhao"]).toMatchObject({ failures: 1, stage: 1 });

    mockGenerateResponse.mockResolvedValue(
      'Zhao\'s hand goes to his belt.\n[CHECK]{"stat":"CHA","difficulty":"easy","context":"trying to talk my way past Vice-Principal Zhao again"}[/CHECK]',
    );
    await GameEngine.executeTurn("I try talking my way past Vice-Principal Zhao again.", false);

    expect(s.checkEscalation["vice-principal zhao"]).toMatchObject({ failures: 2, stage: 2 });
    // easy 8 (turn 1, no mods) -> easy 8 + 4 momentum + 2 escalation = 14 (turn 2).
    expect(s.checkLog[0].target).toBe(8);
    expect(s.checkLog[1].target).toBe(14);
    expect(s.checkLog[1].escalationMod).toBe(2);
    expect(s.checkLog[1].escalationNpc).toBe("Vice-Principal Zhao");
    const sys = s.history
      .filter((h) => h.role === "system")
      .map((h) => h.content)
      .filter((l) => l.includes("⚔️"));
    expect(sys[1]).toContain("Vice-Principal Zhao has drawn a weapon");
    expect(sys[1]).toContain("the scene has escalated: +2 target");
    // The next turn's payload warns the AI that Zhao is still armed.
    const payload2 = mockGenerateResponse.mock.calls[1][1];
    expect(payload2).toContain("ESCALATION: Vice-Principal Zhao");
    expect(payload2).toContain("has drawn a weapon");
  });

  it("no check lines or momentum when the statChecks toggle is off", async () => {
    StateModule.state.toggles.statChecks = false;
    setCheckRng(() => 0.0);
    const spy = vi.spyOn(UIManager, "appendChat");
    mockGenerateResponse.mockResolvedValue(
      'You try.\n[CHECK]{"stat":"STR","difficulty":"easy"}[/CHECK]',
    );
    await GameEngine.executeTurn("I try the latch.", false);
    expect(spy).not.toHaveBeenCalledWith("system", expect.stringContaining("⚔️"));
    expect(StateModule.state.checkLog.length).toBe(0);
    expect(StateModule.state.checkMomentum).toEqual({});
    // The [CHECK] tag is still stripped from display even with the toggle off.
    expect(spy).toHaveBeenCalledWith("ai", "You try.");
    spy.mockRestore();
  });

  it("the momentum reminder is empty when no check has colored the line", () => {
    expect(getMomentumReminder()).toBe("");
  });
});

function resolveCheckForTest(parsed: { stat: string; difficulty: string }) {
  return resolveCheck({ stat: parsed.stat, difficulty: parsed.difficulty });
}

// ===========================================================================
// 2. Relationship-change pipeline
// ===========================================================================

describe("Relationship-change pipeline — AI-emitted [RELATION] tags", () => {
  beforeEach(resetState);

  it("creates a relationship and lists it in the next turn's prompt", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The herbalist smiles. [RELATION]{"name": "Mara", "disposition": "Friendly merchant", "status": "Alive", "aliases": ["Oakhaven Herbalist"]}[/RELATION]',
      )
      .mockResolvedValueOnce("The shop bustles. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I enter the shop.", false);
    const rels = StateModule.state.memory.relations;
    expect(rels.length).toBe(1);
    expect(rels[0].name).toBe("Mara");
    expect(rels[0].disposition).toBe("Friendly merchant");
    expect(rels[0].aliases).toContain("Oakhaven Herbalist");

    await GameEngine.executeTurn("I browse the wares.", false);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    expect(turn2Prompt).toContain("ACTIVE ALIVE CHARACTERS");
    expect(turn2Prompt).toContain("- Mara: Friendly merchant.");
  });

  it("merges a disposition change onto the existing relationship across turns", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The herbalist smiles. [RELATION]{"name": "Mara", "disposition": "Friendly merchant", "status": "Alive"}[/RELATION]',
      )
      .mockResolvedValueOnce(
        'You share tea. [RELATION]{"name": "Mara", "disposition": "Close friend"}[/RELATION]',
      )
      .mockResolvedValueOnce("The evening passes. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I chat with Mara.", false);
    await GameEngine.executeTurn("I share tea with Mara.", false);

    const rels = StateModule.state.memory.relations;
    expect(rels.length).toBe(1); // updated, not duplicated
    expect(rels[0].disposition).toBe("Close friend");

    await GameEngine.executeTurn("I say goodbye.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    expect(turn3Prompt).toContain("- Mara: Close friend.");
    expect(turn3Prompt).not.toContain("- Mara: Friendly merchant.");
  });

  it("moves a killed NPC into the DECEASED section with their previous background", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The duel begins. [RELATION]{"name": "Mara", "disposition": "Close friend", "status": "Alive"}[/RELATION]',
      )
      .mockResolvedValueOnce(
        'The blade falls. [RELATION]{"name": "Mara", "status": "Deceased"}[/RELATION]',
      )
      .mockResolvedValueOnce("Silence. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I draw my sword.", false);
    await GameEngine.executeTurn("I strike.", false);
    expect(StateModule.state.memory.relations[0].status).toBe("Deceased");

    await GameEngine.executeTurn("I kneel.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    // Deceased: listed with their past disposition, explicitly dead.
    expect(turn3Prompt).toContain("DECEASED CHARACTERS");
    expect(turn3Prompt).toContain("- Mara: Dead. Previous background: Close friend");
    // Alive section: no living characters remain.
    expect(turn3Prompt).toContain("ACTIVE ALIVE CHARACTERS");
    expect(turn3Prompt).toContain("  - None");
    expect(turn3Prompt).not.toContain("  - Mara: Close friend.");
  });

  it("ticks relationship modifiers down each turn and removes them at 0", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'Doran grins. [RELATION]{"name": "Doran", "disposition": "Cheerful", "modifiers": [{"name": "Drunk", "duration": 3}]}[/RELATION]',
      )
      .mockResolvedValueOnce("Doran laughs. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]")
      .mockResolvedValueOnce("Doran waves. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]")
      .mockResolvedValueOnce("Doran nods off. [STATE_UPDATE]{\"time\": \"Monday, 07:30 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I toast Doran.", false);
    const rels = StateModule.state.memory.relations as Relation[];
    expect(rels[0].modifiers?.[0]).toEqual({ name: "Drunk", duration: 3 });

    // Turn 2: ticked down to 2, shown in the prompt with its remaining turns.
    await GameEngine.executeTurn("I talk to Doran.", false);
    expect(rels[0].modifiers?.[0].duration).toBe(2);
    expect(mockGenerateResponse.mock.calls[1][0]).toContain("Modifiers: Drunk(2 turns)");

    // Turn 3: 2 -> 1.
    await GameEngine.executeTurn("I joke with Doran.", false);
    expect(rels[0].modifiers?.[0].duration).toBe(1);
    expect(mockGenerateResponse.mock.calls[2][0]).toContain("Modifiers: Drunk(1 turns)");

    // Turn 4: 1 -> 0, removed from state and absent from the prompt.
    await GameEngine.executeTurn("I leave Doran.", false);
    expect(rels[0].modifiers?.length ?? 0).toBe(0);
    const turn4Prompt = mockGenerateResponse.mock.calls[3][0] as string;
    expect(turn4Prompt).toContain("- Doran: Cheerful.");
    expect(turn4Prompt).not.toContain("Modifiers:");
  });

  it("merges an update that references an NPC by alias onto the existing relation", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The herbalist smiles. [RELATION]{"name": "Mara", "disposition": "Friendly merchant", "status": "Alive", "aliases": ["Oakhaven Herbalist"]}[/RELATION]',
      )
      .mockResolvedValueOnce(
        'You discuss herbs. [RELATION]{"name": "Oakhaven Herbalist", "disposition": "Warm and chatty"}[/RELATION]',
      )
      .mockResolvedValueOnce("The evening passes. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I talk to Mara.", false);
    await GameEngine.executeTurn("I ask about herbs.", false);

    const rels = StateModule.state.memory.relations;
    expect(rels.length).toBe(1); // merged via alias, not duplicated
    expect(rels[0].name).toBe("Mara");
    expect(rels[0].disposition).toBe("Warm and chatty");
    expect(rels[0].aliases).toContain("Oakhaven Herbalist");

    await GameEngine.executeTurn("I say goodbye.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    expect(turn3Prompt).toContain("- Mara: Warm and chatty.");
  });

  it("replaces a same-name modifier's duration instead of duplicating it", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'Doran grins. [RELATION]{"name": "Doran", "disposition": "Cheerful", "modifiers": [{"name": "Drunk", "duration": 3}]}[/RELATION]',
      )
      .mockResolvedValueOnce(
        'Doran takes another round. [RELATION]{"name": "Doran", "modifiers": [{"name": "Drunk", "duration": 5}]}[/RELATION]',
      )
      .mockResolvedValueOnce(
        'Doran stumbles. [RELATION]{"name": "Doran", "modifiers": [{"name": "Lovesick", "duration": 2}]}[/RELATION]',
      )
      .mockResolvedValueOnce("The night ends. [STATE_UPDATE]{\"time\": \"Monday, 07:30 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I drink with Doran.", false);
    await GameEngine.executeTurn("I order another round.", false);
    const rels = StateModule.state.memory.relations as Relation[];
    // Replaced in place (Drunk 3 -> 5), not appended alongside the old one.
    expect(rels[0].modifiers?.length).toBe(1);
    expect(rels[0].modifiers?.[0]).toEqual({ name: "Drunk", duration: 5 });

    // A different-named modifier appends; the in-place Drunk is untouched
    // (ticked 5 -> 4 at the start of this turn).
    await GameEngine.executeTurn("I watch Doran stumble.", false);
    expect(rels[0].modifiers?.length).toBe(2);
    expect(rels[0].modifiers?.[0]).toEqual({ name: "Drunk", duration: 4 });
    expect(rels[0].modifiers?.[1]).toEqual({ name: "Lovesick", duration: 2 });
    // The prompt shows the replaced value with its remaining turns.
    expect(mockGenerateResponse.mock.calls[2][0]).toContain("Modifiers: Drunk(4 turns)");
  });

  it("keeps distinct NPCs whose names share a prefix separate (fuzzy-match guard)", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'Two women approach. [RELATION]{"name": "Mara", "disposition": "Friendly merchant"}[/RELATION] [RELATION]{"name": "Marabel", "disposition": "Wary guard"}[/RELATION]',
      )
      .mockResolvedValueOnce(
        'Mara nods. [RELATION]{"name": "Mara", "disposition": "Close friend"}[/RELATION]',
      )
      .mockResolvedValueOnce("The night ends. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I greet the women.", false);
    const rels = StateModule.state.memory.relations;
    expect(rels.length).toBe(2);
    expect(rels.map((r) => r.name)).toEqual(["Mara", "Marabel"]);

    // Updating one must not collapse the other.
    await GameEngine.executeTurn("I talk to Mara.", false);
    expect(rels.length).toBe(2);
    expect(rels.find((r) => r.name === "Mara")?.disposition).toBe("Close friend");
    expect(rels.find((r) => r.name === "Marabel")?.disposition).toBe("Wary guard");

    await GameEngine.executeTurn("I leave.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    expect(turn3Prompt).toContain("- Mara: Close friend.");
    expect(turn3Prompt).toContain("- Marabel: Wary guard.");
  });
});

// ===========================================================================
// 2b. NPC auto-profile generation — a new [RELATION] spawns a profile from
// the disposition, and the prompt's NPC PROFILES section lists it next turn.
// ===========================================================================

describe("NPC auto-profile generation pipeline", () => {
  beforeEach(resetState);

  it("auto-generates a profile for a new NPC from [RELATION] and lists it next turn", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The herbalist smiles. [RELATION]{"name": "Mara", "disposition": "Friendly merchant", "status": "Alive", "aliases": ["Oakhaven Herbalist"]}[/RELATION]',
      )
      .mockResolvedValueOnce("The shop bustles. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I enter the shop.", false);
    expect(StateModule.state.npcProfiles.length).toBe(1);
    const profile = StateModule.state.npcProfiles[0];
    expect(profile.npcName).toBe("Mara");
    expect(profile.autoGenerated).toBe(true);
    // "Friendly merchant" matches no trait keyword, so defaults apply.
    expect(profile.traits).toEqual([]);
    expect(profile.aggressionThreshold).toBe(50);
    expect(profile.trust).toBe(50);
    expect(profile.affection).toBe(50);

    await GameEngine.executeTurn("I browse the wares.", false);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    expect(turn2Prompt).toContain("=== NPC PROFILES (PHASE 5 - STRICT ENFORCEMENT) ===");
    expect(turn2Prompt).toContain(
      "Aggression: 50/100 | Jealousy: 50/100 | Trust: 50/100 | Affection: 50/100",
    );
  });

  it("derives traits and thresholds from disposition keywords", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'Two figures block the road. [RELATION]{"name": "Hrogar", "disposition": "Aggressive bandit leader"}[/RELATION] [RELATION]{"name": "Wren", "disposition": "Timid clerk"}[/RELATION]',
      )
      .mockResolvedValueOnce("They step aside. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I approach carefully.", false);
    const hrogar = StateModule.state.npcProfiles.find((p) => p.npcName === "Hrogar");
    const wren = StateModule.state.npcProfiles.find((p) => p.npcName === "Wren");
    expect(hrogar?.traits).toContain("aggressive");
    expect(hrogar?.aggressionThreshold).toBe(70); // aggressive NPCs escalate
    expect(wren?.traits).toContain("timid");
    expect(wren?.aggressionThreshold).toBe(20); // timid NPCs retreat

    await GameEngine.executeTurn("I wave.", false);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    expect(turn2Prompt).toContain("- Hrogar [aggressive]");
    expect(turn2Prompt).toContain("Aggression: 70/100");
    expect(turn2Prompt).toContain("- Wren [timid]");
    expect(turn2Prompt).toContain("Aggression: 20/100");
  });

  it("does not duplicate a profile when the same NPC is re-introduced", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The herbalist smiles. [RELATION]{"name": "Mara", "disposition": "Friendly merchant", "status": "Alive"}[/RELATION]',
      )
      .mockResolvedValueOnce(
        'You share tea. [RELATION]{"name": "Mara", "disposition": "Close friend"}[/RELATION]',
      )
      .mockResolvedValueOnce("The evening passes. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I chat with Mara.", false);
    await GameEngine.executeTurn("I share tea with Mara.", false);
    // One profile only — created once from the first introduction.
    expect(StateModule.state.npcProfiles.length).toBe(1);
    expect(StateModule.state.npcProfiles[0].autoGenerated).toBe(true);
    // The relation itself was updated by the second [RELATION] (pipeline 2),
    // but the auto-generated profile is not rewritten.
    expect(StateModule.state.memory.relations[0].disposition).toBe("Close friend");
  });

  it("keeps the profile in state but drops it from the NPC PROFILES section when the NPC dies", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The duel begins. [RELATION]{"name": "Mara", "disposition": "Close friend", "status": "Alive"}[/RELATION]',
      )
      .mockResolvedValueOnce(
        'The blade falls. [RELATION]{"name": "Mara", "status": "Deceased"}[/RELATION]',
      )
      .mockResolvedValueOnce("Silence. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I draw my sword.", false);
    await GameEngine.executeTurn("I strike.", false);
    expect(StateModule.state.memory.relations[0].status).toBe("Deceased");
    expect(StateModule.state.npcProfiles.length).toBe(1); // still stored

    await GameEngine.executeTurn("I kneel.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    // getLivingProfiles() only lists NPCs whose relation is Alive, so the
    // whole NPC PROFILES section disappears while the profile record remains.
    expect(turn3Prompt).not.toContain("NPC PROFILES (PHASE 5");
    expect(turn3Prompt).toContain("DECEASED CHARACTERS");
  });
});

// ===========================================================================
// 3. Sub-attribute pipeline (derived subskills + secondary stats)
// ===========================================================================

describe("Sub-attribute pipeline — derived subskills and secondary stats", () => {
  beforeEach(resetState);

  it("injects derived subskills and secondary stats into the system prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(
      "Derived Skills - Seduction: 10, Sneaking: 15, Negotiation: 13, Intimidation: 10.",
    );
    expect(prompt).toContain(
      "MC Stats: STR=10 AGI=10 INT=10 CHA=10 END=10 WIL=10 LCK=10 PER=10 Cultivation=0 SystemPoints=0",
    );
    expect(prompt).toContain("END (Endurance): Physical stamina, resistance to fatigue, pain tolerance.");
    expect(prompt).toContain("WIL (Willpower): Mental fortitude, resistance to fear/charm/corruption");
    expect(prompt).toContain("LCK (Luck): Probability manipulation, critical hits, fortunate encounters.");
    expect(prompt).toContain("PER (Perception): Awareness, spotting hidden things, sensing danger, reading people.");
  });

  it("recalculates derived subskills when the AI raises STR via STATE_UPDATE (multi-turn)", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce('You train hard. [STATE_UPDATE]{"str": 20}[/STATE_UPDATE]')
      .mockResolvedValueOnce("You rest. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I train my strength.", false);
    expect(StateModule.state.char.str).toBe(20);
    // negotiation = floor(10*1.5 - 20*0.2) = 11; intimidation = floor((20+10)/2) = 15
    expect(StateModule.state.subskills).toEqual({
      seduction: 10,
      sneaking: 15,
      negotiation: 11,
      intimidation: 15,
    });

    // The next turn's prompt and payload both use the recalculated values.
    await GameEngine.executeTurn("I rest.", false);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    const turn2Payload = mockGenerateResponse.mock.calls[1][1] as string;
    expect(turn2Prompt).toContain(
      "Derived Skills - Seduction: 10, Sneaking: 15, Negotiation: 11, Intimidation: 15.",
    );
    expect(turn2Payload).toContain(
      "Subskills: Seduction 10, Sneaking 15, Negotiation 11, Intimidation 15.",
    );
  });

  it("scales derived subskills when the AI raises cultivation (multi-turn)", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce('You break through. [STATE_UPDATE]{"cultivation": 1.0}[/STATE_UPDATE]')
      .mockResolvedValueOnce("You steady yourself. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I meditate on the dao.", false);
    expect(StateModule.state.char.cultivation).toBe(1.0);
    // The jump 0 -> 1.0 auto-triggers Mortal Awakening (+1 all) and Qi
    // Gathering (+2/+2/+2/+1, +20 max HP), so base stats become 13/13/13/12.
    // Effective stats (mult 1.2) are 15/15/15/14, giving:
    //   seduction = (14+15)/2 = 14; sneaking = 15*1.5 = 22;
    //   negotiation = 14*1.5 - 15*0.2 = 18; intimidation = (15+14)/2 = 14
    expect(StateModule.state.char.str).toBe(13);
    expect(StateModule.state.char.agi).toBe(13);
    expect(StateModule.state.char.cha).toBe(12);
    expect(StateModule.state.char.maxHealth).toBe(120);
    expect(StateModule.state.subskills).toEqual({
      seduction: 14,
      sneaking: 22,
      negotiation: 18,
      intimidation: 14,
    });
  });

  it("anchors subskills and effective stats in the per-turn payload every interaction", async () => {
    mockGenerateResponse.mockResolvedValue(
      "The barmaid raises an eyebrow. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]",
    );
    await GameEngine.executeTurn("I try to charm the barmaid.", false);

    const [sysPrompt, payloadText] = mockGenerateResponse.mock.calls[0] as [string, string];
    expect(sysPrompt).toContain(
      "Derived Skills - Seduction: 10, Sneaking: 15, Negotiation: 13, Intimidation: 10.",
    );
    expect(payloadText).toContain(
      "Subskills: Seduction 10, Sneaking 15, Negotiation 13, Intimidation 10.",
    );
    expect(payloadText).toContain("Effective Stats: STR 10, AGI 10, INT 10, CHA 10.");
  });

  it("activates genre-specific secondary-stat guidance", () => {
    const setup = StateModule.state.setup as { activeGenres?: string[] };
    setup.activeGenres = ["xianxia"];
    expect(buildSystemPrompt()).toContain(
      "Secondary stats WILL (willpower/qi control), PER (spiritual sense) are active.",
    );

    setup.activeGenres = ["survival"];
    expect(buildSystemPrompt()).toContain(
      "Secondary stat END (endurance) is active.",
    );

    setup.activeGenres = [];
    expect(buildSystemPrompt()).not.toContain("Secondary stats WILL");
    expect(buildSystemPrompt()).not.toContain("Secondary stat END");
  });
});

// ===========================================================================
// 4. Gift pipeline — [GIFT] / [NPC_GIFT] tags.
// [GIFT] lands in the gift log and moves the recipient's affection/trust;
// [NPC_GIFT] attaches equipment to the NPC profile (shown in the prompt's
// NPC PROFILES section next turn) and applies stat-based threshold bonuses.
// ===========================================================================

describe("Gift pipeline — [GIFT] and [NPC_GIFT] tags", () => {
  beforeEach(resetState);

  it("logs a [GIFT] and applies its affection/trust change to the recipient's profile", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The herbalist smiles. [RELATION]{"name": "Mara", "disposition": "Friendly merchant", "status": "Alive"}[/RELATION]',
      )
      .mockResolvedValueOnce(
        'You hand over the bouquet. [GIFT]{"giver": "MC", "recipient": "Mara", "itemName": "Rose Bouquet", "relationshipChange": "+20 affection", "timestamp": "Monday, March 17, 07:10", "accepted": true}[/GIFT]',
      )
      .mockResolvedValueOnce("Mara blushes. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I buy roses for Mara.", false);
    await GameEngine.executeTurn("I give the roses to Mara.", false);

    // The gift lands in the log.
    expect(StateModule.state.giftLog.length).toBe(1);
    const entry = StateModule.state.giftLog[0];
    expect(entry.giver).toBe("MC");
    expect(entry.recipient).toBe("Mara");
    expect(entry.itemName).toBe("Rose Bouquet");
    expect(entry.accepted).toBe(true);

    // +20 affection also nudges trust by half that (adjustAffection).
    const mara = StateModule.state.npcProfiles.find((p) => p.npcName === "Mara");
    expect(mara?.affection).toBe(70);
    expect(mara?.trust).toBe(60);

    await GameEngine.executeTurn("I wait.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    expect(turn3Prompt).toContain("Trust: 60/100 | Affection: 70/100");
  });

  it("applies explicit negative trust, ignores rejected gifts, and falls back to +5 for generic positives", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'Mara appears. [RELATION]{"name": "Mara", "disposition": "Friendly merchant", "status": "Alive"}[/RELATION]',
      )
      .mockResolvedValueOnce(
        'You snub her. [GIFT]{"giver": "MC", "recipient": "Mara", "itemName": "A cold nod", "relationshipChange": "-15 trust", "timestamp": "Monday, March 17, 07:10", "accepted": true}[/GIFT]',
      )
      .mockResolvedValueOnce(
        'You mock her gift. [GIFT]{"giver": "MC", "recipient": "Mara", "itemName": "Lukewarm porridge", "relationshipChange": "+10 affection", "timestamp": "Monday, 07:20 AM", "accepted": false}[/GIFT]',
      )
      .mockResolvedValueOnce(
        'You compliment her. [GIFT]{"giver": "MC", "recipient": "Mara", "itemName": "A kind word", "relationshipChange": "+she seems pleased", "timestamp": "Monday, 07:30 AM", "accepted": true}[/GIFT]',
      )
      .mockResolvedValueOnce("The day ends. [STATE_UPDATE]{\"time\": \"Monday, 07:40 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I see Mara.", false);
    await GameEngine.executeTurn("I snub her.", false);
    // Accepted gift with an explicit negative trust delta (parsed correctly).
    expect(StateModule.state.giftLog.length).toBe(1);
    let mara = StateModule.state.npcProfiles.find((p) => p.npcName === "Mara");
    expect(mara?.trust).toBe(35);
    expect(mara?.affection).toBe(50);

    await GameEngine.executeTurn("I mock her.", false);
    // Rejected gift: still logged, but no relationship change applied.
    expect(StateModule.state.giftLog.length).toBe(2);
    mara = StateModule.state.npcProfiles.find((p) => p.npcName === "Mara");
    expect(mara?.trust).toBe(35);
    expect(mara?.affection).toBe(50);

    await GameEngine.executeTurn("I compliment her.", false);
    // "+she seems pleased" matches no affection/trust keyword, so the
    // generic "+" fallback grants +5 affection (and +2 trust via half rule).
    expect(StateModule.state.giftLog.length).toBe(3);
    mara = StateModule.state.npcProfiles.find((p) => p.npcName === "Mara");
    expect(mara?.affection).toBe(55);
    expect(mara?.trust).toBe(37);
  });

  it("attaches [NPC_GIFT] equipment to the profile and lists it in the next turn's prompt", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'Mara appears. [RELATION]{"name": "Mara", "disposition": "Friendly merchant", "status": "Alive"}[/RELATION]',
      )
      .mockResolvedValueOnce(
        'You give her the locket. [NPC_GIFT]{"npcName": "Mara", "item": {"name": "Silver Locket", "slot": "neck", "rarity": "rare", "stats": {"cha": 5}}}[/NPC_GIFT]',
      )
      .mockResolvedValueOnce("Mara wears it. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I meet Mara.", false);
    await GameEngine.executeTurn("I give Mara the locket.", false);

    const mara = StateModule.state.npcProfiles.find((p) => p.npcName === "Mara");
    expect(mara?.equipment.length).toBe(1);
    const item = mara?.equipment[0];
    expect(item?.name).toBe("Silver Locket");
    expect(item?.slot).toBe("neck");
    expect(item?.rarity).toBe("rare");
    expect(item?.giftedBy).toBe("Unnamed Protagonist");
    // cha +5 → affection +floor(5*0.3) = +1.
    expect(mara?.affection).toBe(51);

    await GameEngine.executeTurn("I watch her admire it.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    expect(turn3Prompt).toContain("Equipment:");
    expect(turn3Prompt).toContain("- [neck] Silver Locket (rare) (gifted by Unnamed Protagonist)");
  });

  it("replaces same-slot NPC equipment and applies str-based aggression bonuses", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'Doran appears. [RELATION]{"name": "Doran", "disposition": "Cheerful", "status": "Alive"}[/RELATION]',
      )
      .mockResolvedValueOnce(
        'You hand him a blade. [NPC_GIFT]{"npcName": "Doran", "item": {"name": "Iron Sword", "slot": "weapon", "rarity": "common", "stats": {"str": 10}}}[/NPC_GIFT]',
      )
      .mockResolvedValueOnce(
        'You hand him a better blade. [NPC_GIFT]{"npcName": "Doran", "item": {"name": "Steel Sword", "slot": "weapon", "rarity": "uncommon", "stats": {"str": 8}}}[/NPC_GIFT]',
      )
      .mockResolvedValueOnce("Doran grins. [STATE_UPDATE]{\"time\": \"Monday, 07:30 AM\"}[/STATE_UPDATE]");

    await GameEngine.executeTurn("I meet Doran.", false);
    await GameEngine.executeTurn("I give Doran the iron sword.", false);
    const doran = StateModule.state.npcProfiles.find((p) => p.npcName === "Doran");
    expect(doran?.equipment.length).toBe(1);
    expect(doran?.equipment[0].name).toBe("Iron Sword");
    // str +10 → aggressionThreshold +floor(10*0.5) = +5 (50 -> 55).
    expect(doran?.aggressionThreshold).toBe(55);

    await GameEngine.executeTurn("I swap in the steel sword.", false);
    // Same slot: replaced in place, not appended.
    expect(doran?.equipment.length).toBe(1);
    expect(doran?.equipment[0].name).toBe("Steel Sword");
    // str 8 → +4 stacked onto the current threshold (55 -> 59).
    expect(doran?.aggressionThreshold).toBe(59);
  });
});

// ===========================================================================
// 5. Active Modifiers / Artifact state pipeline.
// The AI WRITES the modifiers bag through [STATE_UPDATE]"modifiers" (flat
// scalars only: strings, numbers, booleans) and DRAWS from it every turn —
// the bag is re-injected into the system prompt and the per-turn payload, and
// the output spec tells the AI to drain or remove entries when they change.
// ===========================================================================

describe("Active Modifiers / Artifact state pipeline", () => {
  beforeEach(resetState);

  it("persists artifact and status modifiers written via [STATE_UPDATE] and exposes them to the AI next turn", async () => {
    const artifactMods = {
      flying_sword: "Tier 3 flying sword — flight speed 500%",
      shadowcloak: "Tier 2 Shadowcloak — invisible to anyone below Tier 2",
      sneak_difficulty_bonus: "-2 difficulty for same-tier sneaking",
      poison: "active",
      poison_severity: 30,
      artifact_charge: 3,
      haste_active: true,
    };
    mockGenerateResponse
      .mockResolvedValueOnce(
        `The sword hums. [STATE_UPDATE]{"modifiers": ${JSON.stringify(artifactMods)}}[/STATE_UPDATE]`,
      )
      .mockResolvedValueOnce(
        "You drift above the rooftops. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I activate the flying sword.", false);
    // Written: the full bag lands in state, untouched.
    expect(StateModule.state.modifiers).toEqual(artifactMods);

    // Drawn: the next turn's system prompt and per-turn payload both carry it.
    await GameEngine.executeTurn("I fly across the city.", false);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    const turn2Payload = mockGenerateResponse.mock.calls[1][1] as string;
    expect(turn2Prompt).toContain(
      `Active Modifiers/State Modulations: ${JSON.stringify(artifactMods)}`,
    );
    expect(turn2Payload).toContain(
      `Active Persistent Modifiers Schema: ${JSON.stringify(artifactMods)}`,
    );
    // The write-pipeline instruction (how to record/drain entries) is present.
    expect(turn2Prompt).toContain(
      "CRITICAL Modifier Rules: Record modifications (like passive income, artifact charge, special protection buffs) inside the 'modifiers' object.",
    );
  });

  it("replaces the whole bag when the AI drains or cancels modifiers", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The talisman glows. [STATE_UPDATE]{"modifiers": {"artifact_charge": 3, "passive_income": "5 copper per day"}}[/STATE_UPDATE]',
      )
      .mockResolvedValueOnce(
        'The glow fades. [STATE_UPDATE]{"modifiers": {"artifact_charge": 2}}[/STATE_UPDATE]',
      )
      .mockResolvedValueOnce(
        "The coin pouch stays quiet. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I charge the talisman.", false);
    await GameEngine.executeTurn("I use a charge.", false);
    // Drained in place; the cancelled passive income was removed with it.
    expect(StateModule.state.modifiers).toEqual({ artifact_charge: 2 });

    await GameEngine.executeTurn("I rest.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    expect(turn3Prompt).toContain(
      `Active Modifiers/State Modulations: ${JSON.stringify({ artifact_charge: 2 })}`,
    );
    expect(turn3Prompt).not.toContain("passive_income");
  });

  it("saves system points both as a stat and inside the modifiers bag", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'Points shimmer. [STATE_UPDATE]{"systemPoints": 5, "modifiers": {"system_charge": 5, "system_spent": 2}}[/STATE_UPDATE]',
      )
      .mockResolvedValueOnce(
        "You spend a point. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I absorb the system energy.", false);
    expect(StateModule.state.char.systemPoints).toBe(5);
    expect(StateModule.state.modifiers).toEqual({ system_charge: 5, system_spent: 2 });

    await GameEngine.executeTurn("I invest a point.", false);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    // The stat lands in the MC Stats line; the bag lands in Active Modifiers.
    expect(turn2Prompt).toContain("SystemPoints=5");
    expect(turn2Prompt).toContain(
      `Active Modifiers/State Modulations: ${JSON.stringify({ system_charge: 5, system_spent: 2 })}`,
    );
  });

  it("clamps system points at zero", async () => {
    mockGenerateResponse.mockResolvedValueOnce(
      'You spend everything. [STATE_UPDATE]{"systemPoints": -3}[/STATE_UPDATE]',
    );
    await GameEngine.executeTurn("I go into debt.", false);
    expect(StateModule.state.char.systemPoints).toBe(0);
  });

  it("keeps artifact modifiers visible alongside the subskills they modify (sneak pipeline)", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The cloak settles over you. [STATE_UPDATE]{"modifiers": {"shadowcloak": "Tier 2", "invisibility": "vs cultivation below Tier 2", "sneak_difficulty_bonus": "-2 vs same tier"}}[/STATE_UPDATE]',
      )
      .mockResolvedValueOnce(
        "You slip past the guard. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]",
      )
      .mockResolvedValueOnce(
        "Still hidden. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I don the Shadowcloak.", false);
    await GameEngine.executeTurn("I sneak past the guard.", false);
    // Both the modifier AND the derived skill it affects are in the same
    // prompt, so the AI can apply the difficulty modifier narratively.
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    // (key-value pair without the leading brace — the key sits mid-object
    // after shadowcloak/invisibility in the compact JSON the prompt renders).
    expect(turn2Prompt).toContain('"sneak_difficulty_bonus":"-2 vs same tier"');
    expect(turn2Prompt).toContain(
      "Derived Skills - Seduction: 10, Sneaking: 15, Negotiation: 13, Intimidation: 10.",
    );

    // It persists into a third turn — the AI keeps drawing from it.
    await GameEngine.executeTurn("I keep sneaking.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    expect(turn3Prompt).toContain('"shadowcloak":"Tier 2"');
  });

  it("rejects nested modifier values (flat scalars only) without partially applying the update", async () => {
    mockGenerateResponse.mockResolvedValueOnce(
      'The artifact pulses. [STATE_UPDATE]{"modifiers": {"shadowcloak": {"tier": 2}}, "time": "Monday, March 17, 07:10"}[/STATE_UPDATE]',
    );
    await GameEngine.executeTurn("I try to encode the cloak.", false);
    // The whole block is skipped — nothing applied, including the time.
    expect(StateModule.state.modifiers).toEqual({});
    expect(StateModule.state.worldState.time).toBe("Monday, March 17, 07:00");
    expect(LoreModule.lastIssues[0]?.kind).toBe("STATE_UPDATE");
  });
});

// ===========================================================================
// 6. TIME_STATE pipeline — time-based status effects (poison, drunk, ...).
// [TIME_STATE] upserts a state by id; every non-initial turn ticks it forward
// (duration drains, severity moves by severityDeltaPerTick per interval, and
// zero duration auto-expires it); [TIME_STATE_REMOVE] removes it explicitly.
// Active states are injected into the next turn's prompt.
// ===========================================================================

describe("TIME_STATE pipeline — status effects", () => {
  beforeEach(resetState);

  it("applies a poison [TIME_STATE], ticks severity down, and shows it in the next turn's prompt", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The dagger glints. [TIME_STATE]{"id":"poison","name":"Poisoned","target":"mc","severity":30,"durationMinutes":120,"tickIntervalMinutes":10,"severityDeltaPerTick":-5,"showInUI":true,"description":"Slow-acting venom"}[/TIME_STATE]',
      )
      .mockResolvedValueOnce(
        "You feel the venom. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I get stabbed.", false);
    expect(StateModule.state.timeStates.length).toBe(1);
    expect(StateModule.state.timeStates[0]).toMatchObject({
      id: "poison",
      target: "mc",
      severity: 30,
      durationMinutes: 120,
      severityDeltaPerTick: -5,
    });

    await GameEngine.executeTurn("I stagger on.", false);
    // The start-of-turn tick drained 10 minutes and one -5 severity step.
    expect(StateModule.state.timeStates[0].severity).toBe(25);
    expect(StateModule.state.timeStates[0].durationMinutes).toBe(110);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    expect(turn2Prompt).toContain("=== ACTIVE TIME-BASED STATES ===");
    expect(turn2Prompt).toContain(
      "Poisoned on mc: Severity 25 (Moderate), 2h remaining, tick every 10min (healing)",
    );
    // The rules section teaches the AI how the state behaves.
    expect(turn2Prompt).toContain("have real-time durations in minutes, not turn-counts.");
  });

  it("ticks a worsening state's severity up across turns", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'You drink deeply. [TIME_STATE]{"id":"drunk","name":"Drunk","target":"mc","severity":20,"durationMinutes":90,"tickIntervalMinutes":10,"severityDeltaPerTick":15,"showInUI":true}[/TIME_STATE]',
      )
      .mockResolvedValueOnce(
        "The room spins. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]",
      )
      .mockResolvedValueOnce(
        "You sway. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I drink the wine.", false);
    await GameEngine.executeTurn("I stand up.", false);
    // One tick: +15 severity, -10 min duration.
    expect(StateModule.state.timeStates[0].severity).toBe(35);
    expect(StateModule.state.timeStates[0].durationMinutes).toBe(80);
    expect(mockGenerateResponse.mock.calls[1][0]).toContain(
      "Drunk on mc: Severity 35 (Moderate), 2h remaining, tick every 10min (worsening)",
    );

    await GameEngine.executeTurn("I try to walk.", false);
    expect(StateModule.state.timeStates[0].severity).toBe(50);
    expect(mockGenerateResponse.mock.calls[2][0]).toContain(
      "Drunk on mc: Severity 50 (Severe), 2h remaining, tick every 10min (worsening)",
    );
  });

  it("removes a state via [TIME_STATE_REMOVE] so it vanishes from state and prompt", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The dagger glints. [TIME_STATE]{"id":"poison","name":"Poisoned","target":"mc","severity":30,"durationMinutes":120,"tickIntervalMinutes":10,"severityDeltaPerTick":-5}[/TIME_STATE]',
      )
      .mockResolvedValueOnce(
        "You down the antidote. [TIME_STATE_REMOVE]poison[/TIME_STATE_REMOVE]",
      )
      .mockResolvedValueOnce(
        "The pain fades. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I get stabbed.", false);
    await GameEngine.executeTurn("I drink the antidote.", false);
    expect(StateModule.state.timeStates.length).toBe(0);

    await GameEngine.executeTurn("I rest.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    // (The output-format spec always contains the word "Poisoned" as an
    // example, so assert on the section header and the entry line instead.)
    expect(turn3Prompt).not.toContain("ACTIVE TIME-BASED STATES");
    expect(turn3Prompt).not.toContain("Poisoned on mc");
  });

  it("auto-expires a state whose duration runs out via natural ticking", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'A ward flickers. [TIME_STATE]{"id":"ward","name":"Warded","target":"mc","severity":10,"durationMinutes":5,"tickIntervalMinutes":10,"severityDeltaPerTick":0}[/TIME_STATE]',
      )
      .mockResolvedValueOnce(
        "The ward fades. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I cast the ward.", false);
    expect(StateModule.state.timeStates.length).toBe(1);

    await GameEngine.executeTurn("A moment passes.", false);
    // The first tick consumes the full 5-minute duration -> auto-removed.
    expect(StateModule.state.timeStates.length).toBe(0);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    expect(turn2Prompt).not.toContain("ACTIVE TIME-BASED STATES");
  });

  it("merges a re-emitted [TIME_STATE] with the same id instead of duplicating it", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The dagger glints. [TIME_STATE]{"id":"poison","name":"Poisoned","target":"mc","severity":30,"durationMinutes":120,"tickIntervalMinutes":10,"severityDeltaPerTick":-5}[/TIME_STATE]',
      )
      .mockResolvedValueOnce(
        'You are stabbed again. [TIME_STATE]{"id":"poison","name":"Poisoned","target":"mc","severity":60,"durationMinutes":200,"tickIntervalMinutes":10,"severityDeltaPerTick":-5}[/TIME_STATE]',
      )
      .mockResolvedValueOnce(
        "The venom spreads. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I get stabbed.", false);
    await GameEngine.executeTurn("I get stabbed again.", false);
    // Turn 2's start-of-turn tick lowered it (30→25, 120→110), then the
    // re-emission merged in the new values — still exactly ONE state.
    expect(StateModule.state.timeStates.length).toBe(1);
    expect(StateModule.state.timeStates[0].severity).toBe(60);
    expect(StateModule.state.timeStates[0].durationMinutes).toBe(200);
  });
});

// ===========================================================================
// 7. Equipment pipeline — equipped artifacts with stat bonuses.
// [EQUIPMENT] slots gear onto the MC; the EQUIPPED ITEMS section shows it,
// and getEffectiveStats() folds its bonuses into the effective stats the AI
// sees (system prompt + per-turn payload) and the UI stat panel.
// ===========================================================================

describe("Equipment pipeline — equipped artifacts", () => {
  beforeEach(resetState);

  it("equips a flying sword via [EQUIPMENT], lists it in EQUIPPED ITEMS, and adds its bonuses to effective stats", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The blade hums to life. [EQUIPMENT]{"itemId": "flying-sword", "name": "Flying Sword of the Azure Wind", "slot": "weapon", "rarity": "legendary", "stats": {"str": 3, "agi": 5}, "desc": "A Tier 3 flying sword that carries the wielder at 500% speed", "equipped": true}[/EQUIPMENT]',
      )
      .mockResolvedValueOnce(
        "You rise into the air. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I draw the flying sword.", false);
    const equipped = StateModule.state.equipped;
    expect(equipped.length).toBe(1);
    expect(equipped[0].name).toBe("Flying Sword of the Azure Wind");
    expect(equipped[0].slot).toBe("weapon");
    expect(equipped[0].equipped).toBe(true);
    expect(EquipmentModule.getBonuses()).toEqual({ str: 3, agi: 5 });

    await GameEngine.executeTurn("I fly across the river.", false);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    const turn2Payload = mockGenerateResponse.mock.calls[1][1] as string;
    // The EQUIPPED ITEMS section lists the artifact with its stats.
    expect(turn2Prompt).toContain("=== EQUIPPED ITEMS ===");
    expect(turn2Prompt).toContain(
      "- [weapon] Flying Sword of the Azure Wind (legendary): str+3, agi+5",
    );
    // Its bonuses flow into the effective stats the AI is told about.
    expect(turn2Prompt).toContain("Base STR: 10 (Effective: 13)");
    expect(turn2Prompt).toContain("Base AGI: 10 (Effective: 15)");
    expect(turn2Prompt).toContain("Base INT: 10 (Effective: 10)");
    expect(turn2Payload).toContain("Effective Stats: STR 13, AGI 15, INT 10, CHA 10.");
  });

  it("replaces the previous weapon in the slot and only the new item's bonuses count", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'You draw the iron blade. [EQUIPMENT]{"itemId": "iron-sword", "name": "Iron Sword", "slot": "weapon", "rarity": "common", "stats": {"str": 2}, "desc": "A plain iron blade", "equipped": true}[/EQUIPMENT]',
      )
      .mockResolvedValueOnce(
        'You unsheathe the steel blade. [EQUIPMENT]{"itemId": "steel-sword", "name": "Steel Sword", "slot": "weapon", "rarity": "uncommon", "stats": {"str": 4}, "desc": "A finely tempered steel blade", "equipped": true}[/EQUIPMENT]',
      )
      .mockResolvedValueOnce(
        "The steel hums. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I equip the iron sword.", false);
    await GameEngine.executeTurn("I switch to the steel sword.", false);
    const equipped = StateModule.state.equipped;
    // The weapon slot is replaced in place — the old blade is discarded.
    expect(equipped.length).toBe(1);
    expect(equipped[0].itemId).toBe("steel-sword");
    expect(equipped[0].name).toBe("Steel Sword");
    expect(equipped[0].equipped).toBe(true);

    await GameEngine.executeTurn("I test the blade.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    // Only the steel sword's +4 counts — not the old iron sword's +2.
    expect(turn3Prompt).toContain("Base STR: 10 (Effective: 14)");
    expect(turn3Prompt).toContain("- [weapon] Steel Sword (uncommon): str+4");
    expect(turn3Prompt).not.toContain("Iron Sword");
  });

  it("sums bonuses across multiple equipped slots into effective stats", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'You don your gear. [EQUIPMENT]{"itemId": "sword", "name": "Bronze Sword", "slot": "weapon", "rarity": "common", "stats": {"str": 3}, "desc": "A sturdy bronze blade", "equipped": true}[/EQUIPMENT] [EQUIPMENT]{"itemId": "ring", "name": "Might Ring", "slot": "ring", "rarity": "rare", "stats": {"str": 2, "cha": 1}, "desc": "A band of hardened iron", "equipped": true}[/EQUIPMENT]',
      )
      .mockResolvedValueOnce(
        "You flex. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I gear up.", false);
    expect(EquipmentModule.getBonuses()).toEqual({ str: 5, cha: 1 });

    await GameEngine.executeTurn("I stand tall.", false);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    expect(turn2Prompt).toContain("Base STR: 10 (Effective: 15)");
    expect(turn2Prompt).toContain("Base CHA: 10 (Effective: 11)");
    // Each item is listed separately in the section.
    expect(turn2Prompt).toContain("- [weapon] Bronze Sword (common): str+3");
    expect(turn2Prompt).toContain("- [ring] Might Ring (rare): str+2, cha+1");
  });

  it("feeds equipped bonuses into derived subskills (AGI gear raises Sneaking)", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The boots hum. [EQUIPMENT]{"itemId": "swift-boots", "name": "Swift Boots", "slot": "feet", "rarity": "rare", "stats": {"agi": 5}, "desc": "Woven with wind-aspected silk", "equipped": true}[/EQUIPMENT]',
      )
      .mockResolvedValueOnce(
        "You dart across the courtyard. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I put on the swift boots.", false);
    // effAgi = 10 + 5 = 15 → sneaking = floor(15 * 1.5) = 22 (was 15).
    expect(StateModule.state.subskills).toEqual({
      seduction: 10,
      sneaking: 22,
      negotiation: 13,
      intimidation: 10,
    });

    await GameEngine.executeTurn("I sneak across the courtyard.", false);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    const turn2Payload = mockGenerateResponse.mock.calls[1][1] as string;
    expect(turn2Prompt).toContain(
      "Derived Skills - Seduction: 10, Sneaking: 22, Negotiation: 13, Intimidation: 10.",
    );
    expect(turn2Payload).toContain(
      "Subskills: Seduction 10, Sneaking 22, Negotiation 13, Intimidation 10.",
    );
  });

  it("lets STR gear shift Negotiation and Intimidation through effective stats", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The gauntlets settle. [EQUIPMENT]{"itemId": "bear-gauntlets", "name": "Gauntlets of the Bear", "slot": "hands", "rarity": "epic", "stats": {"str": 4}, "desc": "Heavy plates that grant raw strength", "equipped": true}[/EQUIPMENT]',
      )
      .mockResolvedValueOnce(
        "Your grip tightens. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I strap on the gauntlets.", false);
    // effStr = 14 → negotiation = floor(10*1.5 - 14*0.2) = 12;
    // intimidation = floor((14+10)/2) = 12.
    expect(StateModule.state.subskills).toEqual({
      seduction: 10,
      sneaking: 15,
      negotiation: 12,
      intimidation: 12,
    });

    await GameEngine.executeTurn("I flex.", false);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    expect(turn2Prompt).toContain(
      "Derived Skills - Seduction: 10, Sneaking: 15, Negotiation: 12, Intimidation: 12.",
    );
  });

  it("recomputes subskills when gear is swapped (new bonuses replace old)", async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The boots hum. [EQUIPMENT]{"itemId": "swift-boots", "name": "Swift Boots", "slot": "feet", "rarity": "rare", "stats": {"agi": 5}, "desc": "Woven with wind-aspected silk", "equipped": true}[/EQUIPMENT]',
      )
      .mockResolvedValueOnce(
        'You swap footwear. [EQUIPMENT]{"itemId": "light-boots", "name": "Light Boots", "slot": "feet", "rarity": "common", "stats": {"agi": 2}, "desc": "Simple leather boots", "equipped": true}[/EQUIPMENT]',
      )
      .mockResolvedValueOnce(
        "You step lightly. [STATE_UPDATE]{\"time\": \"Monday, 07:20 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I wear the swift boots.", false);
    expect(StateModule.state.subskills.sneaking).toBe(22);

    await GameEngine.executeTurn("I switch to the light boots.", false);
    // effAgi = 10 + 2 = 12 → sneaking = floor(12 * 1.5) = 18.
    expect(StateModule.state.subskills.sneaking).toBe(18);
  });

  it("feeds equipped bonuses into extended genre subskills (INT gear raises Alchemy)", async () => {
    const setup = StateModule.state.setup as { activeGenres?: string[] };
    setup.activeGenres = ["xianxia"]; // alchemy is xianxia-eligible
    const alchemy = SUBSKILLS.find((sk) => sk.id === "alchemy")!;
    const melee = SUBSKILLS.find((sk) => sk.id === "melee")!;

    mockGenerateResponse
      .mockResolvedValueOnce(
        'The circlet gleams. [EQUIPMENT]{"itemId": "sages-focus", "name": "Sage\'s Focus", "slot": "ring", "rarity": "epic", "stats": {"int": 3}, "desc": "A ring that sharpens the mind", "equipped": true}[/EQUIPMENT]',
      )
      .mockResolvedValueOnce(
        "You sense the herbs. [STATE_UPDATE]{\"time\": \"Monday, 07:10 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I put on the ring.", false);
    // effINT = 13 → alchemy = floor(13*1.5) = 19 (base 15); melee untouched.
    expect(GenreModule.computeSubskill(alchemy)).toBe(19);
    expect(GenreModule.computeSubskill(melee)).toBe(15);
    // The four core derived skills recalc from the same stats too.
    expect(StateModule.state.subskills.seduction).toBe(11); // (10 + 13) / 2
  });
});

// ===========================================================================
// 8. All pipelines combined — one fully-geared, poisoned MC.
// A single multi-turn run applies equipment, artifact modifiers, and a status
// effect, then asserts the next turn's prompt carries every pipeline
// coherently, each in its canonical section, without losing any of them.
// ===========================================================================

describe("Combined pipelines — one fully-geared MC", () => {
  beforeEach(resetState);

  it("carries the flying sword, Shadowcloak modifiers, and poison in the next turn's prompt", async () => {
    const shadowcloakMods = {
      shadowcloak: "Tier 2 Shadowcloak — invisible to anyone below Tier 2",
      invisibility: "vs cultivation below Tier 2",
      sneak_difficulty_bonus: "-2 vs same tier",
    };
    mockGenerateResponse
      // Turn 1: equip the flying sword (stat bonuses).
      .mockResolvedValueOnce(
        'The blade hums to life. [EQUIPMENT]{"itemId": "flying-sword", "name": "Flying Sword of the Azure Wind", "slot": "weapon", "rarity": "legendary", "stats": {"str": 3, "agi": 5}, "desc": "A Tier 3 flying sword that carries the wielder at 500% speed", "equipped": true}[/EQUIPMENT]',
      )
      // Turn 2: don the Shadowcloak (artifact modifiers bag).
      .mockResolvedValueOnce(
        `The cloak settles over you. [STATE_UPDATE]{"modifiers": ${JSON.stringify(shadowcloakMods)}}[/STATE_UPDATE]`,
      )
      // Turn 3: get poisoned (time-based state).
      .mockResolvedValueOnce(
        'The dagger finds your side. [TIME_STATE]{"id":"poison","name":"Poisoned","target":"mc","severity":30,"durationMinutes":120,"tickIntervalMinutes":10,"severityDeltaPerTick":-5}[/TIME_STATE]',
      )
      // Turn 4: the assertion turn — benign response with a fresh tag.
      .mockResolvedValueOnce(
        "You steady yourself. [STATE_UPDATE]{\"time\": \"Monday, 07:30 AM\"}[/STATE_UPDATE]",
      );

    await GameEngine.executeTurn("I draw the flying sword.", false);
    await GameEngine.executeTurn("I don the Shadowcloak.", false);
    await GameEngine.executeTurn("A dagger finds me.", false);

    // All three pipelines are live in state after their turns.
    expect(StateModule.state.equipped.length).toBe(1);
    expect(StateModule.state.modifiers.shadowcloak).toBe(shadowcloakMods.shadowcloak);
    expect(StateModule.state.timeStates[0].id).toBe("poison");

    await GameEngine.executeTurn("I stagger onward.", false);
    const turn4Prompt = mockGenerateResponse.mock.calls[3][0] as string;
    const turn4Payload = mockGenerateResponse.mock.calls[3][1] as string;

    // --- Equipment pipeline: sword listed, bonuses in effective stats. ---
    expect(turn4Prompt).toContain("=== EQUIPPED ITEMS ===");
    expect(turn4Prompt).toContain(
      "- [weapon] Flying Sword of the Azure Wind (legendary): str+3, agi+5",
    );
    expect(turn4Prompt).toContain("Base STR: 10 (Effective: 13)");
    expect(turn4Prompt).toContain("Base AGI: 10 (Effective: 15)");
    expect(turn4Payload).toContain("Effective Stats: STR 13, AGI 15, INT 10, CHA 10.");

    // --- Subskill pipeline: the gear-boosted Sneaking sits next to the
    // cloak's sneak-difficulty modifier so the AI can apply both together. ---
    expect(turn4Prompt).toContain(
      "Derived Skills - Seduction: 10, Sneaking: 22, Negotiation: 12, Intimidation: 11.",
    );
    expect(turn4Prompt).toContain('"sneak_difficulty_bonus":"-2 vs same tier"');

    // --- Modifiers pipeline: the Shadowcloak bag in prompt + payload. ---
    expect(turn4Prompt).toContain(
      `Active Modifiers/State Modulations: ${JSON.stringify(shadowcloakMods)}`,
    );
    expect(turn4Payload).toContain(
      `Active Persistent Modifiers Schema: ${JSON.stringify(shadowcloakMods)}`,
    );

    // --- TIME_STATE pipeline: poison ticked once and shown. ---
    expect(turn4Prompt).toContain("=== ACTIVE TIME-BASED STATES ===");
    expect(turn4Prompt).toContain(
      "Poisoned on mc: Severity 25 (Moderate), 2h remaining, tick every 10min (healing)",
    );
    expect(StateModule.state.timeStates[0].severity).toBe(25);

    // --- Coherence: the sections appear in the prompt's canonical order
    // (modifiers in MAIN CHARACTER → EQUIPPED ITEMS → TIME-BASED STATES). ---
    const modIdx = turn4Prompt.indexOf("Active Modifiers/State Modulations:");
    const eqIdx = turn4Prompt.indexOf("=== EQUIPPED ITEMS ===");
    const tsIdx = turn4Prompt.indexOf("=== ACTIVE TIME-BASED STATES ===");
    expect(modIdx).toBeGreaterThan(-1);
    expect(eqIdx).toBeGreaterThan(modIdx);
    expect(tsIdx).toBeGreaterThan(eqIdx);
  });
});

// ===========================================================================
// UI stat sidebar — the same geared-up MC rendered into the live sidebar.
// The engine re-renders the sidebar on its own every turn (LoreModule.extract
// → CultivationModule.checkBreakthroughs → UIManager.renderAllSidebars), so
// the test only registers the DOM elements and READS them; there are no
// manual render calls anywhere in the test body.
// ===========================================================================

describe("UI stat sidebar — the geared-up MC", () => {
  beforeEach(() => {
    resetState();
    for (const id of [
      "ui-mc-name",
      "ui-genre-label",
      "ui-str",
      "ui-agi",
      "ui-int",
      "ui-cha",
      "ui-str-container",
      "ui-agi-container",
      "ui-int-container",
      "ui-cha-container",
      "ui-end",
      "ui-wil",
      "ui-lck",
      "ui-per",
      "ui-time",
      "ui-location",
      "ui-subskills-list",
      "ui-modifiers-list",
      "ui-time-state-list",
      "ui-equipment-list",
      "ui-cha-bonus",
    ]) {
      testElements.set(id, makeTestElement());
    }
  });
  afterEach(() => {
    testElements.clear();
  });

  it("renders effective stats, gear-boosted subskills, modifiers, and the poison state in one sidebar", async () => {
    // Same three setup turns as the combined-pipelines E2E: equip the flying
    // sword, don the Shadowcloak (modifiers bag), get poisoned (TIME_STATE).
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The blade hums to life. [EQUIPMENT]{"itemId": "flying-sword", "name": "Flying Sword of the Azure Wind", "slot": "weapon", "rarity": "legendary", "stats": {"str": 3, "agi": 5}, "desc": "A Tier 3 flying sword that carries the wielder at 500% speed", "equipped": true}[/EQUIPMENT]',
      )
      .mockResolvedValueOnce(
        'The cloak settles over you. [STATE_UPDATE]{"modifiers": {"shadowcloak": "Tier 2 Shadowcloak — invisible to anyone below Tier 2", "invisibility": "vs cultivation below Tier 2", "sneak_difficulty_bonus": "-2 vs same tier"}}[/STATE_UPDATE]',
      )
      .mockResolvedValueOnce(
        'The dagger finds your side. [TIME_STATE]{"id":"poison","name":"Poisoned","target":"mc","severity":30,"durationMinutes":120,"tickIntervalMinutes":10,"severityDeltaPerTick":-5}[/TIME_STATE]',
      )
      .mockResolvedValueOnce('You steady yourself. [STATE_UPDATE]{"time": "Monday, 07:30 AM"}[/STATE_UPDATE]');

    await GameEngine.executeTurn("I draw the flying sword.", false);
    await GameEngine.executeTurn("I don the Shadowcloak.", false);
    await GameEngine.executeTurn("A dagger finds me.", false);
    await GameEngine.executeTurn("I stagger onward.", false);

    const el = (id: string) => testElements.get(id) as TestElement;

    // --- Effective stats: base 10 + sword str+3/agi+5 at Tier 0. ---
    expect(el("ui-str").innerText).toBe("13");
    expect(el("ui-agi").innerText).toBe("15");
    expect(el("ui-int").innerText).toBe("10");
    expect(el("ui-cha").innerText).toBe("10");
    // The hover tooltip explains the base → effective math.
    expect(el("ui-str-container").title).toContain("Base STR: 10 | Effective: 13");
    expect(el("ui-str-container").title).toContain("+0% scaling from Tier 0 Cultivation");

    // --- Secondary stats have no gear channel — still 10. ---
    expect(el("ui-end").textContent).toBe("10");
    expect(el("ui-wil").textContent).toBe("10");

    // --- Subskills panel: gear feeds the derived + genre subskills alike. ---
    const subskills = el("ui-subskills-list").innerHTML;
    expect(subskills).toContain("Sneaking");
    expect(subskills).toContain("22"); // floor(15 × 1.5)
    expect(subskills).toContain("Melee Combat");
    expect(subskills).toContain("20"); // floor(13 × 1.2 + 15 × 0.3)
    expect(subskills).toContain("Negotiation");
    expect(subskills).toContain("12"); // floor(10 × 1.5 − 13 × 0.2)

    // --- Modifiers panel: the Shadowcloak bag renders key + value. ---
    const mods = el("ui-modifiers-list").innerHTML;
    expect(mods).toContain("shadowcloak");
    expect(mods).toContain("Tier 2 Shadowcloak — invisible to anyone below Tier 2");
    expect(mods).toContain("sneak difficulty bonus");
    expect(mods).toContain("-2 vs same tier");

    // --- Time states panel: poison after its first tick. ---
    const ts = el("ui-time-state-list").innerHTML;
    expect(ts).toContain("Poisoned");
    expect(ts).toContain("Target: mc");
    expect(ts).toContain("Severity: 25/100");
    expect(ts).toContain("healing");

    // --- Equipment panel: the sword occupies its weapon slot. ---
    expect(el("ui-equipment-list").innerHTML).toContain("Flying Sword of the Azure Wind");
  });

  it("explains the Charm Aura source in the CHA stat tooltip while it is active", () => {
    StateModule.state.modifiers.charm_aura =
      "active (5t/5t, 50m/50m): +20% CHA vs attracted targets";
    UIManager.renderAllSidebars();

    const el = (id: string) => testElements.get(id) as TestElement;
    expect(el("ui-cha-container").title).toContain("Charm Aura active: +2 CHA");
    expect(el("ui-cha").innerText).toBe("12");
    // The green chip next to the stat shows the bonus and is not hidden.
    expect(el("ui-cha-bonus").textContent).toBe("+2");
    expect(el("ui-cha-bonus").classList.contains("hidden")).toBe(false);
    // Other stat tooltips stay untouched.
    expect(el("ui-str-container").title).not.toContain("Charm Aura");
  });

  it("hides the CHA bonus chip when no aura is active", () => {
    UIManager.renderAllSidebars();
    const el = (id: string) => testElements.get(id) as TestElement;
    expect(el("ui-cha").innerText).toBe("10");
    expect(el("ui-cha-bonus").classList.contains("hidden")).toBe(true);
  });

  it("shows the level-scaled aura bonus in the CHA tooltip", () => {
    SkillModule.extract(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK]',
    );
    // A well-trained aura: level 4, effect declares no numeric bonus, so the
    // level-scaled default (+1 base + 4 levels = +5) applies.
    const aura = StateModule.state.char.learnedSkills.find((sk) => sk.id === "charm_aura");
    if (aura) aura.level = 4;
    StateModule.state.modifiers.charm_aura =
      "active (5t/5t, 50m/50m): Radiate an aura that draws others in";
    UIManager.renderAllSidebars();

    const el = (id: string) => testElements.get(id) as TestElement;
    expect(el("ui-cha-container").title).toContain("Charm Aura active: +5 CHA");
    expect(el("ui-cha").innerText).toBe("15"); // 10 + (1 + 4)
    // The chip scales with the level too.
    expect(el("ui-cha-bonus").textContent).toBe("+5");
    expect(el("ui-cha-bonus").classList.contains("hidden")).toBe(false);
  });
});

// ===========================================================================
// Household sidebar panel — the MC's registered family rendered in its own
// section, mirroring the NPC Profiles panel. Only appears when family exists.
// ===========================================================================

describe("UI household panel — the MC's family in the sidebar", () => {
  beforeEach(() => {
    resetState();
    for (const id of ["ui-household-list", "panel-household", "ui-household-body"]) {
      testElements.set(id, makeTestElement());
    }
    // The chevron's initial classes come from the HTML markup.
    const chev = makeTestElement();
    chev.classList.add("fa-solid", "fa-chevron-down");
    testElements.set("ui-household-chevron", chev);
  });
  afterEach(() => {
    testElements.clear();
  });

  it("folds away like the skill tree and restores on toggle", () => {
    StateModule.state.char.appearance = "He lives with his mother.";
    seedFamilyRelations(StateModule.state.char.appearance);
    UIManager.renderAllSidebars();

    const body = testElements.get("ui-household-body") as TestElement;
    const chevron = testElements.get("ui-household-chevron") as TestElement;
    // Default: expanded (unlike the skill tree, the household is identity info).
    expect(body.classList.contains("hidden")).toBe(false);
    expect(chevron.classList.contains("fa-chevron-down")).toBe(true);
    // Collapse: the body hides and the chevron flips to "right".
    UIManager.toggleHousehold();
    expect(body.classList.contains("hidden")).toBe(true);
    expect(chevron.classList.contains("fa-chevron-right")).toBe(true);
    expect(chevron.classList.contains("fa-chevron-down")).toBe(false);
    // Expand again: fully restored.
    UIManager.toggleHousehold();
    expect(body.classList.contains("hidden")).toBe(false);
    expect(chevron.classList.contains("fa-chevron-down")).toBe(true);
  });

  it("renders family members with names, roles, aliases, and alive/deceased status", async () => {
    StateModule.state.char.appearance =
      "Lin Hao lives with his widowed mother Diane and his younger sister Lily.";
    seedFamilyRelations(StateModule.state.char.appearance);
    UIManager.renderAllSidebars();

    const list = testElements.get("ui-household-list") as TestElement;
    const html = list.innerHTML;
    expect(html).toContain("Diane");
    expect(html).toContain("MC&#039;s mother"); // escapeHtml escapes the apostrophe
    expect(html).toContain("aka Mother");
    expect(html).toContain("alive");
    expect(html).toContain("Lily");
    expect(html).toContain("MC&#039;s younger sister");
    // The deceased father (inferred from "widowed") renders with the
    // deceased styling instead of profile bars.
    expect(html).toContain("Father");
    expect(html).toContain("deceased");
    // The panel is visible because family exists.
    expect((testElements.get("panel-household") as TestElement).style.display).toBe("block");
  });

  it("hides the panel entirely when the MC has no registered family", () => {
    UIManager.renderAllSidebars();
    expect((testElements.get("panel-household") as TestElement).style.display).toBe("none");
  });
});

// ===========================================================================
// UI recent-checks panel — the last stat-check outcomes in the sidebar
// ===========================================================================

describe("UI recent-checks panel — why checks pass or fail at a glance", () => {
  beforeEach(() => {
    resetState();
    for (const id of ["ui-checks-list", "panel-checks", "ui-checks-body"]) {
      testElements.set(id, makeTestElement());
    }
    // The chevron's initial classes come from the HTML markup.
    const chev = makeTestElement();
    chev.classList.add("fa-solid", "fa-chevron-down");
    testElements.set("ui-checks-chevron", chev);
  });
  afterEach(() => {
    testElements.clear();
  });

  it("folds away like the skill tree and restores on toggle", () => {
    UIManager.renderAllSidebars();
    const body = testElements.get("ui-checks-body") as TestElement;
    const chevron = testElements.get("ui-checks-chevron") as TestElement;
    // Default: expanded.
    expect(body.classList.contains("hidden")).toBe(false);
    expect(chevron.classList.contains("fa-chevron-down")).toBe(true);
    // Collapse: the body hides and the chevron flips to "right".
    UIManager.toggleChecks();
    expect(body.classList.contains("hidden")).toBe(true);
    expect(chevron.classList.contains("fa-chevron-right")).toBe(true);
    expect(chevron.classList.contains("fa-chevron-down")).toBe(false);
    // Expand again: fully restored.
    UIManager.toggleChecks();
    expect(body.classList.contains("hidden")).toBe(false);
    expect(chevron.classList.contains("fa-chevron-down")).toBe(true);
  });

  it("shows the panel when statChecks is on and hides it when off", () => {
    UIManager.renderAllSidebars();
    expect((testElements.get("panel-checks") as TestElement).style.display).toBe("block");
    StateModule.state.toggles.statChecks = false;
    UIManager.renderAllSidebars();
    expect((testElements.get("panel-checks") as TestElement).style.display).toBe("none");
  });

  it("shows an empty state before any check has resolved", () => {
    UIManager.renderAllSidebars();
    const list = testElements.get("ui-checks-list") as TestElement;
    expect(list.innerHTML).toContain("No checks yet");
  });

  it("renders the resolved check with stat, difficulty, roll vs target, margin, and tier", async () => {
    setCheckRng(() => 0.5); // roll 11
    mockGenerateResponse.mockResolvedValue(
      'You work the lock. [CHECK]{"stat":"AGI","difficulty":"hard","context":"picking the lock"}[/CHECK]',
    );
    await GameEngine.executeTurn("I try to pick the lock.", false);

    // The panel re-renders automatically when the check resolves.
    const list = testElements.get("ui-checks-list") as TestElement;
    const html = list.innerHTML;
    // roll 11 + AGI 10 = 21 vs hard 14 -> margin +7 -> major success.
    expect(html).toContain("AGI");
    expect(html).toContain("roll 11");
    expect(html).toContain("= 21 vs hard 14");
    expect(html).toContain("margin +7");
    expect(html).toContain("major success");
    expect(html).toContain("picking the lock");
  });

  it("renders inferred difficulty with the marker in the row", async () => {
    makeWitness("Guard", { aggressionThreshold: 70, knownLocation: "Starting Location" });
    setCheckRng(() => 0.5);
    mockGenerateResponse.mockResolvedValue(
      'You plead your case. [CHECK]{"stat":"CHA","context":"convincing the guard"}[/CHECK]',
    );
    await GameEngine.executeTurn("I try to talk my way past the guard.", false);
    const html = (testElements.get("ui-checks-list") as TestElement).innerHTML;
    expect(html).toContain("vs hard 14");
    expect(html).toContain("· inferred");
  });
});

// ===========================================================================
// UI action-memory panel — the MC's remembered actions in the sidebar
// ===========================================================================

describe("UI action-memory panel — what the MC did, with whom, and how it went", () => {
  beforeEach(() => {
    resetState();
    for (const id of ["ui-action-memory-list", "panel-action-memory", "ui-action-memory-body"]) {
      testElements.set(id, makeTestElement());
    }
    const chev = makeTestElement();
    chev.classList.add("fa-solid", "fa-chevron-down");
    testElements.set("ui-action-memory-chevron", chev);
  });
  afterEach(() => {
    testElements.clear();
  });

  it("folds away like the checks panel and restores on toggle", () => {
    UIManager.renderAllSidebars();
    const body = testElements.get("ui-action-memory-body") as TestElement;
    const chevron = testElements.get("ui-action-memory-chevron") as TestElement;
    expect(body.classList.contains("hidden")).toBe(false);
    UIManager.toggleActionMemory();
    expect(body.classList.contains("hidden")).toBe(true);
    expect(chevron.classList.contains("fa-chevron-right")).toBe(true);
    UIManager.toggleActionMemory();
    expect(body.classList.contains("hidden")).toBe(false);
  });

  it("shows the panel when memory is on and hides it when off", () => {
    UIManager.renderAllSidebars();
    expect((testElements.get("panel-action-memory") as TestElement).style.display).toBe("block");
    StateModule.state.toggles.memory = false;
    UIManager.renderAllSidebars();
    expect((testElements.get("panel-action-memory") as TestElement).style.display).toBe("none");
  });

  it("renders the remembered actions with category and intensity", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 08:20";
    s.actionMemory.push({
      id: "am_1",
      summary: "Sparred with Rook at the dojo",
      npc: "Rook",
      category: "combat",
      intensity: 80,
      outcome: "won (major success)",
      time: "Monday, March 17, 08:20",
      turn: 8,
    });
    s.actionMemory.push({
      id: "am_2",
      summary: "Kissed Lin Mei",
      npc: "Lin Mei",
      category: "intimacy",
      intensity: 45,
      reward: "+180 system points",
      time: "Monday, March 17, 07:50",
      turn: 5,
    });
    UIManager.renderActionMemoryPanel();
    const html = (testElements.get("ui-action-memory-list") as TestElement).innerHTML;
    expect(html).toContain("Sparred with Rook at the dojo");
    expect(html).toContain("Kissed Lin Mei");
    expect(html).toContain("intensity 80");
    expect(html).toContain("+180 system points");
    expect(html).toContain("combat");
  });

  it("the compare button fills the chat input with an OOC comparison request naming the memory count", () => {
    const s = StateModule.state;
    s.worldState.location = "Dojo";
    s.actionMemory.push({
      id: "am_1",
      summary: "Sparred with Rook",
      npc: "Rook",
      category: "combat",
      intensity: 80,
      outcome: "won (major success)",
      time: "Monday, March 17, 08:20",
      turn: 8,
    });
    s.actionMemory.push({
      id: "am_2",
      summary: "Kissed Lin Mei",
      npc: "Lin Mei",
      category: "intimacy",
      intensity: 45,
      reward: "+180 points",
      time: "Monday, March 17, 07:50",
      turn: 5,
    });
    const input = makeTestElement();
    testElements.set("user-input", input);
    UIManager.prepareComparison();
    const v = (input as unknown as { value: string }).value;
    expect(v).toContain("[OOC compare]");
    expect(v).toContain("ACTION MEMORY LOG");
    expect(v).toContain("2 remembered actions");
    expect(v).toContain("at Dojo");
    // Ready to send through the normal chat flow — the RECENT ACTION MEMORY
    // block in the payload gives the model everything it needs to compare.
    expect(v).toContain("Compare my current situation");
  });
});

// ===========================================================================
// UI economy-history panel — the state-level story (systemPoints, items,
// currency movements) side by side with the action-memory log
// ===========================================================================

describe("UI economy-history panel — the state-level story next to the memory log", () => {
  beforeEach(() => {
    resetState();
    for (const id of ["ui-economy-list", "panel-economy-history", "ui-economy-body"]) {
      testElements.set(id, makeTestElement());
    }
    const chev = makeTestElement();
    chev.classList.add("fa-solid", "fa-chevron-down");
    testElements.set("ui-economy-chevron", chev);
  });
  afterEach(() => {
    testElements.clear();
  });

  it("shows next to the action-memory panel and folds away like it", () => {
    UIManager.renderAllSidebars();
    expect((testElements.get("panel-economy-history") as TestElement).style.display).toBe("block");
    const body = testElements.get("ui-economy-body") as TestElement;
    const chevron = testElements.get("ui-economy-chevron") as TestElement;
    expect(body.classList.contains("hidden")).toBe(false);
    UIManager.toggleEconomyHistory();
    expect(body.classList.contains("hidden")).toBe(true);
    expect(chevron.classList.contains("fa-chevron-right")).toBe(true);
    UIManager.toggleEconomyHistory();
    expect(body.classList.contains("hidden")).toBe(false);
  });

  it("hides with the memory toggle like the action-memory panel", () => {
    UIManager.renderAllSidebars();
    expect((testElements.get("panel-economy-history") as TestElement).style.display).toBe("block");
    StateModule.state.toggles.memory = false;
    UIManager.renderAllSidebars();
    expect((testElements.get("panel-economy-history") as TestElement).style.display).toBe("none");
  });

  it("renders only economy movements, colored gains green and outflows red", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 10:00";
    s.actionMemory.push(
      {
        id: "am_e1",
        summary: "Spent 200 system points",
        category: "economy",
        intensity: 40,
        outcome: "system points -200",
        time: "Monday, March 17, 10:00",
        turn: 21,
      },
      {
        id: "am_e2",
        summary: "Acquired Dried Herbs",
        category: "economy",
        intensity: 40,
        outcome: "inventory gain",
        time: "Monday, March 17, 10:00",
        turn: 22,
      },
      {
        id: "am_e3",
        summary: "Earned 250 USD",
        category: "economy",
        intensity: 35,
        outcome: "USD +250",
        time: "Monday, March 17, 10:15",
        turn: 23,
      },
      {
        // A non-economy memory must NOT appear in the economy-history list.
        id: "am_x",
        summary: "Kissed Lin Mei",
        category: "intimacy",
        intensity: 45,
        time: "Monday, March 17, 09:00",
        turn: 20,
      },
    );
    UIManager.renderEconomyHistoryPanel();
    const html = (testElements.get("ui-economy-list") as TestElement).innerHTML;
    expect(html).toContain("Spent 200 system points");
    expect(html).toContain("Acquired Dried Herbs");
    expect(html).toContain("Earned 250 USD");
    expect(html).toContain("system points -200");
    expect(html).toContain("USD +250");
    // Direction coloring: gains emerald, outflows red.
    expect(html).toContain("text-emerald-400");
    expect(html).toContain("text-red-400");
    // Non-economy entries never leak in.
    expect(html).not.toContain("Kissed Lin Mei");
  });

  it("shows the empty hint when nothing has moved yet", () => {
    UIManager.renderEconomyHistoryPanel();
    const html = (testElements.get("ui-economy-list") as TestElement).innerHTML;
    expect(html).toContain("No economy movement yet");
  });
});

// ===========================================================================
// Episodic action memory — durable records that survive restarts
// ===========================================================================

describe("episodic action memory — the MC's history the AI can compare against", () => {
  beforeEach(resetState);

  it("harvests explicit [MEMORY] tags with all fields", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 09:00";
    s.turnCount = 3;
    ActionMemoryModule.harvest({
      aiText:
        'They traded blows.\n[MEMORY]{"summary":"Sparred with Rook at the dojo","npc":"Rook","category":"combat","intensity":80,"outcome":"won the bout","reward":"+40 xp","detail":"He favored his left side"}[/MEMORY]',
    });
    expect(s.actionMemory).toHaveLength(1);
    expect(s.actionMemory[0]).toMatchObject({
      summary: "Sparred with Rook at the dojo",
      npc: "Rook",
      category: "combat",
      intensity: 80,
      outcome: "won the bout",
      reward: "+40 xp",
      detail: "He favored his left side",
      time: "Monday, March 17, 09:00",
      turn: 3,
    });
  });

  it("auto-harvests resolved [CHECK] results into memory", () => {
    const s = StateModule.state;
    s.char.str = 16;
    s.worldState.time = "Monday, March 17, 08:00";
    s.turnCount = 4;
    setCheckRng(() => 0.6);
    CheckModule.extract(
      '[CHECK]{"stat":"STR","difficulty":"hard","context":"arm-wrestling Rook"}[/CHECK]',
      "I arm-wrestle Rook.",
    );
    ActionMemoryModule.harvest({
      aiText: "",
      actionText: "I arm-wrestle Rook.",
      newChecks: s.checkLog.slice(-1),
    });
    expect(s.actionMemory).toHaveLength(1);
    expect(s.actionMemory[0]).toMatchObject({
      summary: "arm-wrestling Rook",
      category: "combat",
      outcome: expect.stringContaining("STR hard"),
    });
  });

  it("auto-harvests NPC reactions into memory", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 10:00";
    s.turnCount = 6;
    ActionMemoryModule.harvest({
      aiText: "",
      reactions: [{ npcName: "Wren", label: "with jealousy", trustDelta: -5, affectionDelta: -10 }],
    });
    expect(s.actionMemory[0]).toMatchObject({
      summary: "Wren reacted with jealousy",
      npc: "Wren",
      category: "social",
      outcome: "Affection -10, Trust -5",
    });
  });

  it("dedupes an identical summary within the same turn", () => {
    const s = StateModule.state;
    s.turnCount = 7;
    ActionMemoryModule.harvest({
      aiText: '[MEMORY]{"summary":"First kiss with Mara"}[/MEMORY]\n[MEMORY]{"summary":"First kiss with Mara"}[/MEMORY]',
    });
    expect(s.actionMemory).toHaveLength(1);
  });

  it("caps the log and prunes the oldest entries", () => {
    const s = StateModule.state;
    s.turnCount = 1;
    for (let i = 0; i < 50; i++) {
      s.actionMemory.push({
        id: `am_${i}`,
        summary: `Old action ${i}`,
        category: "other",
        intensity: 50,
        time: "t",
        turn: i,
      });
    }
    ActionMemoryModule.harvest({ aiText: '[MEMORY]{"summary":"The newest action"}[/MEMORY]' });
    expect(s.actionMemory.length).toBe(40);
    expect(s.actionMemory[0].summary).toBe("Old action 11");
    expect(s.actionMemory[39].summary).toBe("The newest action");
  });

  it("the reminder is empty with no memory and lists recent entries otherwise", () => {
    expect(getActionMemoryReminder()).toBe("");
    const s = StateModule.state;
// Chronological order: the older kiss first, the newer sparring last.
    s.actionMemory.push({
      id: "am_2",
      summary: "Kissed Lin Mei",
      category: "intimacy",
      intensity: 45,
      reward: "+180 points",
      time: "Monday, March 17, 07:50",
      turn: 5,
    });
    s.actionMemory.push({
      id: "am_1",
      summary: "Sparred with Rook",
      category: "combat",
      intensity: 80,
      outcome: "won (major success)",
      time: "Monday, March 17, 08:20",
      turn: 8,
    });
    const r = getActionMemoryReminder();
    expect(r).toContain("RECENT ACTION MEMORY");
    expect(r).toContain("Sparred with Rook");
    expect(r).toContain("Kissed Lin Mei");
    expect(r).toContain("+180 points");
    expect(r).toContain("intensity 45");
    // The newest entry (turn 8) comes first in the reminder.
    expect(r.indexOf("Sparred with Rook")).toBeLessThan(r.indexOf("Kissed Lin Mei"));
    // The anti-speculation instruction is baked into the reminder.
    expect(r).toContain("NEVER dismiss the player's references as speculation");
  });

  it("parseMemoryTags ignores malformed blocks without touching state", () => {
    expect(parseMemoryTags('[MEMORY]{bad json}[/MEMORY]')).toEqual([]);
    expect(parseMemoryTags('[MEMORY]{"summary":"ok"}[/MEMORY]')).toHaveLength(1);
  });

  it("harvests a kiss from the narration as an intimacy milestone (no [MEMORY] tag needed)", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 21:00";
    s.turnCount = 9;
    s.memory.relations.push({
      name: "Mara",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    ActionMemoryModule.harvest({
      aiText: "",
      narration:
        "Mara leaned in, her breath warm, and kissed him under the cherry tree. The world fell away.",
    });
    expect(s.actionMemory).toHaveLength(1);
    expect(s.actionMemory[0]).toMatchObject({
      summary: "Kissed Mara",
      npc: "Mara",
      category: "intimacy",
      intensity: 45,
      turn: 9,
    });
  });

  it("harvests hand-holding at a low intensity so later steps compare against it", () => {
    const s = StateModule.state;
    s.worldState.time = "Tuesday, March 18, 08:10";
    s.turnCount = 12;
    s.memory.relations.push({
      name: "Wren",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    ActionMemoryModule.harvest({
      aiText: "",
      actionText: "I hold Wren's hand as we walk to class.",
    });
    expect(s.actionMemory[0]).toMatchObject({
      summary: "Held hands with Wren",
      npc: "Wren",
      category: "intimacy",
      intensity: 12,
    });
  });

  it("a make-out outranks a plain kiss in the same sentence", () => {
    const s = StateModule.state;
    s.worldState.time = "t";
    s.turnCount = 1;
    s.memory.relations.push({
      name: "Elle",
      aliases: [],
      disposition: "Librarian",
      status: "Alive",
      modifiers: [],
    });
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "Elle pulled him close and they started making out by the stacks.",
    });
    expect(s.actionMemory[0].summary).toBe("Made out with Elle");
    expect(s.actionMemory[0].intensity).toBe(65);
  });

  it("metaphors (the sun kissed the ground) are never harvested", () => {
    const s = StateModule.state;
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "The morning sun kissed the dewy ground as he stepped outside alone.",
    });
    expect(s.actionMemory).toHaveLength(0);
  });

  it("narration + action mentioning the same kiss collapse into one memory", () => {
    const s = StateModule.state;
    s.worldState.time = "t";
    s.turnCount = 2;
    s.memory.relations.push({
      name: "Mara",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    ActionMemoryModule.harvest({
      aiText: "",
      actionText: "I lean in and kiss Mara goodbye.",
      narration: "Their lips met in one final kiss before the train arrived.",
    });
    expect(s.actionMemory).toHaveLength(1);
    expect(s.actionMemory[0].summary).toBe("Kissed Mara");
  });

  it("a hug is harvested as its own intimacy milestone", () => {
    const s = StateModule.state;
    s.worldState.time = "t";
    s.turnCount = 3;
    s.memory.relations.push({
      name: "Lin Mei",
      aliases: ["Sis"],
      disposition: "MC's younger sister",
      status: "Alive",
      modifiers: [],
    });
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "Before she left for school, Lin Mei hugged her brother tightly.",
    });
    expect(s.actionMemory[0]).toMatchObject({
      summary: "Hugged Lin Mei",
      category: "intimacy",
      intensity: 20,
    });
  });

  it("E2E: a turn's check lands in memory and the next turn's payload carries the RECENT ACTION MEMORY block", async () => {
    const s = StateModule.state;
    s.char.str = 16;
    setCheckRng(() => 0.6);
    mockGenerateResponse.mockResolvedValue(
      'You lock arms with Rook.\n[CHECK]{"stat":"STR","difficulty":"hard","context":"arm-wrestling Rook"}[/CHECK]',
    );
    await GameEngine.executeTurn("I arm-wrestle Rook.", false);
    expect(s.actionMemory.length).toBe(1);
    expect(s.actionMemory[0]).toMatchObject({
      summary: "arm-wrestling Rook",
      category: "combat",
    });
    // The second turn's payload tells the AI about yesterday's sparring.
    mockGenerateResponse.mockResolvedValue("Rook rubs his wrist, grinning.");
    await GameEngine.executeTurn("I point out that Rook is weaker than the last person I arm-wrestled.", false);
    const payload2 = mockGenerateResponse.mock.calls[1][1];
    expect(payload2).toContain("RECENT ACTION MEMORY");
    expect(payload2).toContain("arm-wrestling Rook");
    expect(payload2).toContain("STR hard");
  });

  it("harvests economic milestones from the narration (crypto trades with amounts)", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 10:00";
    s.turnCount = 12;
    ActionMemoryModule.harvest({
      aiText: "",
      narration:
        "You logged into your cryptocurrency trading platform and used all 847.50 USD to trade the next 30 minutes, then used 297.50 USD to trade more.",
      actionText: "I keep trading on the crypto exchange.",
    });
    const econ = s.actionMemory.filter((e) => e.category === "economy");
    expect(econ.length).toBeGreaterThan(0);
    // The amount-bearing crypto trade is remembered with the amount attached.
    expect(s.actionMemory.some((e) => e.summary.includes("Traded crypto") && e.summary.includes("847.50"))).toBe(true);
    // The generic "trade" verb without a platform also lands when an amount
    // is nearby — the core of the user's "first time" complaint.
    expect(s.actionMemory.some((e) => e.summary.includes("Traded") && e.summary.includes("297.50"))).toBe(true);
  });

  it("never harvests plans or non-economic 'trade' usage as memories", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 10:00";
    s.turnCount = 13;
    ActionMemoryModule.harvest({
      aiText: "",
      narration:
        "Gambling, crypto trading, flipping goods, even extorting others are ways to make income — but too risky. She bought time with small talk and traded blows with the guard.",
    });
    // "gambling ... are ways to make income" is a plan, not an act; "bought
    // time"/"traded blows" are idioms — none may become memories.
    expect(s.actionMemory.some((e) => e.category === "economy" && e.summary.includes("Gambled"))).toBe(false);
    expect(s.actionMemory.some((e) => e.summary.includes("Bought or sold"))).toBe(false);
    expect(s.actionMemory.some((e) => e.summary.includes("Traded"))).toBe(false);
  });

  it("harvests engine-recorded [TRANSACTION] blocks into economy memory", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 10:00";
    s.turnCount = 14;
    ActionMemoryModule.harvest({
      aiText: "",
      newTransactions: [
        { type: "buy", itemName: "Dried Herbs", amount: 3, currency: "Copper", partner: "Greta" },
        { type: "reward", itemName: "System Points", amount: 120, currency: "systemPoints" },
      ],
    });
    const econ = s.actionMemory.filter((e) => e.category === "economy");
    expect(econ.some((e) => e.summary === "Bought Dried Herbs from Greta" && e.outcome === "for 3 Copper")).toBe(true);
    expect(econ.some((e) => e.summary === "Rewarded with System Points" && e.outcome === "for 120 systemPoints")).toBe(true);
  });

  it("the reminder names economic comparisons and never claims 'first time'", () => {
    const s = StateModule.state;
    s.turnCount = 15;
    s.actionMemory.push({
      id: "am_econ_1",
      summary: "Traded crypto (847.50 USD)",
      category: "economy",
      intensity: 65,
      outcome: "for 847.50 USD",
      time: "Monday, March 17, 10:00",
      turn: 14,
    });
    const r = getActionMemoryReminder();
    expect(r).toContain("I traded crypto before");
    expect(r).toContain("never claim a trade or purchase is happening");
    expect(r).toContain("Traded crypto (847.50 USD)");
  });

  it("E2E: a trading turn's prose lands in memory and the next payload carries it", async () => {
    const s = StateModule.state;
    mockGenerateResponse.mockResolvedValue(
      'You used all 547.50 USD to trade on the crypto platform.\n[MEMORY]{"summary":"Traded crypto on the exchange","category":"economy","intensity":60,"reward":"+35 USD"}[/MEMORY]',
    );
    await GameEngine.executeTurn("I use my balance to trade crypto for 30 minutes.", false);
    expect(s.actionMemory.some((e) => e.summary.includes("Traded crypto on the exchange"))).toBe(true);
    // Next turn references the trade — the payload must carry it so the AI
    // cannot claim "first time".
    mockGenerateResponse.mockResolvedValue("The market is calmer today.");
    await GameEngine.executeTurn("Let's check how my earlier crypto trade is doing.", false);
    const payload2 = mockGenerateResponse.mock.calls[1][1];
    expect(payload2).toContain("RECENT ACTION MEMORY");
    expect(payload2).toContain("Traded crypto");
    expect(payload2).toContain("547.50");
  });

  it("first-time guard: 'never traded' claim with a logged trade yields a hard correction", () => {
    const s = StateModule.state;
    s.actionMemory.push({
      id: "am_ft_1",
      summary: "Traded crypto (847.50 USD)",
      category: "economy",
      intensity: 65,
      outcome: "for 847.50 USD",
      time: "Monday, March 17, 10:00",
      turn: 30,
    });
    const guard = getFirstTimeGuard(
      "I've never traded crypto before — let me open a trading account for the first time.",
    );
    expect(guard).toContain("SYSTEM CORRECTION");
    expect(guard).toContain("Traded crypto (847.50 USD)");
    expect(guard).toContain("turn 30");
    expect(guard).toContain("CONTINUATION");
    expect(guard).toContain("never traded before");
  });

  it("first-time guard: a genuine first time (no matching log entries) stays silent", () => {
    const s = StateModule.state;
    // The only memory is a social one — the "never traded" claim is honest.
    s.actionMemory.push({
      id: "am_ft_2",
      summary: "Sparred with Rook at the dojo",
      category: "combat",
      intensity: 80,
      outcome: "won the bout",
      time: "Monday, March 17, 09:00",
      turn: 28,
    });
    expect(getFirstTimeGuard("I've never traded crypto before.")).toBe("");
  });

  it("first-time guard: generic 'first time' with an unrelated economy log stays silent", () => {
    const s = StateModule.state;
    s.actionMemory.push({
      id: "am_ft_3",
      summary: "Traded crypto (847.50 USD)",
      category: "economy",
      intensity: 65,
      time: "Monday, March 17, 10:00",
      turn: 30,
    });
    // "first time I've been to the school library" names no trade/buy/sell
    // verb, so the unrelated trade memory must not trigger.
    expect(getFirstTimeGuard("This is the first time I've been to the school library.")).toBe("");
  });

  it("first-time guard: purchase claims are covered too, not just trades", () => {
    const s = StateModule.state;
    s.actionMemory.push({
      id: "am_ft_4",
      summary: "Bought Tools Kit from Hardware Store",
      category: "economy",
      intensity: 45,
      outcome: "for 200 USD",
      time: "Monday, March 17, 08:00",
      turn: 24,
    });
    const guard = getFirstTimeGuard("I've never bought tools from the hardware store before.");
    expect(guard).toContain("SYSTEM CORRECTION");
    expect(guard).toContain("Bought Tools Kit from Hardware Store");
  });

  it("E2E: a false 'never traded' claim gets the correction injected into the SAME turn's payload", async () => {
    const s = StateModule.state;
    s.actionMemory.push({
      id: "am_ft_e2e",
      summary: "Traded crypto (847.50 USD)",
      category: "economy",
      intensity: 65,
      outcome: "for 847.50 USD",
      time: "Monday, March 17, 10:00",
      turn: 30,
    });
    mockGenerateResponse.mockResolvedValue("The market opens and you watch the candles.");
    await GameEngine.executeTurn(
      "I've never traded crypto before — open a crypto trading account for the first time.",
      false,
    );
    const payload = mockGenerateResponse.mock.calls[0][1];
    expect(payload).toContain("SYSTEM CORRECTION — FIRST-TIME CLAIM CONTRADICTS ACTION MEMORY");
    expect(payload).toContain("Traded crypto (847.50 USD)");
    expect(payload).toContain("Do NOT narrate the MC as a newcomer");
  });

  it("auto-harvests narration-only NPC reactions ('Nina reacts warmly') into memory", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 11:00";
    s.turnCount = 16;
    s.memory.relations.push({
      name: "Nina",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "Nina reacts warmly to your joke, laughing as she nudges your shoulder.",
      actionText: "I tell Nina a joke.",
    });
    const entry = s.actionMemory.find((e) => e.summary.includes("Nina reacts warmly"));
    expect(entry).toMatchObject({
      npc: "Nina",
      category: "social",
      outcome: "warm reaction",
      turn: 16,
    });
  });

  it("auto-harvests reactions from the PLAYER's action text ('Nina seems happy')", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 11:00";
    s.turnCount = 16;
    s.memory.relations.push({
      name: "Nina",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    // The model's narration says nothing about her mood — the reaction lives
    // only in the player's first-person action text.
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "You hand her the gift box.",
      actionText: "I give Nina the gift. Nina seems happy about it.",
    });
    const entry = s.actionMemory.find((e) => e.npc === "Nina" && e.category === "social");
    expect(entry).toMatchObject({
      npc: "Nina",
      outcome: "warm reaction",
      turn: 16,
    });
    expect(entry?.summary).toMatch(/Nina.*seems happy/i);
  });

  it("catches MC-effect verbs: 'I make her happy' resolves to a warm reaction", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 11:00";
    s.turnCount = 16;
    s.memory.relations.push({
      name: "Nina",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    // The reaction is attributed through the MC's OWN effect on the NPC — no
    // "Nina reacts…" phrasing anywhere.
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "You head home after class.",
      actionText: "I stop by Nina's desk and make her happy with a small compliment.",
    });
    const entry = s.actionMemory.find((e) => e.npc === "Nina" && e.category === "social");
    expect(entry).toMatchObject({
      npc: "Nina",
      summary: "Made Nina happy",
      outcome: "warm reaction",
      turn: 16,
    });
  });

  it("MC-effect verbs: 'I made Nina angry' is a cold reaction", () => {
    const s = StateModule.state;
    s.turnCount = 16;
    s.memory.relations.push({
      name: "Nina",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "",
      actionText: "I made Nina angry with that remark.",
    });
    const entry = s.actionMemory.find((e) => e.npc === "Nina" && e.category === "social");
    expect(entry).toMatchObject({
      npc: "Nina",
      summary: "Made Nina angry",
      outcome: "cold reaction",
    });
  });

  it("MC-effect verbs: 'I cheer her up' and 'I calm her down' are warm", () => {
    const s = StateModule.state;
    s.turnCount = 16;
    s.memory.relations.push(
      {
        name: "Nina",
        aliases: [],
        disposition: "Classmate",
        status: "Alive",
        modifiers: [],
      },
      {
        name: "Rook",
        aliases: [],
        disposition: "Friend",
        status: "Alive",
        modifiers: [],
      },
    );
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "",
      actionText: "I cheer Nina up after her bad news, then calm Rook down before he panics.",
    });
    const nina = s.actionMemory.find((e) => e.npc === "Nina");
    expect(nina).toMatchObject({ summary: "Cheered Nina up", outcome: "warm reaction" });
    const rook = s.actionMemory.find((e) => e.npc === "Rook");
    expect(rook).toMatchObject({ summary: "Calmed Rook down", outcome: "warm reaction" });
  });

  it("MC-effect verbs: the direction guard skips 'Nina's gift makes ME happy'", () => {
    const s = StateModule.state;
    s.turnCount = 16;
    s.memory.relations.push({
      name: "Nina",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    // "me" as the object is the NPC acting on the MC — NOT an MC-effect on
    // the NPC, so no reaction memory is created.
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "",
      actionText: "Nina's gift makes me happy.",
    });
    expect(s.actionMemory.some((e) => e.npc === "Nina" && e.category === "social")).toBe(false);
  });

  it("dedupes a reaction named in BOTH the narration and the action text", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 11:00";
    s.turnCount = 16;
    s.memory.relations.push({
      name: "Nina",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "Nina seems happy about the gift.",
      actionText: "I give Nina the gift. Nina seems happy about it.",
    });
    const nina = s.actionMemory.filter((e) => e.npc === "Nina");
    expect(nina).toHaveLength(1);
  });

  it("E2E: a first-person action text reaction lands in memory and the next payload carries it", async () => {
    const s = StateModule.state;
    s.turnCount = 30;
    s.memory.relations.push({
      name: "Nina",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    mockGenerateResponse.mockResolvedValue(
      "You hand her the gift box and she opens it carefully.",
    );
    await GameEngine.executeTurn("I give Nina the gift. Nina seems happy about it.", false);
    expect(
      s.actionMemory.some((e) => e.npc === "Nina" && e.outcome === "warm reaction"),
    ).toBe(true);
    // The next turn's payload names her lingering warmth so the AI writes
    // continuity even though the model itself never described the reaction.
    mockGenerateResponse.mockResolvedValue("Nina smiles, still warm from the gift.");
    await GameEngine.executeTurn("I walk Nina to class.", false);
    const payload2 = mockGenerateResponse.mock.calls[1][1];
    expect(payload2).toContain("RECENT REACTIONS");
    expect(payload2).toContain("Nina reacted warmly");
  });

  it("hostile prose reactions are remembered with the cold label", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 11:00";
    s.turnCount = 17;
    s.memory.relations.push({
      name: "Mara",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "Mara glares at you and turns away without a word.",
    });
    const entry = s.actionMemory.find((e) => e.summary.includes("Mara glares at you"));
    expect(entry).toMatchObject({
      npc: "Mara",
      category: "social",
      outcome: "cold reaction",
      intensity: 65,
    });
  });

  it("skips NPCs that already reacted through the witness pipeline this turn", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 11:00";
    s.turnCount = 18;
    s.memory.relations.push({
      name: "Wren",
      aliases: [],
      disposition: "Friend",
      status: "Alive",
      modifiers: [],
    });
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "Wren reacts warmly to your kindness.",
      reactions: [{ npcName: "Wren", label: "with warmth", trustDelta: 4, affectionDelta: 6 }],
    });
    // Only the pipeline reaction is remembered — the prose line does not
    // create a second, duplicate entry for the same NPC.
    const wren = s.actionMemory.filter((e) => e.npc === "Wren");
    expect(wren).toHaveLength(1);
    expect(wren[0].outcome).toContain("Affection +6");
  });

  it("reaction recency: a last-turn warm reaction names the NPC and forbids a neutral reset", () => {
    const s = StateModule.state;
    s.turnCount = 40;
    s.actionMemory = [
      {
        id: "am_r1",
        summary: "Nina reacts warmly",
        npc: "Nina",
        category: "social",
        intensity: 55,
        outcome: "warm reaction",
        time: "Monday, March 17, 11:00",
        turn: 39,
      },
    ];
    const reminder = ActionMemoryModule.getReactionRecency();
    expect(reminder).toContain("RECENT REACTIONS");
    expect(reminder).toContain("Nina reacted warmly LAST TURN");
    expect(reminder).toContain("do NOT reset to neutral");
    expect(reminder).toContain("lingering warmth");
  });

  it("reaction recency: witness-pipeline entries (Affection/Trust deltas) are detected too", () => {
    const s = StateModule.state;
    s.turnCount = 40;
    s.actionMemory = [
      {
        id: "am_r2",
        summary: "Rook reacted with jealousy",
        npc: "Rook",
        category: "social",
        intensity: 70,
        outcome: "Affection -10, Trust -5",
        time: "Monday, March 17, 11:00",
        turn: 39,
      },
    ];
    const reminder = ActionMemoryModule.getReactionRecency();
    expect(reminder).toContain("Rook reacted coldly LAST TURN");
    expect(reminder).toContain("continued wariness or resentment");
  });

  it("reaction recency: reactions older than the window do not linger", () => {
    const s = StateModule.state;
    s.turnCount = 40;
    s.actionMemory = [
      {
        id: "am_r3",
        summary: "Nina reacts warmly",
        npc: "Nina",
        category: "social",
        intensity: 55,
        outcome: "warm reaction",
        time: "Monday, March 17, 09:00",
        turn: 35,
      },
    ];
    // 35 is 5 turns back — past the 2-turn window (intensity 55); the older
    // RECENT ACTION MEMORY block still carries the entry, but no carry-over
    // signal fires.
    expect(ActionMemoryModule.getReactionRecency()).toBe("");
  });

  it("reaction recency window scales with intensity (faint fades fast, critical lingers a day)", () => {
    // Unit: the window tiers.
    expect(ActionMemoryModule.reactionWindow(90)).toBe(12);
    expect(ActionMemoryModule.reactionWindow(70)).toBe(5);
    expect(ActionMemoryModule.reactionWindow(55)).toBe(2);
    expect(ActionMemoryModule.reactionWindow(30)).toBe(1);
    expect(ActionMemoryModule.reactionWindow(undefined)).toBe(1);
  });

  it("reaction recency: a critical-success warmth lingers many turns later", () => {
    const s = StateModule.state;
    s.turnCount = 40;
    s.actionMemory = [
      {
        id: "am_r4",
        summary: "Nina reacted with overwhelming warmth",
        npc: "Nina",
        category: "social",
        intensity: 90,
        outcome: "warm reaction",
        time: "Monday, March 17, 09:00",
        turn: 32,
      },
    ];
    // 8 turns back — far past the old fixed 2-turn window, but the intense
    // reaction (window 12) still colors today.
    const reminder = ActionMemoryModule.getReactionRecency();
    expect(reminder).toContain("Nina reacted warmly RECENTLY (turn 32)");
    expect(reminder).toContain("the stronger the reaction, the longer it lingers");
  });

  it("reaction recency: a faint reaction fades by the next turn", () => {
    const s = StateModule.state;
    s.turnCount = 40;
    s.actionMemory = [
      {
        id: "am_r5",
        summary: "Nina reacts faintly warmly",
        npc: "Nina",
        category: "social",
        intensity: 30,
        outcome: "warm reaction",
        time: "Monday, March 17, 09:00",
        turn: 38,
      },
    ];
    // 2 turns back — a faint reaction (window 1) no longer carries over.
    expect(ActionMemoryModule.getReactionRecency()).toBe("");
    // But it still shows if it happened LAST turn.
    s.actionMemory[0].turn = 39;
    const reminder = ActionMemoryModule.getReactionRecency();
    expect(reminder).toContain("Nina reacted warmly LAST TURN");
  });

  it("reaction recency: a strong reaction outlasts a faint one from the same NPC", () => {
    const s = StateModule.state;
    s.turnCount = 40;
    s.actionMemory = [
      {
        id: "am_r6",
        summary: "Nina reacted faintly warmly",
        npc: "Nina",
        category: "social",
        intensity: 30,
        outcome: "warm reaction",
        time: "Monday, March 17, 09:00",
        turn: 38,
      },
      {
        id: "am_r7",
        summary: "Nina reacted with deep warmth",
        npc: "Nina",
        category: "social",
        intensity: 75,
        outcome: "warm reaction",
        time: "Monday, March 17, 09:00",
        turn: 36,
      },
    ];
    // The faint recent one has faded (window 1) but the strong one from 4
    // turns back (window 5) still lingers.
    const reminder = ActionMemoryModule.getReactionRecency();
    expect(reminder).toContain("Nina reacted warmly RECENTLY (turn 36)");
  });

  it("reaction recency: non-reaction social entries and valenceless reactions are ignored", () => {
    const s = StateModule.state;
    s.turnCount = 40;
    s.actionMemory = [
      {
        id: "am_x1",
        summary: "Helped Mother with chores",
        npc: "Mother",
        category: "family",
        intensity: 40,
        time: "Monday, March 17, 11:00",
        turn: 39,
      },
      {
        id: "am_x2",
        summary: "Nina observes quietly",
        npc: "Nina",
        category: "social",
        intensity: 45,
        outcome: "Affection 0, Trust 0",
        time: "Monday, March 17, 11:00",
        turn: 39,
      },
    ];
    expect(ActionMemoryModule.getReactionRecency()).toBe("");
  });

  it("E2E: a warm reaction lands in memory and the NEXT turn's payload carries the recency signal", async () => {
    const s = StateModule.state;
    s.turnCount = 30;
    // Nina must be a known NPC for the prose scanner to attribute the
    // reaction to her.
    s.memory.relations.push({
      name: "Nina",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    mockGenerateResponse.mockResolvedValue(
      "Nina reacts warmly to your joke, laughing as she nudges your shoulder.",
    );
    await GameEngine.executeTurn("I tell Nina a joke.", false);
    // Either the witness pipeline ("Nina reacted warmly") or the prose
    // scanner ("Nina reacts warmly") records it — both are reactions.
    expect(
      s.actionMemory.some(
        (e) =>
          e.summary.includes("Nina reacts warmly") ||
          e.summary.includes("Nina reacted warmly"),
      ),
    ).toBe(true);
    // Turn 31: the payload now names Nina's lingering warmth so the AI writes
    // continuity instead of resetting her to neutral.
    mockGenerateResponse.mockResolvedValue("Nina smiles, still warm from earlier.");
    await GameEngine.executeTurn("I walk Nina to class.", false);
    const payload2 = mockGenerateResponse.mock.calls[1][1];
    expect(payload2).toContain("RECENT REACTIONS");
    expect(payload2).toContain("Nina reacted warmly LAST TURN");
  });

  it("catches the eye/face reaction phrasing ('Nina's eyes soften')", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 11:00";
    s.turnCount = 20;
    s.memory.relations.push({
      name: "Nina",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "Nina's eyes soften, a flicker of something you've never seen before.",
    });
    const entry = s.actionMemory.find((e) => e.summary.includes("Nina") && e.summary.includes("soften"));
    expect(entry).toMatchObject({
      summary: "Nina's eyes soften",
      npc: "Nina",
      category: "social",
      outcome: "warm reaction",
    });
  });

  it("a reaction without a registered NPC nearby is never a memory", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 11:00";
    s.turnCount = 19;
    ActionMemoryModule.harvest({
      aiText: "",
      narration: "The morning sun smiled warmly at the dewy garden.",
    });
    expect(s.actionMemory).toHaveLength(0);
  });

  it("E2E: a turn with only narrative reactions lands in memory and the next payload carries it", async () => {
    const s = StateModule.state;
    s.memory.relations.push({
      name: "Nina",
      aliases: [],
      disposition: "Classmate",
      status: "Alive",
      modifiers: [],
    });
    mockGenerateResponse.mockResolvedValue(
      "Nina reacts warmly to the gift, her eyes lighting up as she opens it.",
    );
    await GameEngine.executeTurn("I give Nina a small handmade gift.", false);
    expect(s.actionMemory.some((e) => e.summary.includes("Nina reacts warmly"))).toBe(true);
    mockGenerateResponse.mockResolvedValue("Nina hums contentedly.");
    await GameEngine.executeTurn("I ask Nina how she is feeling.", false);
    const payload2 = mockGenerateResponse.mock.calls[1][1];
    expect(payload2).toContain("RECENT ACTION MEMORY");
    expect(payload2).toContain("Nina reacts warmly");
  });

  it("parses [MEMORY_REF] citations in bare and JSON forms", () => {
    expect(parseMemoryRefs('[MEMORY_REF]am_1a2b3c[/MEMORY_REF]')).toEqual(["am_1a2b3c"]);
    expect(parseMemoryRefs('[MEMORY_REF]{"id":"am_xyz"}[/MEMORY_REF]')).toEqual(["am_xyz"]);
    expect(parseMemoryRefs("no citations here")).toEqual([]);
    expect(parseMemoryRefs(undefined)).toEqual([]);
    expect(parseMemoryRefs('[MEMORY_REF]am_1[/MEMORY_REF] and [MEMORY_REF]am_2[/MEMORY_REF]')).toEqual([
      "am_1",
      "am_2",
    ]);
    // Lenient recovery: local models often forget the closing tag.
    expect(parseMemoryRefs("This drill from [MEMORY_REF]am_9abc, which we completed before")).toEqual(["am_9abc"]);
  });

  it("resolves a [MEMORY_REF] id to its entry and reports unknown ids", () => {
    const s = StateModule.state;
    s.actionMemory.push({
      id: "am_spar",
      summary: "Sparred with Rook",
      category: "combat",
      intensity: 80,
      time: "Monday, March 17, 09:00",
      turn: 3,
    });
    const hit = ActionMemoryModule.resolveRef("am_spar");
    expect(hit).toBeDefined();
    expect(hit!.summary).toBe("Sparred with Rook");
    // Summary fallback: the model copied the text instead of the id.
    expect(ActionMemoryModule.resolveRef("Sparred with Rook")?.summary).toBe("Sparred with Rook");
    // Unknown id resolves to undefined so the caller can warn.
    expect(ActionMemoryModule.resolveRef("am_nope")).toBeUndefined();
    expect(ActionMemoryModule.resolveRef(undefined)).toBeUndefined();
  });

  it("the reminder exposes each entry's stable id for [MEMORY_REF]", () => {
    const s = StateModule.state;
    s.actionMemory.push({
      id: "am_rem1",
      summary: "Kissed Mara",
      category: "intimacy",
      intensity: 45,
      time: "Monday, March 17, 09:00",
      turn: 4,
    });
    const r = getActionMemoryReminder();
    expect(r).toContain("id am_rem1");
    expect(r).toContain("[MEMORY_REF]");
  });

  it("E2E: a [MEMORY_REF] citation resolves into a '🔗 builds on' history line, and a bad id warns", async () => {
    const s = StateModule.state;
    s.actionMemory.push({
      id: "am_spar2",
      summary: "Sparred with Rook at the dojo",
      category: "combat",
      intensity: 80,
      time: "Monday, March 17, 09:00",
      turn: 5,
    });
    mockGenerateResponse.mockResolvedValue(
      'You bow to Rook again.\n[MEMORY_REF]am_spar2[/MEMORY_REF]\n[MEMORY_REF]{"id":"am_ghost"}[/MEMORY_REF]',
    );
    await GameEngine.executeTurn("I challenge Rook to a rematch.", false);
    const sysLines = s.history.filter((m) => m.role === "system").map((m) => m.content);
    const buildsOn = sysLines.find((c) => c.includes("🔗 builds on"));
    expect(buildsOn).toBeDefined();
    expect(buildsOn).toContain("Sparred with Rook at the dojo");
    const warn = sysLines.find((c) => c.includes("doesn't match any remembered action"));
    expect(warn).toBeDefined();
    expect(warn).toContain("am_ghost");
    // cleanHistoryTags (run on resume/import) strips citation tags from the
    // stored assistant text so they never linger in the payload.
    const asst = s.history.filter((m) => m.role === "assistant").pop()!;
    expect(asst.content).toContain("[MEMORY_REF]");
    const cleaned = cleanHistoryTags(s.history);
    expect(cleaned).toBeGreaterThan(0);
    expect(asst.content).not.toContain("[MEMORY_REF]");
  });

  it("getMemoryDecay tiers: vivid <2 days, fading 2-3, hazy 4-7, faint 8+", () => {
    const now = "Monday, March 20, 10:00";
    // Same day / next day — vivid.
    expect(getMemoryDecay("Monday, March 20, 09:00", now).level).toBe(0);
    expect(getMemoryDecay("Sunday, March 19, 10:00", now).level).toBe(0);
    // 2-3 in-game days — fading.
    const fading = getMemoryDecay("Saturday, March 18, 10:00", now);
    expect(fading.level).toBe(1);
    expect(fading.daysOld).toBe(2);
    expect(fading.intensityMod).toBe(-15);
    expect(fading.label).toBe("fading memory");
    // 4-7 — hazy.
    const hazy = getMemoryDecay("Friday, March 16, 10:00", now);
    expect(hazy.level).toBe(2);
    expect(hazy.intensityMod).toBe(-30);
    expect(hazy.label).toBe("hazy memory");
    // 8+ — faint.
    const faint = getMemoryDecay("Tuesday, March 11, 10:00", now);
    expect(faint.level).toBe(3);
    expect(faint.intensityMod).toBe(-50);
    expect(faint.label).toBe("faint memory");
    // Unparseable times never decay.
    expect(getMemoryDecay("sometime ago", now).level).toBe(0);
    expect(getMemoryDecay("Monday, March 20, 09:00", "not a time").level).toBe(0);
  });

  it("the reminder marks faded entries with qualifiers and decayed intensity", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 20, 10:00";
    s.actionMemory = [
      {
        id: "am_recent",
        summary: "Sparred with Rook",
        category: "combat",
        intensity: 80,
        time: "Monday, March 20, 09:00",
        turn: 30,
      },
      {
        id: "am_hazy",
        summary: "Traded crypto",
        category: "economy",
        intensity: 70,
        outcome: "for 847.50 USD",
        time: "Thursday, March 13, 10:00",
        turn: 12,
      },
    ];
    const r = getActionMemoryReminder();
    // The recent entry stays vivid with its full intensity.
    expect(r).toContain("Sparred with Rook");
    expect(r).toContain("intensity 80");
    expect(r).not.toContain("Sparred with Rook · hazy");
    // The old entry is 7 in-game days old — hazy, with decayed intensity.
    expect(r).toContain("Traded crypto");
    expect(r).toContain("· hazy memory");
    expect(r).toContain("intensity 40");
    expect(r).not.toContain("intensity 70");
    // The stored entry itself is untouched — decay is read-time only.
    expect(s.actionMemory[1].intensity).toBe(70);
  });

  it("faint memories are prefixed so the AI hedges instead of reciting exact details", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 20, 10:00";
    s.actionMemory = [
      {
        id: "am_faint",
        summary: "Kissed Lin Mei",
        category: "intimacy",
        intensity: 45,
        outcome: "warm",
        time: "Tuesday, March 3, 10:00",
        turn: 2,
      },
    ];
    const r = getActionMemoryReminder();
    expect(r).toContain("Vaguely: Kissed Lin Mei");
    expect(r).toContain("· faint memory");
    // The id stays available for [MEMORY_REF] even when faded.
    expect(r).toContain("id am_faint");
  });

  it("computeEconomyDelta detects systemPoints and inventory movement", () => {
    const s = StateModule.state;
    s.char.systemPoints = 485;
    s.char.inventory = [{ name: "Smartphone", qty: 1, desc: "", props: {} }];
    const before = ActionMemoryModule.snapshotEconomy();
    // Simulate what a [STATE_UPDATE] would do: points spent, item gained.
    s.char.systemPoints = 285;
    s.char.inventory = [
      { name: "Smartphone", qty: 1, desc: "", props: {} },
      { name: "Dried Herbs", qty: 1, desc: "", props: {} },
    ];
    const delta = ActionMemoryModule.computeDelta(before);
    expect(delta.systemPointsDelta).toBe(-200);
    expect(delta.gainedItems).toEqual(["Dried Herbs"]);
    expect(delta.lostItems).toBeUndefined();
  });

  it("harvests [STATE_UPDATE] balance movement into economy memory", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 10:00";
    s.turnCount = 21;
    ActionMemoryModule.harvest({
      aiText: "",
      stateDelta: { systemPointsDelta: -200 },
    });
    expect(s.actionMemory.some((e) => e.summary === "Spent 200 system points" && e.outcome === "system points -200")).toBe(true);
  });

  it("harvests inventory gains that had no [TRANSACTION] tag", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 10:00";
    s.turnCount = 22;
    ActionMemoryModule.harvest({
      aiText: "",
      stateDelta: { gainedItems: ["Dried Herbs", "Iron Sword"] },
    });
    expect(s.actionMemory.some((e) => e.summary === "Acquired Dried Herbs" && e.category === "economy")).toBe(true);
    expect(s.actionMemory.some((e) => e.summary === "Acquired Iron Sword")).toBe(true);
  });

  it("skips inventory gains already recorded by a [TRANSACTION] tag", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 10:00";
    s.turnCount = 23;
    ActionMemoryModule.harvest({
      aiText: "",
      newTransactions: [{ type: "buy", itemName: "Dried Herbs", amount: 3, currency: "Copper" }],
      stateDelta: { gainedItems: ["Dried Herbs"] },
    });
    expect(s.actionMemory.some((e) => e.summary === "Acquired Dried Herbs")).toBe(false);
    expect(s.actionMemory.some((e) => e.summary === "Bought Dried Herbs")).toBe(true);
  });

  it("harvests inventory losses that had no [TRANSACTION] tag", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 10:00";
    s.turnCount = 24;
    ActionMemoryModule.harvest({
      aiText: "",
      stateDelta: { lostItems: ["Bomb"] },
    });
    expect(s.actionMemory.some((e) => e.summary === "Lost Bomb" && e.category === "economy")).toBe(true);
  });

  it("computeEconomyDelta detects currency balance movement", () => {
    const s = StateModule.state;
    s.currencies = [
      { name: "USD", amount: 1000, props: {} },
      { name: "Gold", amount: 5, props: {} },
    ];
    const before = ActionMemoryModule.snapshotEconomy();
    expect(before.currencies).toEqual({ USD: 1000, Gold: 5 });
    // What a [STATE_UPDATE] with a currencies array would do: USD spent,
    // gold earned, a new currency introduced.
    s.currencies = [
      { name: "USD", amount: 750, props: {} },
      { name: "Gold", amount: 8, props: {} },
      { name: "Copper", amount: 12, props: {} },
    ];
    const delta = ActionMemoryModule.computeDelta(before);
    expect(delta.currencyDeltas).toEqual([
      { name: "USD", delta: -250 },
      { name: "Gold", delta: 3 },
      { name: "Copper", delta: 12 },
    ]);
    expect(delta.systemPointsDelta).toBeUndefined();
  });

  it("the systemPoints pseudo-currency never double-reports with the real systemPoints delta", () => {
    const s = StateModule.state;
    // The game mirrors char.systemPoints into a "systemPoints" currency entry
    // — one balance move shows up in BOTH places.
    s.char.systemPoints = 485;
    s.currencies = [
      { name: "systemPoints", amount: 485, props: {} },
      { name: "USD", amount: 0, props: {} },
    ];
    const before = ActionMemoryModule.snapshotEconomy();
    // The pseudo-currency is excluded from the snapshot entirely.
    expect(before.currencies).toEqual({ USD: 0 });
    // A STATE_UPDATE moves system points AND the mirrored currency together.
    s.char.systemPoints = 285;
    s.currencies = [
      { name: "systemPoints", amount: 285, props: {} },
      { name: "USD", amount: 250, props: {} },
    ];
    const delta = ActionMemoryModule.computeDelta(before);
    expect(delta.systemPointsDelta).toBe(-200);
    // Only the real currency appears in the diff — no systemPoints entry.
    expect(delta.currencyDeltas).toEqual([{ name: "USD", delta: 250 }]);
    s.worldState.time = "Monday, March 17, 10:00";
    s.turnCount = 21;
    ActionMemoryModule.harvest({
      aiText: "",
      stateDelta: delta,
    });
    // ONE memory for the movement — the system-points entry, not a duplicate
    // "Spent 200 systemPoints" currency entry.
    const sp = s.actionMemory.filter((e) => /system points/i.test(e.summary || ""));
    expect(sp).toHaveLength(1);
    expect(sp[0].summary).toBe("Spent 200 system points");
    expect(s.actionMemory.some((e) => e.summary === "Spent 200 systemPoints")).toBe(false);
    expect(s.actionMemory.some((e) => e.summary === "Earned 250 USD")).toBe(true);
  });

  it("harvest ignores a hand-built stateDelta that smuggles in the pseudo-currency", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 10:00";
    s.turnCount = 21;
    ActionMemoryModule.harvest({
      aiText: "",
      stateDelta: { currencyDeltas: [{ name: "systemPoints", delta: -200 }] },
    });
    expect(s.actionMemory.some((e) => e.summary === "Spent 200 systemPoints")).toBe(false);
    expect(s.actionMemory.length).toBe(0);
  });

  it("harvests currency balance movement into economy memory", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 10:00";
    s.turnCount = 25;
    ActionMemoryModule.harvest({
      aiText: "",
      stateDelta: {
        currencyDeltas: [
          { name: "USD", delta: -250 },
          { name: "Gold", delta: 3 },
        ],
      },
    });
    expect(
      s.actionMemory.some(
        (e) => e.summary === "Spent 250 USD" && e.outcome === "USD -250" && e.category === "economy",
      ),
    ).toBe(true);
    expect(
      s.actionMemory.some(
        (e) => e.summary === "Earned 3 Gold" && e.outcome === "Gold +3" && e.category === "economy",
      ),
    ).toBe(true);
  });

  it("skips currency movement already recorded by a [TRANSACTION] tag", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 10:00";
    s.turnCount = 26;
    ActionMemoryModule.harvest({
      aiText: "",
      newTransactions: [{ type: "buy", itemName: "Dried Herbs", amount: 3, currency: "Copper" }],
      stateDelta: { currencyDeltas: [{ name: "Copper", delta: -3 }] },
    });
    // The purchase memory carries the price; a separate "Spent 3 Copper"
    // would double-count the same movement.
    expect(s.actionMemory.some((e) => e.summary === "Spent 3 Copper")).toBe(false);
    expect(s.actionMemory.some((e) => e.summary === "Bought Dried Herbs" && e.outcome === "for 3 Copper")).toBe(true);
    // A different-sized movement on the same currency still lands.
    ActionMemoryModule.harvest({
      aiText: "",
      newTransactions: [{ type: "buy", itemName: "Dried Herbs", amount: 3, currency: "Copper" }],
      stateDelta: { currencyDeltas: [{ name: "Copper", delta: -5 }] },
    });
    expect(s.actionMemory.some((e) => e.summary === "Spent 5 Copper")).toBe(true);
  });

  it("E2E: a [STATE_UPDATE] currency move lands in memory with no trade verb and no [TRANSACTION] tag", async () => {
    const s = StateModule.state;
    s.currencies = [{ name: "USD", amount: 1000, props: {} }];
    mockGenerateResponse.mockResolvedValue(
      'You transfer funds between accounts.\n[STATE_UPDATE]{"currencies": [{"name": "USD", "amount": 750}], "time": "Monday, March 17, 10:30", "location": "Bank", "inventory": [{"name": "Smartphone", "desc": "", "qty": 1, "props": {}}], "modifiers": {}}[/STATE_UPDATE]',
    );
    await GameEngine.executeTurn("I move some money to a reserve account.", false);
    // The balance itself moved (750 left) and the movement was remembered —
    // the prose said only "transfer", never "trade" or a price.
    expect(s.currencies.find((c) => c.name === "USD")?.amount).toBe(750);
    expect(
      s.actionMemory.some(
        (e) => e.summary === "Spent 250 USD" && e.outcome === "USD -250" && e.category === "economy",
      ),
    ).toBe(true);
    // The next turn's payload carries it so the AI knows the balance history.
    mockGenerateResponse.mockResolvedValue("The bank clerk nods.");
    await GameEngine.executeTurn("Let's see how my finances look now.", false);
    const payload2 = mockGenerateResponse.mock.calls[1][1];
    expect(payload2).toContain("RECENT ACTION MEMORY");
    expect(payload2).toContain("Spent 250 USD");
  });

  it("E2E: a [STATE_UPDATE] balance move lands in memory without any prose trade", async () => {
    const s = StateModule.state;
    s.char.systemPoints = 485;
    mockGenerateResponse.mockResolvedValue(
      'You transfer funds between accounts.\n[STATE_UPDATE]{"systemPoints": 285, "time": "Monday, March 17, 10:30", "location": "Bank", "inventory": [{"name": "Smartphone", "desc": "", "qty": 1, "props": {}}], "modifiers": {}}[/STATE_UPDATE]',
    );
    await GameEngine.executeTurn("I move some funds around for a planned purchase.", false);
    expect(s.actionMemory.some((e) => e.summary === "Spent 200 system points" && e.category === "economy")).toBe(true);
    // The next turn's payload carries the balance move so the AI knows it
    // happened even though the prose never said "trade".
    mockGenerateResponse.mockResolvedValue("The bank clerk nods.");
    await GameEngine.executeTurn("Let's see how my finances look now.", false);
    const payload2 = mockGenerateResponse.mock.calls[1][1];
    expect(payload2).toContain("RECENT ACTION MEMORY");
    expect(payload2).toContain("Spent 200 system points");
  });

  it("reconcileTransactionLog remembers recorded buys/sells even with no prose mention", () => {
    const s = StateModule.state;
    s.worldState.time = "Monday, March 17, 10:00";
    s.turnCount = 25;
    // The engine recorded these (via [TRANSACTION] or the fallback) but the
    // harvest never ran for them — reconciliation picks them up.
    s.transactionLog = [
      { id: "tx-herbs", type: "buy", itemName: "Dried Herbs", amount: 3, currency: "Copper", partner: "Greta", timestamp: "Monday, March 17, 10:00" },
      { id: "tx-sword", type: "sell", itemName: "Iron Sword", amount: 40, currency: "Copper", partner: "Market", timestamp: "Monday, March 17, 10:00" },
    ];
    const added = ActionMemoryModule.reconcileTransactions();
    expect(added).toBe(2);
    expect(s.actionMemory.some((e) => e.summary === "Bought Dried Herbs from Greta" && e.outcome === "for 3 Copper")).toBe(true);
    expect(s.actionMemory.some((e) => e.summary === "Sold Iron Sword from Market" && e.outcome === "for 40 Copper" && e.category === "economy")).toBe(true);
    // Idempotent: a second call adds nothing.
    expect(ActionMemoryModule.reconcileTransactions()).toBe(0);
    expect(s.actionMemory.length).toBe(2);
  });

  it("E2E: a fallback-recovered [TRANSACTION] lands in memory the same turn", async () => {
    const s = StateModule.state;
    // The fallback's follow-up reply emits the [TRANSACTION] block the main
    // response omitted.
    mockGenerateResponse.mockResolvedValueOnce("You bought the herbs from Greta and pocket them.");
    mockGenerateResponse.mockResolvedValueOnce(
      '[TRANSACTION]{"id": "tx-herbs2", "type": "buy", "itemName": "Dried Herbs", "amount": 3, "currency": "Copper", "timestamp": "Monday, March 17, 10:00", "partner": "Greta"}[/TRANSACTION]',
    );
    await GameEngine.executeTurn("I buy some herbs from Greta.", false);
    expect(s.transactionLog.some((t) => t.itemName === "Dried Herbs")).toBe(true);
    // The memory reconcile after the fallback recorded it this same turn — no
    // wait-until-next-turn gap.
    expect(s.actionMemory.some((e) => e.summary === "Bought Dried Herbs from Greta")).toBe(true);
  });
});

// ===========================================================================
// Save/load round-trip — the geared-up MC persisted to JSON and restored.
// Exercises the real StorageModule autosave -> migrate -> replaceState path
// (the same pipeline resumeAutosave/importSave use), including the sanitized
// snapshot stripping the live API key on the way out.
// ===========================================================================

describe("save/load round-trip — the geared-up MC", () => {
  const originalState = StateModule.state;

  beforeEach(() => {
    resetState();
    storageBacking.clear();
  });
  afterEach(() => {
    // The test swaps the live state reference via replaceState — put the
    // module's original object back so later describes stay hermetic.
    StateModule.state = originalState;
    storageBacking.clear();
  });

  /** Runs the geared-up setup turns (sword, Shadowcloak, poison) plus one
   * assertion turn so poison has mechanically ticked to 25/110. */
  async function gearUpMC(): Promise<void> {
    mockGenerateResponse
      .mockResolvedValueOnce(
        'The blade hums to life. [EQUIPMENT]{"itemId": "flying-sword", "name": "Flying Sword of the Azure Wind", "slot": "weapon", "rarity": "legendary", "stats": {"str": 3, "agi": 5}, "desc": "A Tier 3 flying sword that carries the wielder at 500% speed", "equipped": true}[/EQUIPMENT]',
      )
      .mockResolvedValueOnce(
        'The cloak settles over you. [STATE_UPDATE]{"modifiers": {"shadowcloak": "Tier 2 Shadowcloak — invisible to anyone below Tier 2", "invisibility": "vs cultivation below Tier 2", "sneak_difficulty_bonus": "-2 vs same tier"}}[/STATE_UPDATE]',
      )
      .mockResolvedValueOnce(
        'The dagger finds your side. [TIME_STATE]{"id":"poison","name":"Poisoned","target":"mc","severity":30,"durationMinutes":120,"tickIntervalMinutes":10,"severityDeltaPerTick":-5}[/TIME_STATE]',
      )
      .mockResolvedValueOnce('You steady yourself. [STATE_UPDATE]{"time": "Monday, 07:30 AM"}[/STATE_UPDATE]');

    await GameEngine.executeTurn("I draw the flying sword.", false);
    await GameEngine.executeTurn("I don the Shadowcloak.", false);
    await GameEngine.executeTurn("A dagger finds me.", false);
    await GameEngine.executeTurn("I stagger onward.", false);
  }

  it("survives autosave → load → replaceState with gear, modifiers, and ticked poison intact", async () => {
    await gearUpMC();

    // Pre-persist sanity: poison has ticked once (30 -> 25), subskills are
    // gear-boosted (Sneaking 22), and the API key is live in memory.
    expect(StateModule.state.timeStates[0].severity).toBe(25);
    expect(StateModule.state.subskills.sneaking).toBe(22);
    StateModule.state.api.key = "live-secret-key";

    // Persist: the sanitized snapshot must strip the live API key.
    StateModule.state.initialized = true;
    StorageModule.autosave();
    expect(StorageModule.hasAutosave()).toBe(true);

    const loaded = StorageModule.loadAutosave();
    expect(loaded).not.toBeNull();
    expect(loaded!.api.key).toBe("");

    // Reload into the live state — exactly what resumeAutosave does before
    // re-rendering the sidebars.
    StateModule.replaceState(loaded!);

    // --- Equipped gear survives. ---
    expect(StateModule.state.equipped.length).toBe(1);
    expect(StateModule.state.equipped[0].name).toBe("Flying Sword of the Azure Wind");
    expect(StateModule.state.equipped[0].slot).toBe("weapon");
    expect(StateModule.state.equipped[0].stats).toEqual({ str: 3, agi: 5 });

    // --- The Shadowcloak modifiers bag survives verbatim. ---
    expect(StateModule.state.modifiers).toEqual({
      shadowcloak: "Tier 2 Shadowcloak — invisible to anyone below Tier 2",
      invisibility: "vs cultivation below Tier 2",
      sneak_difficulty_bonus: "-2 vs same tier",
    });

    // --- The ticked poison state survives (severity/duration, not re-derived). ---
    expect(StateModule.state.timeStates.length).toBe(1);
    expect(StateModule.state.timeStates[0]).toMatchObject({
      id: "poison",
      name: "Poisoned",
      severity: 25,
      durationMinutes: 110,
      severityDeltaPerTick: -5,
    });

    // --- Gear-boosted subskills were part of the snapshot, not recomputed. ---
    expect(StateModule.state.subskills.sneaking).toBe(22);

    // --- The engine keeps running on the restored state: the next turn's
    // prompt shows the restored gear, modifiers, and (freshly ticked) poison. ---
    mockGenerateResponse.mockResolvedValueOnce(
      'The road continues. [STATE_UPDATE]{"time": "Monday, 07:40 AM"}[/STATE_UPDATE]',
    );
    await GameEngine.executeTurn("I walk on.", false);
    const nextPrompt = mockGenerateResponse.mock.calls[4][0] as string;
    expect(nextPrompt).toContain("Flying Sword of the Azure Wind");
    expect(nextPrompt).toContain("Tier 2 Shadowcloak");
    expect(nextPrompt).toContain("Poisoned on mc: Severity 20");
  });

  it("returns null for a truncated autosave without touching the live state", async () => {
    await gearUpMC();
    const liveRef = StateModule.state;
    expect(StateModule.state.equipped.length).toBe(1);

    // A raw blob IS present (hasAutosave can't tell it's corrupt)...
    storageBacking.set(
      StorageModule.AUTOSAVE_KEY,
      '{"version": 5, "char": {"name": "Flying Sword of the Azure Wind", "str": 13',
    );
    expect(StorageModule.hasAutosave()).toBe(true);

    // ...but loadAutosave refuses it: truncated JSON fails to parse, and
    // loadAutosave catches the error and returns null.
    expect(StorageModule.loadAutosave()).toBeNull();

    // Non-JSON garbage is refused the same way.
    storageBacking.set(StorageModule.AUTOSAVE_KEY, "not json at all {{{[");
    expect(StorageModule.loadAutosave()).toBeNull();

    // The live state is untouched: same object reference, same gear,
    // modifiers, and ticked poison as before the failed loads.
    expect(StateModule.state).toBe(liveRef);
    expect(StateModule.state.equipped.length).toBe(1);
    expect(StateModule.state.equipped[0].name).toBe("Flying Sword of the Azure Wind");
    expect(StateModule.state.modifiers.shadowcloak).toContain("Tier 2 Shadowcloak");
    expect(StateModule.state.timeStates[0].severity).toBe(25);
  });
});

// ===========================================================================
// importSave path — a v4-era save (predating the Phase 5 containers) fed
// through StorageModule.importSave. Exercises the full import flow: the fake
// FileReader delivers the JSON, migrate() upgrades the shape in place, and
// replaceState swaps it into the live engine — while the gear and modifiers
// the save already had pass through untouched.
// ===========================================================================

describe("importSave path — legacy v4 save migration", () => {
  const originalState = StateModule.state;

  beforeEach(() => {
    resetState();
    storageBacking.clear();
    (globalThis as any).FileReader = class {
      result = "";
      onload: ((e: { target?: { result?: string } }) => void) | null = null;
      readAsText(file: { content: string }): void {
        this.result = file.content;
        this.onload?.({ target: { result: this.result } });
      }
    };
  });
  afterEach(() => {
    StateModule.state = originalState;
    storageBacking.clear();
    delete (globalThis as any).FileReader;
  });

  it("upgrades a v4 save missing npcProfiles/timeStates/giftLog while preserving gear and modifiers", () => {
    // A v4-era save: already carries equipped gear + modifiers, but predates
    // the Phase 5 containers and the relation -> NPC-profile conversion.
    const v4Save = {
      version: 4,
      setup: {
        genre: "Xianxia",
        worldSize: "Vast Continent",
        techStage: "Medieval Low-Magic",
        rules: "Cultivation is the path to immortality.",
        measurement: "Metric",
        time: "Monday, 07:00 AM",
        location: "Starting Location",
        mcCultivation: 0,
        statEnd: 0,
        statWil: 0,
        statLck: 0,
        statPer: 0,
        activeGenres: ["xianxia"],
      },
      char: {
        name: "Lin Hao",
        appearance: "Quiet cultivator",
        inventory: [],
        cultivation: 0,
        str: 10, agi: 10, int: 10, cha: 10, end: 10, wil: 10, lck: 10, per: 10,
        health: 100, maxHealth: 100, fatigue: 0,
        xp: 0, level: 1, skillPoints: 0, systemPoints: 0,
        learnedSkills: [], breakthroughs: [],
      },
      toggles: {
        mcInfo: true, statChecks: true, health: true, subskills: true, time: true,
        memory: true, quests: true, equipment: true, economy: true, xp: true, npcDepth: true,
        descriptiveScenes: true, schedules: true,
      },
      subskills: { seduction: 10, sneaking: 15, negotiation: 13, intimidation: 10 },
      modifiers: {
        shadowcloak: "Tier 2 Shadowcloak — invisible to anyone below Tier 2",
        invisibility: "vs cultivation below Tier 2",
        sneak_difficulty_bonus: "-2 vs same tier",
      },
      equipped: [
        {
          itemId: "flying-sword",
          name: "Flying Sword of the Azure Wind",
          slot: "weapon",
          rarity: "legendary",
          stats: { str: 3, agi: 5 },
          desc: "A Tier 3 flying sword that carries the wielder at 500% speed",
          equipped: true,
        },
      ],
      worldState: { time: "Monday, 07:00 AM", location: "Starting Location", measurement: "Metric" },
      memory: {
        facts: [],
        relations: [
          { name: "Mara", aliases: ["Oakhaven Herbalist"], disposition: "Friendly merchant", status: "Alive", modifiers: [] },
        ],
      },
      // Phase 5 containers deliberately absent: npcProfiles, timeStates, giftLog.
      quests: [],
      currencies: [],
      transactionLog: [],
      history: [],
      turnCount: 4,
      api: { provider: "gemini", key: "", url: "http://localhost:11434/api/generate", model: "gemini-2.5-flash-preview-09-2025" },
    };

    StorageModule.importSave({
      target: { files: [{ content: JSON.stringify(v4Save) }] },
    } as any);

    const s = StateModule.state;

    // Upgraded to the current schema version.
    expect(s.version).toBe(SCHEMA_VERSION);

    // The Phase 5 containers a v4 save never had are backfilled.
    expect(s.timeStates).toEqual([]);
    expect(s.giftLog).toEqual([]);
    expect(Array.isArray(s.npcProfiles)).toBe(true);
    // ...and the v4 -> v5 patch converted the existing relation into an
    // auto-generated NPC profile instead of dropping it.
    expect(s.npcProfiles.length).toBe(1);
    expect(s.npcProfiles[0].npcName).toBe("Mara");

    // Equipped gear survives the migration untouched.
    expect(s.equipped.length).toBe(1);
    expect(s.equipped[0].name).toBe("Flying Sword of the Azure Wind");
    expect(s.equipped[0].slot).toBe("weapon");
    expect(s.equipped[0].stats).toEqual({ str: 3, agi: 5 });

    // The Shadowcloak modifiers bag survives verbatim.
    expect(s.modifiers).toEqual({
      shadowcloak: "Tier 2 Shadowcloak — invisible to anyone below Tier 2",
      invisibility: "vs cultivation below Tier 2",
      sneak_difficulty_bonus: "-2 vs same tier",
    });

    // The imported save is live: the engine's prompt immediately reflects the
    // migrated world (gear, modifiers, and the converted Mara profile).
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Flying Sword of the Azure Wind");
    expect(prompt).toContain("Tier 2 Shadowcloak");
    expect(prompt).toContain("Mara");
  });
});

// ===========================================================================
// Season pipeline — month-advancing clock triggers [FACT] season entries.
// The engine derives the current season from worldState.time and carries it in
// the per-turn payload (CURRENT SEASON); the system prompt teaches the AI to
// replace the Season memory fact when the calendar crosses into a new season.
// ===========================================================================

describe("Season pipeline — month-advancing clock triggers [FACT] season entries", () => {
  beforeEach(resetState);

  it("derives the season into the payload and records a season-change FACT into memory and the next prompt", async () => {
    // The world starts in spring (default: Monday, March 17, 07:00). The
    // system prompt carries the season rule for the AI.
    mockGenerateResponse.mockResolvedValueOnce(
      'Spring rains ease. [STATE_UPDATE]{"time": "Saturday, May 31, 07:00"}[/STATE_UPDATE]',
    );
    await GameEngine.executeTurn("I travel toward the mountains.", false);

    // The system prompt teaches the replacement rule; the per-turn payload
    // derives and shows the season from the clock.
    const turn1Prompt = mockGenerateResponse.mock.calls[0][0] as string;
    const turn1Payload = mockGenerateResponse.mock.calls[0][1] as string;
    expect(turn1Prompt).toContain(
      "the calendar crosses into a new season (Mar-May Spring, Jun-Aug Summer, Sep-Nov Autumn, Dec-Feb Winter)",
    );
    expect(turn1Payload).toContain("CURRENT TIME: Monday, March 17, 07:00");
    expect(turn1Payload).toContain("CURRENT SEASON: Spring");
    expect(StateModule.state.worldState.time).toBe("Saturday, May 31, 07:00");

    // The month advances into a new season. The AI was still prompted in
    // spring (May 31); the clock crossing into June is what triggers it to
    // record the change as a Season fact.
    mockGenerateResponse.mockResolvedValueOnce(
      "The air turns warm. [FACT]Season: Summer has arrived — long warm days and the academy's summer break begins.[/FACT] [STATE_UPDATE]{\"time\": \"Sunday, June 1, 07:00\"}[/STATE_UPDATE]",
    );
    await GameEngine.executeTurn("Summer arrives.", false);

    const turn2Payload = mockGenerateResponse.mock.calls[1][1] as string;
    expect(turn2Payload).toContain("CURRENT SEASON: Spring");

    const seasonBundles = StateModule.state.memory.facts.filter((b) => b.title === "Season");
    expect(seasonBundles.length).toBe(1);
    expect(seasonBundles[0].entries).toEqual([
      "Summer has arrived — long warm days and the academy's summer break begins.",
    ]);
    expect(StateModule.state.worldState.time).toBe("Sunday, June 1, 07:00");

    // Next turn: the payload shows Summer and the Season fact is in the
    // prompt's ESTABLISHED FACTS (always visible via the "season" keyword).
    mockGenerateResponse.mockResolvedValue("The fields ripen.");
    await GameEngine.executeTurn("I watch the season turn.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    const turn3Payload = mockGenerateResponse.mock.calls[2][1] as string;
    expect(turn3Payload).toContain("CURRENT SEASON: Summer");
    expect(turn3Prompt).toContain("Summer has arrived");
  });

  it("replaces the previous season fact instead of stacking entries", async () => {
    // Spring -> summer: a Season fact is recorded (merges into the bundle).
    mockGenerateResponse.mockResolvedValueOnce(
      '[FACT]Season: Summer has arrived.[/FACT] [STATE_UPDATE]{"time": "Sunday, June 1, 07:00"}[/STATE_UPDATE]',
    );
    await GameEngine.executeTurn("Summer comes.", false);
    expect(StateModule.state.memory.facts.filter((b) => b.title === "Season")[0].entries).toEqual([
      "Summer has arrived.",
    ]);

    // Summer -> autumn: the AI resets the Season group before re-recording,
    // so only the new season's entry remains.
    mockGenerateResponse.mockResolvedValueOnce(
      '[FACT_RESET]Season[/FACT_RESET][FACT]Season: Autumn has arrived — leaves fall and the harvest begins.[/FACT] [STATE_UPDATE]{"time": "Monday, September 22, 07:00"}[/STATE_UPDATE]',
    );
    await GameEngine.executeTurn("The leaves turn.", false);

    const bundles = StateModule.state.memory.facts.filter((b) => b.title === "Season");
    expect(bundles.length).toBe(1);
    expect(bundles[0].entries).toEqual(["Autumn has arrived — leaves fall and the harvest begins."]);

    // The next turn carries the current season (payload) and the replaced
    // fact only (system prompt's ESTABLISHED FACTS).
    mockGenerateResponse.mockResolvedValue("The harvest comes in.");
    await GameEngine.executeTurn("I help with the harvest.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    const turn3Payload = mockGenerateResponse.mock.calls[2][1] as string;
    expect(turn3Payload).toContain("CURRENT SEASON: Autumn");
    // The prompt's own spec example mentions summer, so assert on the rendered
    // fact-entry forms ("  - <entry>") that only ESTABLISHED FACTS produces.
    expect(turn3Prompt).toContain("- Autumn has arrived — leaves fall and the harvest begins.");
    expect(turn3Prompt).not.toContain("- Summer has arrived.");
  });
});

// ===========================================================================
// Think-block stripping — local reasoning models (Qwen3, DeepSeek R1, ...)
// emit <think>...</think> internal monologues that frequently contain
// malformed [STATE_UPDATE] drafts. The engine strips them before the tag
// parsers, chat log, history, and structured-fallback heuristics ever see
// them.
// ===========================================================================

describe("think-block stripping — reasoning stays out of the pipeline", () => {
  beforeEach(resetState);

  it("applies the real tags while keeping the think-block draft out of state, history, and the next prompt", async () => {
    mockGenerateResponse.mockResolvedValueOnce(
      'The morning mist parts. <think>The user wants me to advance time. Draft: [STATE_UPDATE]{"time": "Monday, March 17, 23:00", "str": 99}[/STATE_UPDATE] which is wrong.</think> The training grounds come alive. [STATE_UPDATE]{"time": "Monday, March 17, 07:30"}[/STATE_UPDATE][FACT]Academy: Morning drills start at 08:00.[/FACT]',
    );
    await GameEngine.executeTurn("I head to the training grounds.", false);

    // The real tags applied; the think-block draft never touched state.
    expect(StateModule.state.worldState.time).toBe("Monday, March 17, 07:30");
    expect(StateModule.state.char.str).toBe(10);
    expect(StateModule.state.memory.facts.some((b) => b.title === "Academy")).toBe(true);

    // History stores the think-stripped response: the engine tags survive for
    // format anchoring, the reasoning text does not.
    const lastAssistant = [...StateModule.state.history].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).not.toContain("<think>");
    expect(lastAssistant?.content).not.toContain("Draft:");
    expect(lastAssistant?.content).toContain("[STATE_UPDATE]");

    // Next turn's prompt carries neither the reasoning nor the draft.
    mockGenerateResponse.mockResolvedValue("I rest.");
    await GameEngine.executeTurn("I rest.", false);
    const turn2Prompt = mockGenerateResponse.mock.calls[1][0] as string;
    expect(turn2Prompt).not.toContain("<think>");
    expect(turn2Prompt).not.toContain('"str": 99');
  });

  it("also strips the coherence-retry response before it reaches history", async () => {
    mockGenerateResponse.mockResolvedValueOnce(
      'The gate creaks. <thinking>Plan the duel.</thinking> [STATE_UPDATE]{"location": "Training Arena"}[/STATE_UPDATE]',
    );
    await GameEngine.executeTurn("I enter the arena.", false);

    expect(StateModule.state.worldState.location).toBe("Training Arena");
    const lastAssistant = [...StateModule.state.history].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).not.toContain("<thinking>");
    expect(lastAssistant?.content).toContain("[STATE_UPDATE]");
  });
});

// ===========================================================================
// Coherence retry — pre-think analysis ramble ("The user wants to... I need
// to:...") triggers the one-shot simple-prompt retry so the ramble never
// reaches the player, history, or the next turn's model context.
// ===========================================================================

describe("coherence retry — pre-think analysis ramble", () => {
  beforeEach(resetState);

  it("discards the ramble and surfaces only the retried narrative", async () => {
    const ramble =
      "The user wants to wake up in their dormitory at Azure Cloud Academy.I need to:- Set the time to Monday, March 17, 07:00.- Describe waking up, stretching, getting dressed.- Look out the window at the morning mist over the mountains.- Provide the scene richly. I will then append the required blocks carefully so the engine parses them correctly. ".repeat(12);
    mockGenerateResponse
      .mockResolvedValueOnce(ramble)
      .mockResolvedValue("The morning mist parts over the training grounds. What would you like to do next?");
    await GameEngine.executeTurn("I wake up.", false);

    // The ramble triggered the coherence retry: exactly two API calls.
    expect(mockGenerateResponse).toHaveBeenCalledTimes(2);
    // The retry used the minimal narrator prompt, not the full engine spec.
    const retrySys = mockGenerateResponse.mock.calls[1][0] as string;
    expect(retrySys).toContain("Do NOT analyze, plan, reason");

    // History holds only the retried narrative — the ramble never surfaced.
    const lastAssistant = [...StateModule.state.history].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toBe(
      "The morning mist parts over the training grounds. What would you like to do next?",
    );
    expect(lastAssistant?.content).not.toContain("The user wants to");
  });

  it("catches the untagged 'Thinking Process:' preamble seen live from local models", async () => {
    // This is the EXACT shape a live 27B Qwen3.6 model produced against the
    // real engine: a long untagged reasoning block before any story prose.
    const ramble =
      "Thinking Process:\n\n" +
      "1.  **Analyze the Request:**\n" +
      "    *   Role: Immersive interactive novel narrator.\n" +
      "    *   Style: Flowing, vivid prose. No meta-talk, analysis, or game mechanics.\n" +
      "    *   Length constraint: Under 400 words.\n" +
      "    *   Ending requirement: Ask the player what they do next.\n" +
      "    *   Genre: Xianxia.\n" +
      "    *   World: Vast Continent.\n" +
      "2.  **Plan the Scene:** open with the village, set the winter mood, reveal the pendant.\n" +
      "3.  **Draft.**\n\n".repeat(9);
    mockGenerateResponse
      .mockResolvedValueOnce(ramble)
      .mockResolvedValue("The stream shivers under the grey dawn. What do you do?");
    await GameEngine.executeTurn("I wake up.", false);

    // The untagged preamble triggered the coherence retry.
    expect(mockGenerateResponse).toHaveBeenCalledTimes(2);
    const lastAssistant = [...StateModule.state.history].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toBe("The stream shivers under the grey dawn. What do you do?");
    expect(lastAssistant?.content).not.toContain("Thinking Process");
  });

  it("shows the ramble-retry status in the loading pill, then restores the writing message", async () => {
    // Record every text the loading pill's span receives.
    const messages: string[] = [];
    const span = {} as { textContent: string };
    Object.defineProperty(span, "textContent", {
      get: () => messages[messages.length - 1] ?? "",
      set: (v: string) => {
        messages.push(String(v));
      },
    });
    testElements.set("loading-indicator", {
      innerHTML: "",
      innerText: "",
      textContent: "",
      title: "",
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      querySelector: (sel: string) => (sel === "span" ? span : null),
    } as unknown as TestElement);
    try {
      const ramble =
        "The user wants to wake up. I need to: - set the time - describe the scene. I will then append the required blocks so the engine parses them correctly. ".repeat(15);
      mockGenerateResponse
        .mockResolvedValueOnce(ramble)
        .mockResolvedValue("The gate creaks open. What do you do?");
      await GameEngine.executeTurn("I approach the gate.", false);

      expect(mockGenerateResponse).toHaveBeenCalledTimes(2);
      // The retry notice was shown while the second call ran, then the pill
      // went back to the ordinary writing message.
      expect(messages).toContain("The model rambled — retrying with a simpler prompt…");
      expect(messages[messages.length - 1]).toBe("AI is writing...");
    } finally {
      testElements.delete("loading-indicator");
    }
  });

  it("skips the retry entirely when retryOnRambling is disabled — no extra API call", async () => {
    StateModule.state.api.retryOnRambling = false;
    try {
      const ramble =
        "The user wants to wake up. I need to: - set the time - describe the scene. I will then append the required blocks so the engine parses them correctly. ".repeat(15);
      mockGenerateResponse.mockResolvedValue(ramble);
      await GameEngine.executeTurn("I wake up.", false);

      // No retry: exactly one API call, and the ramble stays in history as-is.
      expect(mockGenerateResponse).toHaveBeenCalledTimes(1);
      const lastAssistant = [...StateModule.state.history].reverse().find((m) => m.role === "assistant");
      expect(lastAssistant?.content).toContain("The user wants to");
    } finally {
      StateModule.state.api.retryOnRambling = undefined; // restore the default
    }
  });
});

// ===========================================================================
// Family anchoring — backstory family members (mother, sister, ...) were
// never registered as relationships ([RELATION] only fires when the MC MEETS
// someone), so the AI "forgot" the household after a few unrelated turns.
// seedFamilyRelations() registers them mechanically at init/resume; these
// tests prove they persist in ESTABLISHED RELATIONSHIPS turn after turn.
// ===========================================================================

describe("Family anchoring pipeline — backstory family stays registered", () => {
  beforeEach(resetState);

  it("keeps the seeded family in every subsequent prompt even when no turn mentions them", async () => {
    StateModule.state.char.appearance =
      "Lin Hao lives in a cramped apartment with his mother, who works double shifts at the diner, and his younger sister.";
    const added = seedFamilyRelations(StateModule.state.char.appearance);
    expect(added).toBe(2);
    expect(StateModule.state.npcProfiles.map((p) => p.npcName).sort()).toEqual([
      "Mother",
      "Younger Sister",
    ]);

    // Two turns about the system interface and training — nothing family-related.
    mockGenerateResponse.mockResolvedValueOnce(
      'You dive into the system menus. [STATE_UPDATE]{"time":"Monday, March 17, 08:00"}[/STATE_UPDATE]',
    );
    mockGenerateResponse.mockResolvedValueOnce(
      'Morning training passes. [STATE_UPDATE]{"time":"Monday, March 17, 09:00"}[/STATE_UPDATE]',
    );
    await GameEngine.executeTurn("I explore the system interface.", false);
    await GameEngine.executeTurn("I train in the yard.", false);

    // Turn 3 (school) still carries the household in ESTABLISHED RELATIONSHIPS
    // AND the dedicated FAMILY block inside MAIN CHARACTER.
    mockGenerateResponse.mockResolvedValue("School begins.");
    await GameEngine.executeTurn("I go to school.", false);
    const turn3Prompt = mockGenerateResponse.mock.calls[2][0] as string;
    expect(turn3Prompt).toContain("- Mother: MC's mother.");
    expect(turn3Prompt).toContain("- Younger Sister: MC's younger sister.");
    expect(turn3Prompt).toContain("FAMILY (the MC's household");
  });

  it("renders the seeded family in the very first turn's prompt", async () => {
    StateModule.state.char.appearance = "He shares a home with his mother and his younger sister.";
    seedFamilyRelations(StateModule.state.char.appearance);
    mockGenerateResponse.mockResolvedValue("Morning begins.");
    await GameEngine.executeTurn("I wake up.", false);
    const prompt = mockGenerateResponse.mock.calls[0][0] as string;
    expect(prompt).toContain("- Mother: MC's mother.");
    expect(prompt).toContain("- Younger Sister: MC's younger sister.");
    // The FAMILY block lives inside MAIN CHARACTER, right after the backstory.
    const mcIndex = prompt.indexOf("=== MAIN CHARACTER ===");
    const familyIndex = prompt.indexOf("FAMILY (the MC's household");
    expect(mcIndex).toBeGreaterThan(-1);
    expect(familyIndex).toBeGreaterThan(mcIndex);
  });

  it("uses a captured name as the relation with the role as disposition", async () => {
    StateModule.state.char.appearance =
      "Lin Hao lives with his mother Diane and his younger sister Lily.";
    seedFamilyRelations(StateModule.state.char.appearance);
    mockGenerateResponse.mockResolvedValue("Morning begins.");
    await GameEngine.executeTurn("I wake up.", false);
    const prompt = mockGenerateResponse.mock.calls[0][0] as string;
    expect(prompt).toContain("- Diane: MC's mother.");
    expect(prompt).toContain("- Lily: MC's younger sister.");
    // The role titles and casual synonyms are preserved as aliases so the AI
    // can still call them Mother/Mom or Lily's sister without losing the mapping.
    expect(StateModule.state.memory.relations.find((r) => r.name === "Diane")?.aliases).toEqual([
      "Mother",
      "Mom",
      "Mum",
      "Mama",
    ]);
  });

  it("merges a mid-game name discovery into the role-titled entry instead of duplicating", async () => {
    StateModule.state.char.appearance = "Lin Hao lives with his widowed mother.";
    seedFamilyRelations(StateModule.state.char.appearance);
    // The mother was seeded under her role title — the backstory has no name.
    expect(StateModule.state.memory.relations.map((r) => r.name).sort()).toEqual([
      "Father",
      "Mother",
    ]);

    // The AI discovers her name — [RELATION] names Diane and lists Mother as
    // the alias. The engine must resolve the alias to the existing entry and
    // RENAME it, not create a second NPC.
    mockGenerateResponse.mockResolvedValueOnce(
      '[RELATION]{"name":"Diane","aliases":["Mother"],"disposition":"Diner waitress, works double shifts"}[/RELATION] The waitress introduces herself as Diane.',
    );
    await GameEngine.executeTurn("I ask her name.", false);

    expect(StateModule.state.memory.relations).toHaveLength(2); // no duplicate
    expect(StateModule.state.memory.relations.some((r) => r.name === "Mother")).toBe(false);
    const diane = StateModule.state.memory.relations.find((r) => r.name === "Diane");
    expect(diane?.aliases).toEqual(["Mom", "Mum", "Mama", "Mother"]);
    expect(diane?.disposition).toBe("Diner waitress, works double shifts");
    // The NPC profile followed the rename so she stays in the living view.
    expect(StateModule.state.npcProfiles.map((p) => p.npcName)).toContain("Diane");

    // Next turn's prompt lists her exactly ONCE, under her name, with the
    // merged disposition (the FAMILY block repeats the line, so the count is
    // scoped to the alive-relationships section).
    mockGenerateResponse.mockResolvedValue("Morning passes.");
    await GameEngine.executeTurn("I rest.", false);
    const prompt = mockGenerateResponse.mock.calls[1][0] as string;
    const relStart = prompt.indexOf("ESTABLISHED RELATIONSHIPS:");
    const relEnd = prompt.indexOf("=== NPC PROFILES");
    const relBlock = prompt.slice(relStart, relEnd > -1 ? relEnd : relStart + 3000);
    expect(relBlock.match(/- Diane:/g) ?? []).toHaveLength(1);
    expect(relBlock).toContain("- Diane: Diner waitress, works double shifts.");
  });

  it("records the deceased father's passing as a Family fact that stays in context every turn", async () => {
    StateModule.state.char.appearance =
      "Lin Hao lives with his widowed mother and his younger sister.";
    seedFamilyRelations(StateModule.state.char.appearance);
    const familyBundle = StateModule.state.memory.facts.find((b) => b.title === "Family");
    expect(familyBundle?.entries).toContain("Father passed away years ago.");

    // Several unrelated turns — the narrative context must survive each one.
    mockGenerateResponse.mockResolvedValueOnce(
      'You check the system menus. [STATE_UPDATE]{"time":"Monday, March 17, 08:00"}[/STATE_UPDATE]',
    );
    mockGenerateResponse.mockResolvedValueOnce(
      'You train in the yard. [STATE_UPDATE]{"time":"Monday, March 17, 09:00"}[/STATE_UPDATE]',
    );
    mockGenerateResponse.mockResolvedValue("You head to school.");
    await GameEngine.executeTurn("I check the menus.", false);
    await GameEngine.executeTurn("I train.", false);
    await GameEngine.executeTurn("I go to school.", false);

    for (let i = 0; i < 3; i++) {
      const prompt = mockGenerateResponse.mock.calls[i][0] as string;
      // The ESTABLISHED FACTS section carries the Family bundle every turn.
      const factsStart = prompt.indexOf("ESTABLISHED FACTS");
      const factsEnd = prompt.indexOf("ESTABLISHED RELATIONSHIPS");
      const factsBlock = prompt.slice(factsStart, factsEnd > -1 ? factsEnd : factsStart + 3000);
      expect(factsBlock, `turn ${i + 1}`).toContain("Group: [Family]");
      expect(factsBlock, `turn ${i + 1}`).toContain("- Father passed away years ago.");
    }
  });

  it("resolves AI [RELATION] updates by name OR alias and merges into the single family entry", async () => {
    StateModule.state.char.appearance =
      "Lin Hao lives with his mother Diane and his younger sister Lily.";
    seedFamilyRelations(StateModule.state.char.appearance);
    expect(StateModule.state.memory.relations).toHaveLength(2);

    // Turn 1: the AI refers to the mother by her NAME — the disposition
    // update merges into the existing entry, no duplicate is created.
    mockGenerateResponse.mockResolvedValueOnce(
      '[RELATION]{"name":"Diane","disposition":"Diner waitress, works double shifts"}[/RELATION] You find her at the kitchen table.',
    );
    await GameEngine.executeTurn("I talk to my mother.", false);
    expect(StateModule.state.memory.relations).toHaveLength(2);
    expect(
      StateModule.state.memory.relations.find((r) => r.name === "Diane")?.disposition,
    ).toBe("Diner waitress, works double shifts");

    // Turn 2: the AI refers to her by her ALIAS "Mother" — the engine must
    // resolve the alias back to Diane and merge, NOT create a second entry.
    mockGenerateResponse.mockResolvedValueOnce(
      '[RELATION]{"name":"Mother","disposition":"Exhausted from the late shift"}[/RELATION] She rubs her eyes.',
    );
    await GameEngine.executeTurn("She looks tired.", false);
    expect(StateModule.state.memory.relations).toHaveLength(2);
    expect(StateModule.state.memory.relations.some((r) => r.name === "Mother")).toBe(false);
    const merged = StateModule.state.memory.relations.find((r) => r.name === "Diane");
    expect(merged?.disposition).toBe("Exhausted from the late shift");
    expect(merged?.aliases).toEqual(["Mother", "Mom", "Mum", "Mama"]);

    // Turn 3: the next prompt lists her exactly ONCE, under her name, in the
    // alive-relationships block (the FAMILY block legitimately repeats the
    // line, so the count is scoped to the ESTABLISHED RELATIONSHIPS section).
    mockGenerateResponse.mockResolvedValue("Morning passes.");
    await GameEngine.executeTurn("I rest.", false);
    const prompt = mockGenerateResponse.mock.calls[2][0] as string;
    const relStart = prompt.indexOf("ESTABLISHED RELATIONSHIPS:");
    const relEnd = prompt.indexOf("=== NPC PROFILES");
    const relBlock = prompt.slice(relStart, relEnd > -1 ? relEnd : relStart + 3000);
    const dianeEntries = relBlock.match(/- Diane:/g) ?? [];
    expect(dianeEntries).toHaveLength(1);
    expect(relBlock).toContain("- Diane: Exhausted from the late shift.");
    // The sister was never touched by either update.
    expect(relBlock).toContain("- Lily: MC's younger sister.");
  });

  it("promotes an alias to the primary name on an AI [RELATION] update and renames the NPC profile", async () => {
    // Named seeding: the mother is "Diane", role alias "Mother".
    StateModule.state.char.appearance =
      "Lin Hao lives with his mother Diane and his younger sister Lily.";
    seedFamilyRelations(StateModule.state.char.appearance);
    expect(StateModule.state.memory.relations).toHaveLength(2);

    // Turn 1: the AI promotes the alias — names her "Mother" and lists
    // "Diane" as the alias. The engine must rename the entry + profile in
    // place instead of creating a duplicate or clobbering the alias.
    mockGenerateResponse.mockResolvedValueOnce(
      '[RELATION]{"name":"Mother","aliases":["Diane"],"disposition":"Exhausted from the late shift"}[/RELATION] Everyone calls her Mother now.',
    );
    await GameEngine.executeTurn("I call for my mother.", false);
    expect(StateModule.state.memory.relations).toHaveLength(2);
    expect(StateModule.state.memory.relations.some((r) => r.name === "Diane")).toBe(false);
    const mother = StateModule.state.memory.relations.find((r) => r.name === "Mother");
    expect(mother?.disposition).toBe("Exhausted from the late shift");
    // The old primary survives as an alias, the casual synonyms survive, and
    // no self-alias ("aka Mother" next to Mother) remains.
    expect(mother?.aliases).toEqual(["Mom", "Mum", "Mama", "Diane"]);
    // The NPC profile follows the promoted name.
    const profileNames = StateModule.state.npcProfiles.map((p) => p.npcName);
    expect(profileNames).toContain("Mother");
    expect(profileNames).not.toContain("Diane");

    // Turn 2: the next prompt lists her exactly ONCE under her promoted name
    // in the alive-relationships block (the FAMILY block legitimately repeats
    // the line, so the count is scoped to the ESTABLISHED RELATIONSHIPS
    // section), and the profile card carries the new name.
    mockGenerateResponse.mockResolvedValue("Morning passes.");
    await GameEngine.executeTurn("I rest.", false);
    const prompt = mockGenerateResponse.mock.calls[1][0] as string;
    const relStart = prompt.indexOf("ESTABLISHED RELATIONSHIPS:");
    const relEnd = prompt.indexOf("=== NPC PROFILES");
    const relBlock = prompt.slice(relStart, relEnd > -1 ? relEnd : relStart + 3000);
    const motherEntries = relBlock.match(/- Mother:/g) ?? [];
    expect(motherEntries).toHaveLength(1);
    expect(relBlock).toContain("- Mother: Exhausted from the late shift.");
    const npcIdx = prompt.indexOf("=== NPC PROFILES");
    const npcBlock = prompt.slice(npcIdx, npcIdx + 1500);
    expect(npcBlock).toContain("Mother");
    expect(npcBlock).not.toContain("Diane");
    // The sister was never touched.
    expect(relBlock).toContain("- Lily: MC's younger sister.");
  });

  it("merges casual-synonym AI updates (Mom, Dad, Grandma) onto the seeded family entries", async () => {
    StateModule.state.char.appearance =
      "Lin Hao lives with his mother Diane, his grandmother and his younger sister Lily.";
    seedFamilyRelations(StateModule.state.char.appearance);
    expect(StateModule.state.memory.relations).toHaveLength(3);
    // The casual synonyms are seeded alongside the role titles.
    expect(
      StateModule.state.memory.relations.find((r) => r.name === "Grandmother")?.aliases,
    ).toEqual(["Grandma", "Granny", "Nana"]);

    // Turn 1: the AI casually calls the mother "Mom" — the engine must merge
    // onto the existing Diane entry, NOT create a second "Mom" NPC.
    mockGenerateResponse.mockResolvedValueOnce(
      '[RELATION]{"name":"Mom","disposition":"Exhausted from the late shift"}[/RELATION] Mom rubs her tired eyes.',
    );
    await GameEngine.executeTurn("I talk to my mom.", false);
    expect(StateModule.state.memory.relations).toHaveLength(3); // no duplicate
    expect(StateModule.state.memory.relations.some((r) => r.name === "Mom")).toBe(false);
    const diane = StateModule.state.memory.relations.find((r) => r.name === "Diane");
    expect(diane?.disposition).toBe("Exhausted from the late shift");

    // Turn 2: "Grandma" resolves to the seeded grandmother the same way.
    mockGenerateResponse.mockResolvedValueOnce(
      '[RELATION]{"name":"Grandma","disposition":"Knitting by the fire"}[/RELATION] Grandma waves from her chair.',
    );
    await GameEngine.executeTurn("I visit my grandma.", false);
    expect(StateModule.state.memory.relations).toHaveLength(3);
    expect(StateModule.state.memory.relations.some((r) => r.name === "Grandma")).toBe(false);
    expect(
      StateModule.state.memory.relations.find((r) => r.name === "Grandmother")?.disposition,
    ).toBe("Knitting by the fire");

    // Turn 3: the next prompt lists each family member exactly ONCE under
    // their canonical name with the merged dispositions (scoped to the
    // alive-relationships block; the FAMILY block legitimately repeats them).
    mockGenerateResponse.mockResolvedValue("Morning passes.");
    await GameEngine.executeTurn("I rest.", false);
    const prompt = mockGenerateResponse.mock.calls[2][0] as string;
    const relStart = prompt.indexOf("ESTABLISHED RELATIONSHIPS:");
    const relEnd = prompt.indexOf("=== NPC PROFILES");
    const relBlock = prompt.slice(relStart, relEnd > -1 ? relEnd : relStart + 3000);
    expect(relBlock.match(/- Diane:/g) ?? []).toHaveLength(1);
    expect(relBlock).toContain("- Diane: Exhausted from the late shift.");
    expect(relBlock.match(/- Grandmother:/g) ?? []).toHaveLength(1);
    expect(relBlock).toContain("- Grandmother: Knitting by the fire.");
    // No "Mom"/"Grandma" entries ever appear in the prompt.
    expect(relBlock).not.toContain("Mom");
    expect(relBlock).not.toContain("Grandma");
    expect(relBlock).toContain("- Lily: MC's younger sister.");
  });

  it("links [FACT] entries mentioning casual family synonyms to the canonical relation", async () => {
    StateModule.state.char.appearance =
      "Lin Hao lives with his mother Diane and his younger sister Lily.";
    seedFamilyRelations(StateModule.state.char.appearance);

    // The AI records a household fact in casual terms — "Mom" must resolve
    // to the canonical relation "Diane" when the fact is stored.
    mockGenerateResponse.mockResolvedValueOnce(
      '[FACT]Mom came home late from the diner[/FACT] She looks exhausted.',
    );
    await GameEngine.executeTurn("I wait by the door.", false);
    const general = StateModule.state.memory.facts.find(
      (b) => b.title === "General World Facts",
    );
    expect(general?.entries).toContain("Diane came home late from the diner");
    expect(general?.entries.some((e) => e.includes("Mom"))).toBe(false);

    // A later turn states the same fact under the canonical name — the two
    // phrasings must collapse into ONE stored entry (no duplication).
    mockGenerateResponse.mockResolvedValueOnce(
      '[FACT]Diane came home late from the diner[/FACT] She rubs her eyes.',
    );
    await GameEngine.executeTurn("She tells me about her day.", false);
    expect(
      general!.entries.filter((e) => e.includes("came home late")),
    ).toHaveLength(1);

    // The next turn's prompt carries the fact under the canonical name.
    mockGenerateResponse.mockResolvedValue("Morning passes.");
    await GameEngine.executeTurn("I rest.", false);
    const prompt = mockGenerateResponse.mock.calls[2][0] as string;
    const factsStart = prompt.indexOf("ESTABLISHED FACTS");
    const factsEnd = prompt.indexOf("ESTABLISHED RELATIONSHIPS:");
    const factsBlock = prompt.slice(factsStart, factsEnd > -1 ? factsEnd : factsStart + 3000);
    expect(factsBlock).toContain("- Diane came home late from the diner");
    expect(factsBlock).not.toContain("Mom");
  });

  it("never references the deceased father as alive — the dead-not-revive instruction sits next to his name in every prompt", async () => {
    StateModule.state.char.appearance =
      "Lin Hao lives with his widowed mother and his younger sister.";
    seedFamilyRelations(StateModule.state.char.appearance);
    expect(StateModule.state.memory.relations.find((r) => r.name === "Father")?.status).toBe(
      "Deceased",
    );

    // Several unrelated turns pass — the father must stay dead in every one.
    mockGenerateResponse.mockResolvedValueOnce(
      'You check the system menus. [STATE_UPDATE]{"time":"Monday, March 17, 08:00"}[/STATE_UPDATE]',
    );
    mockGenerateResponse.mockResolvedValueOnce(
      'You train in the yard. [STATE_UPDATE]{"time":"Monday, March 17, 09:00"}[/STATE_UPDATE]',
    );
    mockGenerateResponse.mockResolvedValue("You head to school.");
    await GameEngine.executeTurn("I check the menus.", false);
    await GameEngine.executeTurn("I train.", false);
    await GameEngine.executeTurn("I go to school.", false);

    for (let i = 0; i < 3; i++) {
      const prompt = mockGenerateResponse.mock.calls[i][0] as string;
      const label = `turn ${i + 1}`;

      // Bound the ESTABLISHED RELATIONSHIPS block so the assertions are local
      // to the alive/deceased lists (the FAMILY block legitimately shows him
      // with a (deceased) marker).
      const relStart = prompt.indexOf("ESTABLISHED RELATIONSHIPS:");
      const relEnd = prompt.indexOf("=== NPC PROFILES");
      const relBlock = prompt.slice(relStart, relEnd > -1 ? relEnd : relStart + 3000);

      // The dead-not-revive instruction and his entry share the same block.
      const deceasedBlock = relBlock.slice(relBlock.indexOf("DECEASED CHARACTERS"));
      expect(deceasedBlock, label).toContain(
        "They are dead. Do NOT revive them or reference them as alive!",
      );
      expect(deceasedBlock, label).toContain(
        "- Father: Dead. Previous background: MC's father (deceased)",
      );

      // He is never presented among the alive characters.
      const aliveBlock = relBlock.slice(
        relBlock.indexOf("ACTIVE ALIVE CHARACTERS"),
        relBlock.indexOf("DECEASED CHARACTERS"),
      );
      expect(aliveBlock, label).not.toContain("Father");

      // And he never appears in the living NPC PROFILES section either.
      const npcIdx = prompt.indexOf("=== NPC PROFILES");
      if (npcIdx > -1) {
        const nextSection = prompt.indexOf("\n===", npcIdx + 3);
        const npcBlock = prompt.slice(
          npcIdx,
          nextSection > -1 ? nextSection : prompt.length,
        );
        expect(npcBlock, label).not.toContain("Father");
      }
    }
  });

  it("acknowledges the deceased father when the mother is widowed", async () => {
    StateModule.state.char.appearance =
      "Lin Hao lives with his widowed mother and his younger sister.";
    seedFamilyRelations(StateModule.state.char.appearance);
    mockGenerateResponse.mockResolvedValue("Morning begins.");
    await GameEngine.executeTurn("I wake up.", false);
    const prompt = mockGenerateResponse.mock.calls[0][0] as string;
    expect(prompt).toContain("- Father: MC's father (deceased).");
    expect(prompt).toContain("- Mother: MC's mother.");
    // The deceased father also lands in the DECEASED CHARACTERS section.
    expect(prompt).toContain("Father: Dead.");
  });

  it("marks deceased family members in the FAMILY block", async () => {
    StateModule.state.char.appearance =
      "His mother died when he was young, so his father raised him alone.";
    seedFamilyRelations(StateModule.state.char.appearance);
    mockGenerateResponse.mockResolvedValue("Morning begins.");
    await GameEngine.executeTurn("I wake up.", false);
    const prompt = mockGenerateResponse.mock.calls[0][0] as string;
    expect(prompt).toContain("- Mother: MC's mother (deceased).");
    expect(prompt).toContain("- Father: MC's father.");
  });
});

// ===========================================================================
// Director-note registration — notes phrased as instructions ("Add librarian
// Elle to relationship and NPC list") were previously ignored because the
// note system told the AI to treat notes as in-world facts, never as
// meta-instructions. The engine now detects the directive and registers the
// person mechanically through the same relation pipeline the AI uses.
// ===========================================================================

describe("Director-note registration — 'Add X to relationships' notes are honored", () => {
  beforeEach(resetState);

  it("mechanically registers an NPC named in an add-to-relationships note", () => {
    const ok = GameEngine.addDirectorNote("Add librarian Elle to relationship and NPC list");
    expect(ok).toBe(true);
    const rel = StateModule.state.memory.relations.find((r) => r.name === "Elle");
    expect(rel?.disposition).toBe("librarian");
    expect(StateModule.state.npcProfiles.map((p) => p.npcName)).toContain("Elle");
    expect(StateModule.state.directorNotes[0].directive?.name).toBe("Elle");
  });

  it("carries the registered NPC into the next turn's relationships, NPC PROFILES, and reworded note", async () => {
    GameEngine.addDirectorNote("Add librarian Elle to relationship and NPC list");
    mockGenerateResponse.mockResolvedValue("You browse the library stacks.");
    await GameEngine.executeTurn("I visit the academy library.", false);
    const prompt = mockGenerateResponse.mock.calls[0][0] as string;
    expect(prompt).toContain("- Elle: librarian."); // ESTABLISHED RELATIONSHIPS
    expect(prompt).toContain("Elle, the librarian."); // reworded directive note
    expect(prompt).toContain("- Elle"); // NPC PROFILES section
  });

  it("registers a family role named via note ('Add mother in list')", () => {
    GameEngine.addDirectorNote("Add mother in list");
    const rel = StateModule.state.memory.relations.find((r) => r.name === "Mother");
    expect(rel).toBeDefined();
    expect(rel?.status).toBe("Alive");
  });

  it("leaves ordinary in-world event notes untouched", () => {
    GameEngine.addDirectorNote("The town festival starts in 2 days.");
    expect(StateModule.state.memory.relations).toHaveLength(0);
    expect(StateModule.state.directorNotes[0].directive).toBeUndefined();
    // The note keeps its deadline-based event behavior.
    expect(StateModule.state.directorNotes[0].deadlineMinutes).toBeDefined();
  });

  it("resolves a casual family term in a note ('Add my Mom...') onto the seeded entry, not a new NPC", async () => {
    StateModule.state.char.appearance =
      "Lin Hao lives with his mother Diane and his younger sister Lily.";
    seedFamilyRelations(StateModule.state.char.appearance);
    expect(StateModule.state.memory.relations).toHaveLength(2);

    GameEngine.addDirectorNote("Add my Mom to the NPC list");
    // No duplicate "Mom" — the note merged onto the seeded Diane entry.
    expect(StateModule.state.memory.relations).toHaveLength(2);
    expect(StateModule.state.memory.relations.some((r) => r.name === "Mom")).toBe(false);
    const diane = StateModule.state.memory.relations.find((r) => r.name === "Diane");
    // The existing disposition survives — "my" never clobbers it.
    expect(diane?.disposition).toBe("MC's mother");
    // The directive is stored under the canonical name for the reworded note.
    expect(StateModule.state.directorNotes[0].directive?.name).toBe("Diane");

    // The next turn's prompt carries the real relationship, the reworded
    // note ("Diane." — no leftover "the my"), and no "Mom" NPC profile.
    mockGenerateResponse.mockResolvedValue("You find Mom in the kitchen.");
    await GameEngine.executeTurn("I look for my mom.", false);
    const prompt = mockGenerateResponse.mock.calls[0][0] as string;
    expect(prompt).toContain("- Diane: MC's mother.");
    const notesStart = prompt.indexOf("DIRECTOR'S NOTES");
    const notesEnd = prompt.indexOf("\n===", notesStart + 3);
    const notesBlock = prompt.slice(notesStart, notesEnd > -1 ? notesEnd : notesStart + 1200);
    expect(notesBlock).toContain("- Diane.");
    expect(notesBlock).not.toContain("the my");
    // The NPC PROFILES section lists Diane (not Mom) — and only once as her.
    expect(prompt.match(/- Mom:/g) ?? []).toHaveLength(0);
    expect(StateModule.state.npcProfiles.map((p) => p.npcName)).toContain("Diane");
    expect(StateModule.state.npcProfiles.map((p) => p.npcName)).not.toContain("Mom");
  });

  it("reassigns a fact's person via a plain-language correction note ('that fact was about my Mom, not the neighbor')", async () => {
    StateModule.state.char.appearance = "Lin Hao lives with his mother Diane.";
    seedFamilyRelations(StateModule.state.char.appearance);

    // Turn 1: the AI records a fact about the wrong person.
    mockGenerateResponse.mockResolvedValueOnce(
      '[FACT]The neighbor fixed the fence[/FACT] A helpful hand.',
    );
    await GameEngine.executeTurn("I notice the fence is mended.", false);
    let general = StateModule.state.memory.facts.find(
      (b) => b.title === "General World Facts",
    );
    expect(general?.entries).toContain("The neighbor fixed the fence");

    // The author corrects it in plain language — Mom is the canonical Diane.
    GameEngine.addDirectorNote("that fact was about my Mom, not the neighbor");
    general = StateModule.state.memory.facts.find((b) => b.title === "General World Facts");
    expect(general?.entries).toContain("Diane fixed the fence");
    expect(general?.entries.some((e) => e.includes("neighbor"))).toBe(false);
    // The note is stored as a factFix so the prompt renders the correction.
    expect(StateModule.state.directorNotes[0].factFix).toEqual({
      oldPhrase: "the neighbor",
      newName: "Diane",
    });

    // Turn 2: the prompt carries the corrected fact AND the reworded note —
    // never the raw instruction.
    mockGenerateResponse.mockResolvedValue("You walk past the mended fence.");
    await GameEngine.executeTurn("I head out.", false);
    const prompt = mockGenerateResponse.mock.calls[1][0] as string;
    const factsStart = prompt.indexOf("ESTABLISHED FACTS");
    const factsEnd = prompt.indexOf("ESTABLISHED RELATIONSHIPS:");
    const factsBlock = prompt.slice(factsStart, factsEnd > -1 ? factsEnd : factsStart + 3000);
    expect(factsBlock).toContain("- Diane fixed the fence");
    expect(factsBlock).not.toContain("neighbor");
    const notesStart = prompt.indexOf("DIRECTOR'S NOTES");
    const notesEnd = prompt.indexOf("\n===", notesStart + 3);
    const notesBlock = prompt.slice(notesStart, notesEnd > -1 ? notesEnd : notesStart + 1200);
    expect(notesBlock).toContain(
      "Correction: the earlier fact mentioning the neighbor actually concerns Diane.",
    );
    expect(notesBlock).not.toContain("not the neighbor");
  });

  it("auto-registers the corrected person when the fact is reassigned to someone unknown", async () => {
    StateModule.state.char.appearance = "Lin Hao lives with his mother Diane.";
    seedFamilyRelations(StateModule.state.char.appearance);

    // Turn 1: the AI records a fact attributed to the wrong (unregistered) person.
    mockGenerateResponse.mockResolvedValueOnce(
      '[FACT]The blacksmith forged a blade[/FACT] Sparks fly.',
    );
    await GameEngine.executeTurn("I visit the forge.", false);
    expect(
      StateModule.state.memory.relations.some((r) => r.name === "Johnson"),
    ).toBe(false);

    // The author corrects it to someone NOT yet registered — Johnson must be
    // auto-registered through the relation pipeline (relation + NPC profile).
    GameEngine.addDirectorNote("that fact was about Johnson, not the blacksmith");
    const general = StateModule.state.memory.facts.find(
      (b) => b.title === "General World Facts",
    );
    expect(general?.entries).toContain("Johnson forged a blade");
    expect(general?.entries.some((e) => e.includes("blacksmith"))).toBe(false);
    expect(StateModule.state.memory.relations.map((r) => r.name)).toContain("Johnson");
    expect(StateModule.state.npcProfiles.map((p) => p.npcName)).toContain("Johnson");
    expect(StateModule.state.directorNotes[0].factFix).toEqual({
      oldPhrase: "the blacksmith",
      newName: "Johnson",
    });

    // Turn 2: the prompt shows the corrected fact, the registered Johnson in
    // ESTABLISHED RELATIONSHIPS, and the reworded correction.
    mockGenerateResponse.mockResolvedValue("You hear hammers in the distance.");
    await GameEngine.executeTurn("I walk past the forge.", false);
    const prompt = mockGenerateResponse.mock.calls[1][0] as string;
    const relStart = prompt.indexOf("ESTABLISHED RELATIONSHIPS:");
    const relEnd = prompt.indexOf("=== NPC PROFILES");
    const relBlock = prompt.slice(relStart, relEnd > -1 ? relEnd : relStart + 3000);
    expect(relBlock).toContain("- Johnson:");
    const factsStart = prompt.indexOf("ESTABLISHED FACTS");
    const factsEnd = prompt.indexOf("ESTABLISHED RELATIONSHIPS:");
    const factsBlock = prompt.slice(factsStart, factsEnd > -1 ? factsEnd : factsStart + 3000);
    expect(factsBlock).toContain("- Johnson forged a blade");
    expect(factsBlock).not.toContain("blacksmith");
    const notesStart = prompt.indexOf("DIRECTOR'S NOTES");
    const notesEnd = prompt.indexOf("\n===", notesStart + 3);
    const notesBlock = prompt.slice(notesStart, notesEnd > -1 ? notesEnd : notesStart + 1200);
    expect(notesBlock).toContain(
      "Correction: the earlier fact mentioning the blacksmith actually concerns Johnson.",
    );
    expect(notesBlock).not.toContain("not the blacksmith");
  });

  it("names an unnamed family member via a director note — 'Mother' is replaced by her name everywhere", async () => {
    StateModule.state.char.appearance =
      "Lin Hao lives with his widowed mother and his younger sister.";
    seedFamilyRelations(StateModule.state.char.appearance);
    // Role-titled entries — no names in the backstory.
    expect(StateModule.state.memory.relations.find((r) => r.name === "Mother")?.status).toBe(
      "Alive",
    );

    // The author names the mother in plain language.
    GameEngine.addDirectorNote("the mother's name is Diane");
    expect(StateModule.state.memory.relations.some((r) => r.name === "Mother")).toBe(false);
    const diane = StateModule.state.memory.relations.find((r) => r.name === "Diane");
    expect(diane?.disposition).toBe("MC's mother");
    expect(diane?.aliases).toContain("Mother"); // role kept as an alias
    expect(StateModule.state.directorNotes[0].naming).toEqual({ name: "Diane", role: "Mother" });
    // The NPC profile follows the rename.
    expect(StateModule.state.npcProfiles.map((p) => p.npcName)).toContain("Diane");
    expect(StateModule.state.npcProfiles.map((p) => p.npcName)).not.toContain("Mother");

    // The next prompt shows the NAME everywhere — never the bare role title.
    mockGenerateResponse.mockResolvedValue("Diane hums while she works.");
    await GameEngine.executeTurn("I help my mother.", false);
    const prompt = mockGenerateResponse.mock.calls[0][0] as string;
    // ESTABLISHED RELATIONSHIPS lists Diane (not Mother).
    const relStart = prompt.indexOf("ESTABLISHED RELATIONSHIPS:");
    const relEnd = prompt.indexOf("=== NPC PROFILES");
    const relBlock = prompt.slice(relStart, relEnd > -1 ? relEnd : relStart + 3000);
    expect(relBlock).toContain("- Diane: MC's mother.");
    expect(relBlock.match(/- Mother:/g) ?? []).toHaveLength(0);
    // FAMILY block carries the name AND the naming nudge for still-unnamed
    // members (the younger sister is still role-titled).
    const familyIdx = prompt.indexOf("FAMILY (");
    const familyBlock = prompt.slice(familyIdx, familyIdx + 800);
    expect(familyBlock).toContain("- Diane: MC's mother.");
    expect(familyBlock).toContain("If any family member above is listed only by role");
    // DIRECTOR'S NOTES render the natural mention, not the instruction.
    const notesStart = prompt.indexOf("DIRECTOR'S NOTES");
    const notesEnd = prompt.indexOf("\n===", notesStart + 3);
    const notesBlock = prompt.slice(notesStart, notesEnd > -1 ? notesEnd : notesStart + 1200);
    expect(notesBlock).toContain("The MC's mother is called Diane.");
    expect(notesBlock).not.toContain("the mother's name is");
  });
});

// ===========================================================================
// NPC reaction pipeline — do user interactions influence Trust / Affection /
// Aggro / Jealousy? Reactions computed from the witness profiles (traits +
// thresholds) are now APPLIED to the stats every turn, so violent actions
// sour aggressive NPCs, romantic attention stings jealous ones, and gifts
// warm generous ones.
// ===========================================================================

describe("NPC reaction pipeline — user interactions influence Trust/Affection via Aggro/Jealousy", () => {
  beforeEach(resetState);

  it("an aggressive NPC loses Trust and Affection when the MC acts violently", async () => {
    makeWitness("Hrogar", { traits: ["aggressive"], aggressionThreshold: 70 });
    mockGenerateResponse.mockResolvedValue("The guard bares his teeth and advances.");
    await GameEngine.executeTurn("I attack the guard.", false);
    const hrogar = StateModule.state.npcProfiles.find((p) => p.npcName === "Hrogar");
    // escalate_aggressively: trust -15, affection -10
    expect(hrogar?.trust).toBe(35);
    expect(hrogar?.affection).toBe(40);
  });

  it("a jealous NPC loses Trust and Affection when the MC flirts with someone else", async () => {
    makeWitness("Wren", { traits: ["jealous"], jealousyThreshold: 30, affection: 60 });
    makeWitness("Mara", { traits: ["flirtatious"], jealousyThreshold: 50 });
    mockGenerateResponse.mockResolvedValue("Wren watches coldly.");
    await GameEngine.executeTurn("I flirt with Mara.", false);
    const wren = StateModule.state.npcProfiles.find((p) => p.npcName === "Wren");
    // jealous_reaction: affection -10, trust -5
    expect(wren?.affection).toBe(50);
    expect(wren?.trust).toBe(45);
    // The flirtatious target warms up: affection +10, trust +5
    const mara = StateModule.state.npcProfiles.find((p) => p.npcName === "Mara");
    expect(mara?.affection).toBe(60);
    expect(mara?.trust).toBe(55);
  });

  it("a neutral action leaves stats untouched", async () => {
    makeWitness("Mara", { traits: ["stoic"] });
    mockGenerateResponse.mockResolvedValue("You find your pouch in order.");
    await GameEngine.executeTurn("I check my bag.", false);
    const mara = StateModule.state.npcProfiles.find((p) => p.npcName === "Mara");
    expect(mara?.trust).toBe(50);
    expect(mara?.affection).toBe(50);
  });

  it("NPCs not present at the MC's location are never affected", async () => {
    makeWitness("Hrogar", { traits: ["aggressive"], aggressionThreshold: 70, knownLocation: "Elsewhere" });
    mockGenerateResponse.mockResolvedValue("The hall is quiet.");
    await GameEngine.executeTurn("I attack the guard.", false);
    const hrogar = StateModule.state.npcProfiles.find((p) => p.npcName === "Hrogar");
    expect(hrogar?.trust).toBe(50);
    expect(hrogar?.affection).toBe(50);
  });

  it("kindness toward family at home moves their stats and posts a reaction line", async () => {
    // Family anchored at home — exactly what seedFamilyRelations now does.
    makeWitness("Mother", { traits: [], knownLocation: "MC Bedroom" });
    makeWitness("Younger Sister", { traits: [], knownLocation: "MC Bedroom" });
    StateModule.state.worldState.location = "MC Bedroom";
    const spy = vi.spyOn(UIManager, "appendChat");
    mockGenerateResponse.mockResolvedValue("Mei eats her breakfast happily.");
    await GameEngine.executeTurn(
      "You make breakfast for your sister and leave a note with $20 for your mother on the counter.",
      false,
    );
    // respond_warmly: affection +6, trust +4
    const mother = StateModule.state.npcProfiles.find((p) => p.npcName === "Mother");
    expect(mother?.affection).toBe(56);
    expect(mother?.trust).toBe(54);
    const sister = StateModule.state.npcProfiles.find((p) => p.npcName === "Younger Sister");
    expect(sister?.affection).toBe(56);
    expect(sister?.trust).toBe(54);
    expect(spy).toHaveBeenCalledWith(
      "system",
      "Mother reacts warmly — Affection +6, Trust +4",
    );
    expect(spy).toHaveBeenCalledWith(
      "system",
      "Younger Sister reacts warmly — Affection +6, Trust +4",
    );
    spy.mockRestore();
  });

  it("reaction system lines persist into history so they survive reloads", async () => {
    makeWitness("Mother", { traits: [], knownLocation: "MC Bedroom" });
    makeWitness("Younger Sister", { traits: [], knownLocation: "MC Bedroom" });
    StateModule.state.worldState.location = "MC Bedroom";
    mockGenerateResponse.mockResolvedValue("Mei eats her breakfast happily.");
    const userText =
      "You make breakfast for your sister and leave a note with $20 for your mother on the counter.";
    await GameEngine.executeTurn(userText, false);
    // The lines the player saw live are stored as "system" entries between
    // the user action and the assistant reply — in witness order.
    expect(StateModule.state.history).toEqual([
      { role: "user", content: userText },
      { role: "system", content: "Mother reacts warmly — Affection +6, Trust +4" },
      { role: "system", content: "Younger Sister reacts warmly — Affection +6, Trust +4" },
      { role: "assistant", content: "Mei eats her breakfast happily." },
    ]);
  });

  it("persists a fired director-note '⏰ EVENT NOW' line into history", async () => {
    // A note already due fires on the next turn (deadlineMinutes 0).
    StateModule.state.directorNotes.push({
      id: "dn_e2e",
      text: "The realm opens in 2 days.",
      deadlineMinutes: 0,
      createdAtTurn: 0,
      fired: false,
    } as DirectorNote);
    mockGenerateResponse.mockResolvedValue("The gates creak open.");
    await GameEngine.executeTurn("You approach the city gates.", false);
    // The fired event lands as a system entry right after the user action,
    // reworded to NOW, in the same order it appeared in the live chat.
    expect(StateModule.state.history).toEqual([
      { role: "user", content: "You approach the city gates." },
      { role: "system", content: "⏰ EVENT NOW: The realm opens NOW." },
      { role: "assistant", content: "The gates creak open." },
    ]);
  });

  it("the deceased never witnesses, even with a home location set", () => {
    makeWitness("Father", { traits: [], knownLocation: "MC Bedroom" });
    StateModule.state.memory.relations.push({
      name: "Father",
      aliases: ["Dad", "Papa"],
      disposition: "MC's father (deceased)",
      status: "Deceased",
      modifiers: [],
    });
    StateModule.state.worldState.location = "MC Bedroom";
    expect(VacuumSafetyModule.getWitnesses().map((w) => w.npcName)).toEqual([]);
  });

  it("a family member who left for work no longer reacts — only those present do", async () => {
    makeWitness("Mother", { traits: [], knownLocation: "MC Bedroom" });
    makeWitness("Younger Sister", { traits: [], knownLocation: "MC Bedroom" });
    StateModule.state.memory.relations.push(
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
    );
    StateModule.state.worldState.location = "MC Bedroom";
    const spy = vi.spyOn(UIManager, "appendChat");
    mockGenerateResponse.mockResolvedValue("Mei eats her breakfast happily.");
    await GameEngine.executeTurn(
      "You make breakfast for your sister. Your mother already left for her double shift at the diner.",
      false,
    );
    const mother = StateModule.state.npcProfiles.find((p) => p.npcName === "Mother");
    const sister = StateModule.state.npcProfiles.find((p) => p.npcName === "Younger Sister");
    // The story relocated the mother to the diner — no reaction from her.
    expect(mother?.knownLocation).toBe("Diner");
    expect(mother?.trust).toBe(50);
    expect(mother?.affection).toBe(50);
    expect(spy).not.toHaveBeenCalledWith(
      "system",
      expect.stringContaining("Mother reacts"),
    );
    // The sister is home and warms to the care: affection +6, trust +4.
    expect(sister?.affection).toBe(56);
    expect(sister?.trust).toBe(54);
    expect(spy).toHaveBeenCalledWith(
      "system",
      "Younger Sister reacts warmly — Affection +6, Trust +4",
    );
    spy.mockRestore();
  });

  it("a pickpocket attempt near a guard is NOT care — the live-test false positive", () => {
    // Caught live: the sentence "A market guard is sheltering under an awning"
    // matched the care category ("guard" and "shelter" were care words) and
    // made a guard "react warmly" to a theft. Both nouns are now removed from
    // care, and theft is an aggression stimulus.
    makeWitness("Guard", { traits: ["aggressive"], aggressionThreshold: 70 });
    const live =
      "You cut across Market Street in the heavy rain. A market guard is sheltering under an awning nearby. You slip behind a produce stall, keep an eye on the guard, and carefully try to lift a wallet from a passing shopper's pocket before anyone notices.";
    expect(NPCProfileModule.getReaction("Guard", live)).toBe("normal_response");
    // The same scene WITHOUT a theft word stays neutral too.
    expect(
      NPCProfileModule.getReaction("Guard", "A market guard is sheltering under an awning nearby."),
    ).toBe("normal_response");
    // An explicit theft word is aggression, not kindness.
    expect(NPCProfileModule.getReaction("Guard", "You try to steal a wallet from a shopper.")).toBe(
      "escalate_aggressively",
    );
  });

  it("Aggro and Jealousy drive interruption behavior", () => {
    makeWitness("Hrogar", { traits: ["aggressive"], aggressionThreshold: 70 });
    makeWitness("Wren", { traits: ["jealous"], jealousyThreshold: 30, affection: 60 });
    makeWitness("Mara", { traits: ["stoic"], aggressionThreshold: 50 });

    const violent = VacuumSafetyModule.wouldInterrupt("I attack the guard.");
    expect(violent.interrupts).toBe(true);
    expect(violent.npcName).toBe("Hrogar");

    const romantic = VacuumSafetyModule.wouldInterrupt("I kiss her.");
    expect(romantic.interrupts).toBe(true);
    expect(romantic.npcName).toBe("Wren");

    // A non-aggressive, non-jealous NPC lets the action pass.
    const calm = VacuumSafetyModule.wouldInterrupt("I meditate quietly.");
    expect(calm.interrupts).toBe(false);
  });

  it("moved stats surface in the next turn's prompt", async () => {
    makeWitness("Hrogar", { traits: ["aggressive"], aggressionThreshold: 70 });
    mockGenerateResponse.mockResolvedValueOnce("The guard bares his teeth.");
    await GameEngine.executeTurn("I attack the guard.", false);
    mockGenerateResponse.mockResolvedValue("You step back.");
    await GameEngine.executeTurn("I back away.", false);
    const prompt = mockGenerateResponse.mock.calls[1][0] as string;
    // The reaction from turn 1 is reflected in the NPC PROFILES block.
    expect(prompt).toContain("Trust: 35/100 | Affection: 40/100");
    expect(prompt).not.toContain("Trust: 50/100 | Affection: 50/100");
  });

  it("formats reaction lines compactly with signed deltas", () => {
    expect(
      VacuumSafetyModule.formatReactionLine({
        npcName: "Wren",
        label: "with jealousy",
        trustDelta: -5,
        affectionDelta: -10,
      }),
    ).toBe("Wren reacts with jealousy — Affection -10, Trust -5");
    expect(
      VacuumSafetyModule.formatReactionLine({
        npcName: "Mara",
        label: "generously",
        trustDelta: 10,
        affectionDelta: 15,
      }),
    ).toBe("Mara reacts generously — Affection +15, Trust +10");
    // No movement -> no line.
    expect(
      VacuumSafetyModule.formatReactionLine({
        npcName: "Calm",
        label: "calmly",
        trustDelta: 0,
        affectionDelta: 0,
      }),
    ).toBeNull();
  });

  it("posts a compact system line explaining why the stats moved", async () => {
    makeWitness("Wren", { traits: ["jealous"], jealousyThreshold: 30, affection: 60 });
    const spy = vi.spyOn(UIManager, "appendChat");
    mockGenerateResponse.mockResolvedValue("Wren watches coldly.");
    await GameEngine.executeTurn("I flirt with Mara.", false);
    expect(spy).toHaveBeenCalledWith(
      "system",
      "Wren reacts with jealousy — Affection -10, Trust -5",
    );
    spy.mockRestore();
  });

  it("posts no system line when a neutral action changes nothing", async () => {
    makeWitness("Mara", { traits: ["stoic"] });
    const spy = vi.spyOn(UIManager, "appendChat");
    mockGenerateResponse.mockResolvedValue("You find your pouch in order.");
    await GameEngine.executeTurn("I check my bag.", false);
    const systemCalls = spy.mock.calls.filter((c) => c[0] === "system");
    expect(systemCalls).toHaveLength(0);
    spy.mockRestore();
  });

  it("decays repeated identical actions so stats can't be farmed or tanked", async () => {
    makeWitness("Hrogar", { traits: ["aggressive"], aggressionThreshold: 70 });
    mockGenerateResponse.mockResolvedValue("The guard bares his teeth.");
    for (let i = 0; i < 4; i++) {
      await GameEngine.executeTurn("I attack the guard.", false);
    }
    const hrogar = StateModule.state.npcProfiles.find((p) => p.npcName === "Hrogar");
    // Full (-15/-10) -> half (-7/-5) -> quarter (-4/-2) -> none (0/0)
    expect(hrogar?.trust).toBe(24);
    expect(hrogar?.affection).toBe(33);
  });

  it("marks repeated reactions as reduced in the chat line", async () => {
    makeWitness("Hrogar", { traits: ["aggressive"], aggressionThreshold: 70 });
    const spy = vi.spyOn(UIManager, "appendChat");
    mockGenerateResponse.mockResolvedValue("The guard bares his teeth.");
    await GameEngine.executeTurn("I attack the guard.", false);
    await GameEngine.executeTurn("I attack the guard.", false);
    expect(spy).toHaveBeenCalledWith(
      "system",
      "Hrogar reacts aggressively — Affection -5, Trust -7 (reduced)",
    );
    spy.mockRestore();
  });

  it("posts no chat line once a repeated reaction is fully decayed", async () => {
    makeWitness("Hrogar", { traits: ["aggressive"], aggressionThreshold: 70 });
    const spy = vi.spyOn(UIManager, "appendChat");
    mockGenerateResponse.mockResolvedValue("The guard bares his teeth.");
    for (let i = 0; i < 4; i++) {
      await GameEngine.executeTurn("I attack the guard.", false);
    }
    const systemCalls = spy.mock.calls.filter((c) => c[0] === "system");
    // Turns 1-3 moved stats; turn 4 is fully decayed (no line).
    expect(systemCalls).toHaveLength(3);
    spy.mockRestore();
  });

  it("restores full reaction strength after the decay window passes", async () => {
    makeWitness("Hrogar", { traits: ["aggressive"], aggressionThreshold: 70 });
    mockGenerateResponse.mockResolvedValue("The guard bares his teeth.");
    // Turn 1: full -15 trust.
    await GameEngine.executeTurn("I attack the guard.", false);
    let hrogar = StateModule.state.npcProfiles.find((p) => p.npcName === "Hrogar");
    expect(hrogar?.trust).toBe(35);
    // Five neutral turns let the window lapse.
    for (let i = 0; i < 5; i++) {
      await GameEngine.executeTurn("I wait quietly.", false);
    }
    // The next attack is full strength again.
    await GameEngine.executeTurn("I attack the guard.", false);
    hrogar = StateModule.state.npcProfiles.find((p) => p.npcName === "Hrogar");
    expect(hrogar?.trust).toBe(20);
  });
});

// ===========================================================================
// Stimulus matching — the reaction engine no longer requires exact trigger
// words. Actions are normalized (lowercase, punctuation stripped, light
// stemming: "punched"/"punching" -> "punch") and matched against broad
// per-category word sets, so naturally-phrased actions trigger the same
// trait-driven reactions without mechanical keyword cargo.
// ===========================================================================

describe("Stimulus matching — reactions fire on naturally-phrased actions", () => {
  beforeEach(resetState);

  it("matches violent actions however they are phrased", () => {
    makeWitness("Hrogar", { traits: ["aggressive"], aggressionThreshold: 70 });
    for (const action of [
      "I shove the guard.",
      "I punched him.",
      "I raised my fist.",
      "She threatened me.",
      "I slam the table.",
    ]) {
      expect(
        NPCProfileModule.getReaction("Hrogar", action),
        action,
      ).toBe("escalate_aggressively");
    }
  });

  it("matches romantic attention however it is phrased", () => {
    makeWitness("Wren", { traits: ["jealous"], jealousyThreshold: 30, affection: 60 });
    for (const action of ["I embraced her.", "I caressed her cheek.", "I courted her."]) {
      expect(
        NPCProfileModule.getReaction("Wren", action),
        action,
      ).toBe("jealous_reaction");
    }
  });

  it("matches gifts however they are given", () => {
    makeWitness("Grok", { traits: ["greedy"] });
    for (const action of ["I donate the coins.", "I rewarded the guard.", "I bestow a pouch."]) {
      expect(
        NPCProfileModule.getReaction("Grok", action),
        action,
      ).toBe("accept_with_appreciation_for_value");
    }
  });

  it("matches acts of care/kindness toward present NPCs (incl. the live breakfast turn)", () => {
    makeWitness("Mei", { traits: [] });
    const live = "You quietly get ready for school. You make breakfast for your sister, " +
      "leave a note and $20 for your mother on the kitchen counter, then walk your " +
      "sister partway to her school.";
    // The exact live-turn text that previously moved nothing now registers.
    expect(NPCProfileModule.getReaction("Mei", live)).toBe("respond_warmly");
    for (const action of [
      "I cook breakfast for my mother.",
      "I help my sister with her homework.",
      "I leave money to help the family.",
      "I comfort her after the bad day.",
    ]) {
      expect(NPCProfileModule.getReaction("Mei", action), action).toBe("respond_warmly");
    }
    // Warm-hearted NPCs (generous / empathetic / loyal) reciprocate strongly.
    makeWitness("Wei", { traits: ["empathetic"] });
    expect(NPCProfileModule.getReaction("Wei", live)).toBe("reciprocate_generously");
  });

  it("neutral private actions never trigger the care reaction", () => {
    makeWitness("Mei", { traits: [] });
    for (const action of [
      "You stretch and get out of bed.",
      "You check your phone.",
      "You look out the window.",
      "You walk to school alone.",
    ]) {
      expect(NPCProfileModule.getReaction("Mei", action), action).toBe("normal_response");
    }
  });

  it("an aggressive NPC reacts AND interrupts when the MC shoves someone", async () => {
    makeWitness("Hrogar", { traits: ["aggressive"], aggressionThreshold: 70 });
    // The interrupt check now uses the same normalized matching.
    const interrupt = VacuumSafetyModule.wouldInterrupt("I shove the guard.");
    expect(interrupt.interrupts).toBe(true);
    expect(interrupt.npcName).toBe("Hrogar");

    // And the stat movement flows through a real turn.
    mockGenerateResponse.mockResolvedValue("The guard braces himself.");
    await GameEngine.executeTurn("I shove the guard.", false);
    const hrogar = StateModule.state.npcProfiles.find((p) => p.npcName === "Hrogar");
    expect(hrogar?.trust).toBe(35);
    expect(hrogar?.affection).toBe(40);
  });

  it("neutral phrasing still never triggers a reaction", () => {
    makeWitness("Mara", { traits: ["aggressive"], aggressionThreshold: 70 });
    for (const action of [
      "I check my bag.",
      "I meditate quietly.",
      "I read a letter.",
      "I light the lantern.",
    ]) {
      expect(
        NPCProfileModule.getReaction("Mara", action),
        action,
      ).toBe("normal_response");
    }
  });

  it("getNpcMood reads the STRONGEST remembered reaction for the NPC", () => {
    const s = StateModule.state;
    s.turnCount = 30;
    // Warm (intensity 55) and cold (intensity 65) both remembered — the
    // stronger cold one dominates the mood.
    s.actionMemory = [
      {
        id: "am_m1",
        summary: "Nina reacts warmly",
        npc: "Nina",
        category: "social",
        intensity: 55,
        outcome: "warm reaction",
        time: "Monday, March 17, 10:00",
        turn: 28,
      },
      {
        id: "am_m2",
        summary: "Nina reacted with jealousy",
        npc: "Nina",
        category: "social",
        intensity: 65,
        outcome: "cold reaction",
        time: "Monday, March 17, 11:00",
        turn: 29,
      },
    ];
    expect(getNpcMood("Nina")).toBe(-1);
    expect(getNpcMood("Someone Else")).toBe(0);
  });

  it("getNpcMood ignores reactions outside the window and non-reaction entries", () => {
    const s = StateModule.state;
    s.turnCount = 30;
    s.actionMemory = [
      {
        id: "am_m3",
        summary: "Nina reacts warmly",
        npc: "Nina",
        category: "social",
        intensity: 55,
        outcome: "warm reaction",
        time: "Monday, March 17, 09:00",
        turn: 15,
      },
      {
        id: "am_m4",
        summary: "Helped Nina with homework",
        npc: "Nina",
        category: "social",
        intensity: 40,
        time: "Monday, March 17, 10:00",
        turn: 29,
      },
    ];
    // Turn 15 is 15 back — past the 10-turn window; the homework entry is not
    // a reaction at all.
    expect(getNpcMood("Nina")).toBe(0);
  });

  it("a remembered cold reaction blocks a flirtatious NPC's reciprocation", () => {
    makeWitness("Wren", { traits: ["flirtatious"] });
    const s = StateModule.state;
    s.turnCount = 30;
    s.actionMemory = [
      {
        id: "am_m5",
        summary: "Wren reacted coldly",
        npc: "Wren",
        category: "social",
        intensity: 65,
        outcome: "cold reaction",
        time: "Monday, March 17, 11:00",
        turn: 29,
      },
    ];
    // Base: the flirtatious NPC returns the attention warmly.
    expect(NPCProfileModule.getReaction("Wren", "I kiss her.")).toBe("reciprocate_flirtatiously");
    // The remembered coldness turns the flirtation into cool distance.
    expect(NPCProfileModule.getMoodedReaction("Wren", "I kiss her.")).toBe("stoic_rejection");
  });

  it("a remembered cold reaction mutes a generous NPC's warmth toward gifts", () => {
    makeWitness("Grok", { traits: ["generous"] });
    const s = StateModule.state;
    s.turnCount = 30;
    s.actionMemory = [
      {
        id: "am_m6",
        summary: "Grok reacted with hostility",
        npc: "Grok",
        category: "social",
        intensity: 70,
        outcome: "cold reaction",
        time: "Monday, March 17, 11:00",
        turn: 29,
      },
    ];
    expect(NPCProfileModule.getReaction("Grok", "I donate the coins.")).toBe(
      "reciprocate_generously",
    );
    // The remembered coldness blocks the generous reciprocation.
    expect(NPCProfileModule.getMoodedReaction("Grok", "I donate the coins.")).toBe(
      "respond_warmly",
    );
  });

  it("a remembered cold reaction does NOT punish neutral/private actions", () => {
    makeWitness("Mara", { traits: [] });
    const s = StateModule.state;
    s.turnCount = 30;
    s.actionMemory = [
      {
        id: "am_m5b",
        summary: "Mara reacted coldly",
        npc: "Mara",
        category: "social",
        intensity: 65,
        outcome: "cold reaction",
        time: "Monday, March 17, 11:00",
        turn: 29,
      },
    ];
    // Waiting quietly or checking a bag is not cooperation-seeking — the cold
    // mood must not bleed trust for doing nothing.
    expect(NPCProfileModule.getMoodedReaction("Mara", "I check my bag.")).toBe(
      "normal_response",
    );
    expect(NPCProfileModule.getMoodedReaction("Mara", "I wait quietly.")).toBe(
      "normal_response",
    );
  });

  it("a remembered warm reaction eases a suspicious NPC into accepting", () => {
    makeWitness("Mei", { traits: [], trust: 25 });
    const s = StateModule.state;
    s.turnCount = 30;
    s.actionMemory = [
      {
        id: "am_m7",
        summary: "Mei reacts warmly",
        npc: "Mei",
        category: "social",
        intensity: 55,
        outcome: "warm reaction",
        time: "Monday, March 17, 11:00",
        turn: 29,
      },
    ];
    // Base: trust below 30 → the gift is eyed warily.
    expect(NPCProfileModule.getReaction("Mei", "I donate the coins.")).toBe(
      "suspicious_of_gift",
    );
    // The remembered warmth eases the suspicion — they accept warmly.
    expect(NPCProfileModule.getMoodedReaction("Mei", "I donate the coins.")).toBe(
      "respond_warmly",
    );
  });

  it("E2E: a remembered cold reaction flows into the reaction line and deltas", async () => {
    makeWitness("Wren", { traits: ["flirtatious"] });
    const s = StateModule.state;
    s.turnCount = 30;
    s.actionMemory = [
      {
        id: "am_m8",
        summary: "Wren reacted coldly",
        npc: "Wren",
        category: "social",
        intensity: 65,
        outcome: "cold reaction",
        time: "Monday, March 17, 11:00",
        turn: 29,
      },
    ];
    mockGenerateResponse.mockResolvedValue("You step closer.");
    const spy = vi.spyOn(UIManager, "appendChat");
    await GameEngine.executeTurn("I lean in and kiss her.", false);
    // stoic_rejection: affection -5 — the flirtation falls flat against the
    // remembered coldness, and the line names the cool distance.
    const wren = s.npcProfiles.find((p) => p.npcName === "Wren");
    expect(wren?.affection).toBe(45);
    expect(spy).toHaveBeenCalledWith(
      "system",
      expect.stringContaining("Wren reacts with cool distance"),
    );
    expect(spy).toHaveBeenCalledWith(
      "system",
      expect.stringContaining("Affection -5"),
    );
    spy.mockRestore();
  });
});

// ===========================================================================
// Narrative NPC relocation — when the story says an NPC left for a place
// ("mother left for her double shift at the diner"), the profile's
// knownLocation moves so witness checks follow the story instead of keeping
// the NPC at home.
// ===========================================================================

describe("Narrative NPC relocation — prose departures move NPC locations", () => {
  beforeEach(resetState);

  it("relocates a family member who left for a place in the user text", () => {
    makeWitness("Mother", { traits: [], knownLocation: "MC Bedroom" });
    StateModule.state.memory.relations.push({
      name: "Mother",
      aliases: ["Mom"],
      disposition: "MC's mother",
      status: "Alive",
      modifiers: [],
    });
    const moved = NPCProfileModule.applyLocationShifts(
      "Your mother left for her double shift at the diner already.",
      "",
    );
    expect(moved).toBe(1);
    expect(
      StateModule.state.npcProfiles.find((p) => p.npcName === "Mother")
        ?.knownLocation,
    ).toBe("Diner");
  });

  it("relocates by the NPC's canonical name from the AI narrative", () => {
    makeWitness("Lin Wei", { traits: [], knownLocation: "MC Bedroom" });
    const moved = NPCProfileModule.applyLocationShifts(
      "",
      "Lin Wei went to the market.",
    );
    expect(moved).toBe(1);
    expect(
      StateModule.state.npcProfiles.find((p) => p.npcName === "Lin Wei")
        ?.knownLocation,
    ).toBe("Market");
  });

  it("resolves pronoun references through the previous sentence", () => {
    makeWitness("Lin Wei", { traits: [], knownLocation: "MC Bedroom" });
    const moved = NPCProfileModule.applyLocationShifts(
      "",
      "Lin Wei left the room. She is already at the diner.",
    );
    expect(moved).toBe(1);
    expect(
      StateModule.state.npcProfiles.find((p) => p.npcName === "Lin Wei")
        ?.knownLocation,
    ).toBe("Diner");
  });

  it("never relocates on a bare departure, a question, or a negation", () => {
    makeWitness("Lin Wei", { traits: [], knownLocation: "MC Bedroom" });
    expect(NPCProfileModule.applyLocationShifts("Lin Wei left.", "")).toBe(0);
    expect(NPCProfileModule.applyLocationShifts("Did mother leave for the diner?", "")).toBe(0);
    expect(
      NPCProfileModule.applyLocationShifts("Mother didn't go to the market.", ""),
    ).toBe(0);
    expect(
      StateModule.state.npcProfiles.find((p) => p.npcName === "Lin Wei")
        ?.knownLocation,
    ).toBe("MC Bedroom");
  });

  it("ignores non-place captures and other-clause 'at' phrases", () => {
    makeWitness("Lin Wei", { traits: [], knownLocation: "MC Bedroom" });
    expect(
      NPCProfileModule.applyLocationShifts(
        "",
        "Lin Wei was fixing the fence at the back of the house.",
      ),
    ).toBe(0);
    expect(
      NPCProfileModule.applyLocationShifts(
        "",
        "Lin Wei left, and the dog barked at the fence.",
      ),
    ).toBe(0);
    expect(
      StateModule.state.npcProfiles.find((p) => p.npcName === "Lin Wei")
        ?.knownLocation,
    ).toBe("MC Bedroom");
  });

  it("returns a departed NPC home when the story says so", () => {
    StateModule.state.setup = {
      genre: "",
      worldSize: "",
      techStage: "",
      rules: "",
      activeGenres: [],
      measurement: "Metric",
      time: "Monday, March 17, 07:00",
      location: "MC Bedroom",
      mcCultivation: 0,
      statEnd: 10,
      statWil: 10,
      statLck: 10,
      statPer: 10,
    };
    makeWitness("Lin Wei", { traits: [], knownLocation: "Diner" });
    const moved = NPCProfileModule.applyLocationShifts(
      "",
      "Lin Wei came back home.",
    );
    expect(moved).toBe(1);
    expect(
      StateModule.state.npcProfiles.find((p) => p.npcName === "Lin Wei")
        ?.knownLocation,
    ).toBe("MC Bedroom");
  });

  it("picks the LAST destination when the story chains moves", () => {
    makeWitness("Lin Wei", { traits: [], knownLocation: "MC Bedroom" });
    const moved = NPCProfileModule.applyLocationShifts(
      "",
      "Lin Wei left the house and went to the park.",
    );
    expect(moved).toBe(1);
    expect(
      StateModule.state.npcProfiles.find((p) => p.npcName === "Lin Wei")
        ?.knownLocation,
    ).toBe("Park");
  });

  it("keeps the MC and the deceased in place", () => {
    StateModule.state.char.name = "Lin Hao";
    makeWitness("Lin Wei", { traits: [], knownLocation: "MC Bedroom" });
    makeWitness("Father", { traits: [], knownLocation: "MC Bedroom" });
    StateModule.state.memory.relations.push({
      name: "Father",
      aliases: ["Dad"],
      disposition: "MC's father (deceased)",
      status: "Deceased",
      modifiers: [],
    });
    const moved = NPCProfileModule.applyLocationShifts(
      "You left for school. Father left for the diner.",
      "",
    );
    expect(moved).toBe(0);
  });

  it("never relocates on a denied return ('hadn't returned yet' — straight + curly apostrophe)", () => {
    // The exact live sentence that previously relocated Lin Wei to "Yet".
    makeWitness("Lin Wei", { traits: [], knownLocation: "MC Bedroom" });
    const straight =
      "The apartment hallway was silent; your mother hadn't returned yet.";
    expect(NPCProfileModule.applyLocationShifts("", straight)).toBe(0);
    const curly =
      "The apartment hallway was silent; your mother hadn’t returned yet.";
    expect(NPCProfileModule.applyLocationShifts("", curly)).toBe(0);
    expect(
      StateModule.state.npcProfiles.find((p) => p.npcName === "Lin Wei")
        ?.knownLocation,
    ).toBe("MC Bedroom");
  });

  it("stops place capture at temporal words like 'yet again'", () => {
    makeWitness("Lin Wei", { traits: [], knownLocation: "MC Bedroom" });
    const moved = NPCProfileModule.applyLocationShifts(
      "",
      "Lin Wei left for the diner yet again.",
    );
    expect(moved).toBe(1);
    expect(
      StateModule.state.npcProfiles.find((p) => p.npcName === "Lin Wei")
        ?.knownLocation,
    ).toBe("Diner");
  });
});

// ===========================================================================
// Narrative refinement — the AI's own prose moves stats mildly even when the
// action text is neutral ("Wren glares at you coldly."). A soft signal, not a
// mechanic: magnitudes are small, one nudge per NPC per turn, and NPCs that
// already reacted with nonzero deltas this turn are excluded.
// ===========================================================================

describe("Narrative refinement — AI prose nudges Trust/Affection mildly", () => {
  beforeEach(resetState);

  it("applies a hostile nudge when the narrative describes the NPC as angry", () => {
    makeWitness("Wren", {});
    NPCProfileModule.applyNarrativeNudges("Wren glares at you coldly, jaw tight.");
    const wren = StateModule.state.npcProfiles.find((p) => p.npcName === "Wren");
    expect(wren?.trust).toBe(47);
    expect(wren?.affection).toBe(48);
  });

  it("applies a warm nudge for positive narrative and none for neutral prose", () => {
    makeWitness("Mara", {});
    makeWitness("Elle", {});
    NPCProfileModule.applyNarrativeNudges(
      "Mara beams at you warmly. Elle catalogues the scrolls without looking up.",
    );
    const mara = StateModule.state.npcProfiles.find((p) => p.npcName === "Mara");
    expect(mara?.trust).toBe(52);
    expect(mara?.affection).toBe(53);
    // Elle was mentioned but no cue — untouched.
    const elle = StateModule.state.npcProfiles.find((p) => p.npcName === "Elle");
    expect(elle?.trust).toBe(50);
    expect(elle?.affection).toBe(50);
  });

  it("resolves pronoun references via the previous sentence and honors cue priority", () => {
    makeWitness("Mara", {});
    NPCProfileModule.applyNarrativeNudges("Mara steps forward. She smiles, but her hand trembles.");
    const mara = StateModule.state.npcProfiles.find((p) => p.npcName === "Mara");
    // Fearful outranks warm in a mixed sentence: trust -1, affection -1.
    expect(mara?.trust).toBe(49);
    expect(mara?.affection).toBe(49);
  });

  it("never double-counts an NPC that already reacted this turn", () => {
    makeWitness("Hrogar", { traits: ["aggressive"], aggressionThreshold: 70 });
    // The action triggered a real reaction (escalate) — the narrative must not
    // stack an extra hostile nudge on top.
    NPCProfileModule.applyNarrativeNudges(
      "Hrogar snarls and lunges at you.",
      new Set(["hrogar"]),
    );
    const hrogar = StateModule.state.npcProfiles.find((p) => p.npcName === "Hrogar");
    expect(hrogar?.trust).toBe(50);
    expect(hrogar?.affection).toBe(50);
  });

  it("nudges stats silently through a real turn when the action text was neutral", async () => {
    makeWitness("Wren", {});
    const spy = vi.spyOn(UIManager, "appendChat");
    // "I hand her a letter." triggers no reaction words; the AI response is the
    // emotional signal.
    mockGenerateResponse.mockResolvedValue("Wren glares at you coldly before taking the letter.");
    await GameEngine.executeTurn("I hand her a letter.", false);
    const wren = StateModule.state.npcProfiles.find((p) => p.npcName === "Wren");
    expect(wren?.trust).toBe(47);
    expect(wren?.affection).toBe(48);
    // The nudge is silent — no reaction system line (the action was neutral).
    const systemCalls = spy.mock.calls.filter((c) => c[0] === "system");
    expect(systemCalls).toHaveLength(0);
    spy.mockRestore();
  });
});

// ===========================================================================
// Skill activation — using a learned skill (Charm Aura, Artifact Refinement,
// Shadow Step...) lands its effect in Active Modifiers / Artifact State
// (state.modifiers). No trigger words required: the AI emits [SKILL_USE] or
// simply activates the skill in first-person prose and the engine records it.
// Unlearned skills are rejected.
// ===========================================================================

describe("Skill activation — effects land in Active Modifiers / Artifact State", () => {
  beforeEach(resetState);

  it("records a [SKILL_USE] effect into state.modifiers for a learned skill", () => {
    SkillModule.extract(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK]',
    );
    SkillModule.extract(
      '[SKILL_USE]{"skill":"charm_aura","effect":"+20% CHA vs attracted targets","duration":5}[/SKILL_USE]',
    );
    expect(StateModule.state.modifiers.charm_aura).toBe(
      "active (5t/5t, 50m/50m): +20% CHA vs attracted targets",
    );
  });

  it("resolves the skill by name and rejects unlearned skills", () => {
    SkillModule.extract(
      '[SKILL_UNLOCK]shadow_step:Shadow Step:stealth:uncommon:Move silently and blend into darkness[/SKILL_UNLOCK]',
    );
    // By display name (case-insensitive).
    SkillModule.extract(
      '[SKILL_USE]{"skill":"Shadow Step","duration":2}[/SKILL_USE]',
    );
    expect(StateModule.state.modifiers.shadow_step).toContain("active (2t/2t, 20m/20m):");
    // Unlearned skill — rejected, nothing lands.
    SkillModule.extract(
      '[SKILL_USE]{"skill":"charm_aura","effect":"+50% CHA"[/SKILL_USE]',
    );
    expect(StateModule.state.modifiers.charm_aura).toBeUndefined();
    expect(SkillModule.lastIssues.some((i) => i.kind === "SKILL")).toBe(true);
  });

  it("applies the effect from first-person prose without any tag", () => {
    SkillModule.extract(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK]',
    );
    SkillModule.extract("I activate my Charm Aura and step into the hall.");
    expect(StateModule.state.modifiers.charm_aura).toContain("active (3t/3t, 30m/30m):");
  });

  it("never buffs the MC from someone else's activation", () => {
    SkillModule.extract(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK]',
    );
    SkillModule.extract("She activates her charm aura, dazzling the crowd.");
    expect(StateModule.state.modifiers.charm_aura).toBeUndefined();
  });

  it("does not double-apply when the tag and prose both describe the same use", () => {
    SkillModule.extract(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK]',
    );
    SkillModule.extract(
      '[SKILL_USE]{"skill":"charm_aura","duration":4}[/SKILL_USE] I activate my Charm Aura.',
    );
    // The tag wins; the prose fallback sees the entry already set.
    expect(StateModule.state.modifiers.charm_aura).toBe("active (4t/4t, 40m/40m): Radiate an aura that draws others in");
  });

  it("flows through a real turn into the next prompt's Active Modifiers block", async () => {
    mockGenerateResponse.mockResolvedValueOnce(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK]',
    );
    await GameEngine.executeTurn("I learn a new technique.", false);
    mockGenerateResponse.mockResolvedValueOnce(
      'I activate my Charm Aura. [SKILL_USE]{"skill":"charm_aura","effect":"+20% CHA vs attracted targets","duration":5}[/SKILL_USE]',
    );
    await GameEngine.executeTurn("I turn on my charm.", false);
    expect(StateModule.state.modifiers.charm_aura).toContain("+20% CHA");

    mockGenerateResponse.mockResolvedValue("You walk on.");
    await GameEngine.executeTurn("I continue.", false);
    const prompt = mockGenerateResponse.mock.calls[2][0] as string;
    expect(prompt).toContain("Active Modifiers/State Modulations");
    expect(prompt).toContain("charm_aura");
  });
});

describe("Skill effects on NPC reactions — Charm Aura warms, Shadow Step hides", () => {
  beforeEach(resetState);

  it("an active Charm Aura suppresses the jealous reaction in getReaction", () => {
    makeWitness("Wren", { traits: ["jealous"], jealousyThreshold: 30, affection: 60 });
    // Without the aura the same profile sours immediately.
    expect(NPCProfileModule.getReaction("Wren", "I flirt with Mara.")).toBe("jealous_reaction");
    // With the aura active, the possessiveness is soothed — no souring reaction.
    StateModule.state.modifiers.charm_aura = "active (5t): +20% CHA vs attracted targets";
    expect(NPCProfileModule.getReaction("Wren", "I flirt with Mara.")).toBe("normal_response");
  });

  it("an active Charm Aura warms a flirtatious NPC's response through a real turn", async () => {
    makeWitness("Mara", { traits: ["flirtatious"] });
    mockGenerateResponse.mockResolvedValueOnce(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK] [SKILL_USE]{"skill":"charm_aura","effect":"+20% CHA vs attracted targets","duration":5}[/SKILL_USE]',
    );
    await GameEngine.executeTurn("I activate my charm.", false);
    expect(StateModule.state.modifiers.charm_aura).toContain("active (5t/5t, 50m/50m):");

    mockGenerateResponse.mockResolvedValue("Mara smiles warmly.");
    await GameEngine.executeTurn("I flirt with Mara.", false);
    const mara = StateModule.state.npcProfiles.find((p) => p.npcName === "Mara");
    // reciprocate_flirtatiously (+10 affection, +5 trust) amplified by the
    // aura (+5/+2) — first occurrence, so no decay.
    expect(mara?.affection).toBe(65);
    expect(mara?.trust).toBe(57);
  });

  it("a jealous NPC no longer loses stats when the MC flirts under the aura", async () => {
    makeWitness("Wren", { traits: ["jealous"], jealousyThreshold: 30, affection: 60 });
    StateModule.state.modifiers.charm_aura = "active (5t): +20% CHA vs attracted targets";
    const spy = vi.spyOn(UIManager, "appendChat");
    mockGenerateResponse.mockResolvedValue("Wren watches calmly, swayed by your presence.");
    await GameEngine.executeTurn("I flirt with the barmaid.", false);
    const wren = StateModule.state.npcProfiles.find((p) => p.npcName === "Wren");
    expect(wren?.affection).toBe(60);
    expect(wren?.trust).toBe(50);
    // No stat movement -> no reaction system line either.
    const systemCalls = spy.mock.calls.filter((c) => c[0] === "system");
    expect(systemCalls).toHaveLength(0);
    spy.mockRestore();
  });

  it("an active Shadow Step hides the MC — no witnesses, no reactions, no interrupts", async () => {
    makeWitness("Hrogar", { traits: ["aggressive"], aggressionThreshold: 70 });
    StateModule.state.modifiers.shadow_step = "active (3t): Move silently and blend into darkness";

    expect(VacuumSafetyModule.getWitnesses()).toHaveLength(0);
    expect(VacuumSafetyModule.wouldInterrupt("I attack the guard.").interrupts).toBe(false);

    mockGenerateResponse.mockResolvedValue("You slip through the shadows unseen.");
    await GameEngine.executeTurn("I attack the guard.", false);
    const hrogar = StateModule.state.npcProfiles.find((p) => p.npcName === "Hrogar");
    expect(hrogar?.trust).toBe(50);
    expect(hrogar?.affection).toBe(50);
  });

  it("witnesses return once the stealth effect ends", () => {
    makeWitness("Hrogar", { traits: ["aggressive"], aggressionThreshold: 70 });
    StateModule.state.modifiers.shadow_step = "active (3t): Move silently and blend into darkness";
    expect(VacuumSafetyModule.getWitnesses()).toHaveLength(0);
    delete StateModule.state.modifiers.shadow_step;
    expect(VacuumSafetyModule.getWitnesses().map((w) => w.npcName)).toContain("Hrogar");
  });
});

describe("Skill-effect durations — remaining time ticks down in Active Modifiers", () => {
  beforeEach(resetState);

  it("ticks a [SKILL_USE] effect down turn by turn and expires it at zero", async () => {
    mockGenerateResponse.mockResolvedValueOnce(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK] [SKILL_USE]{"skill":"charm_aura","effect":"+20% CHA vs attracted targets","duration":5}[/SKILL_USE]',
    );
    await GameEngine.executeTurn("I activate my charm.", false);
    expect(StateModule.state.modifiers.charm_aura).toBe(
      "active (5t/5t, 50m/50m): +20% CHA vs attracted targets",
    );

    // Each subsequent turn ticks ~10 in-game minutes off.
    mockGenerateResponse.mockResolvedValue("You walk on.");
    await GameEngine.executeTurn("I continue.", false);
    expect(StateModule.state.modifiers.charm_aura).toBe("active (4t/5t, 40m/50m): +20% CHA vs attracted targets");
    await GameEngine.executeTurn("I continue.", false);
    await GameEngine.executeTurn("I continue.", false);
    expect(StateModule.state.modifiers.charm_aura).toBe("active (2t/5t, 20m/50m): +20% CHA vs attracted targets");

    // The AI's prompt reflects the remaining time (post-tick of turn 5).
    mockGenerateResponse.mockResolvedValue("You walk on.");
    await GameEngine.executeTurn("I continue.", false);
    const prompt = mockGenerateResponse.mock.calls[4][0] as string;
    expect(prompt).toContain("charm_aura");
    expect(prompt).toContain("10m/50m");

    // One more turn and the effect has fully expired.
    mockGenerateResponse.mockResolvedValue("You walk on.");
    await GameEngine.executeTurn("I continue.", false);
    expect(StateModule.state.modifiers.charm_aura).toBeUndefined();
  });

  it("an expired Charm Aura stops suppressing jealousy", async () => {
    makeWitness("Wren", { traits: ["jealous"], jealousyThreshold: 30, affection: 60 });
    mockGenerateResponse.mockResolvedValueOnce(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK] [SKILL_USE]{"skill":"charm_aura","duration":2}[/SKILL_USE]',
    );
    await GameEngine.executeTurn("I activate my charm.", false);
    // Aura live (2t): flirting does not sour Wren.
    mockGenerateResponse.mockResolvedValue("Wren keeps her composure.");
    await GameEngine.executeTurn("I flirt with the barmaid.", false);
    const wren1 = StateModule.state.npcProfiles.find((p) => p.npcName === "Wren");
    expect(wren1?.affection).toBe(60);
    expect(wren1?.trust).toBe(50);

    // Aura expires at the start of turn 3's tick: jealousy is back.
    mockGenerateResponse.mockResolvedValue("You walk on.");
    await GameEngine.executeTurn("I continue.", false);
    mockGenerateResponse.mockResolvedValue("Wren watches coldly.");
    await GameEngine.executeTurn("I flirt with the barmaid.", false);
    const wren2 = StateModule.state.npcProfiles.find((p) => p.npcName === "Wren");
    // jealous_reaction: affection -10, trust -5.
    expect(wren2?.affection).toBe(50);
    expect(wren2?.trust).toBe(45);
  });
});

describe("UI Active Modifiers panel — remaining time and progress indicator", () => {
  beforeEach(() => {
    resetState();
    testElements.set("ui-modifiers-list", makeTestElement());
  });
  afterEach(() => {
    testElements.clear();
  });

  it("renders skill effects with formatted remaining time and a progress bar", () => {
    StateModule.state.modifiers = {
      charm_aura: "active (4t/5t, 40m/50m): +20% CHA vs attracted targets",
      legacy_buff: "active (2t): Old buff that still ticks",
      shadowcloak: "Tier 2 Shadowcloak — invisible",
    };
    UIManager.renderAllSidebars();

    const html = (testElements.get("ui-modifiers-list") as TestElement).innerHTML;
    // Skill effect: name, effect text, remaining time, progress width.
    expect(html).toContain("charm aura");
    expect(html).toContain("+20% CHA vs attracted targets");
    expect(html).toContain("40 min"); // formatRemainingTime(40)
    expect(html).toContain('style="width:80%"'); // 40/50 remaining
    // Legacy turns-only effect: minutes derived (2t -> 20 min), full bar.
    expect(html).toContain("legacy buff");
    expect(html).toContain("20 min");
    expect(html).toContain('style="width:100%"');
    // Permanent [STATE_UPDATE] bag still renders flat, without a timer.
    expect(html).toContain("shadowcloak");
    expect(html).toContain("Tier 2 Shadowcloak — invisible");
  });

  it("shows hours and days for long durations", () => {
    StateModule.state.modifiers = {
      blessing: "active (30t/30t, 300m/300m): Long-lived blessing", // 5 hours
      ward: "active (300t/300t, 3000m/3000m): Ancient ward", // ~2 days
    };
    UIManager.renderAllSidebars();
    const html = (testElements.get("ui-modifiers-list") as TestElement).innerHTML;
    expect(html).toContain("5h");
    expect(html).toContain("2 days 2h"); // 3000 min = 2 days 2h
  });
});

describe("Skill training — [SKILL_TRAIN] XP ranks skills up", () => {
  beforeEach(resetState);

  function learnCharmAura(): void {
    SkillModule.extract(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK]',
    );
  }

  it("accumulates XP and ranks up at the threshold, carrying surplus over", () => {
    learnCharmAura();
    // 30 XP: not enough for Lv.2 (needs 50), no rank-up.
    SkillModule.extract('[SKILL_TRAIN]{"skill":"charm_aura","xp":30}[/SKILL_TRAIN]');
    let aura = StateModule.state.char.learnedSkills.find((sk) => sk.id === "charm_aura")!;
    expect(aura.level).toBe(1);
    expect(aura.xpInvested).toBe(30);

    // +20 → exactly 50: ranks up to Lv.2 with nothing left over.
    SkillModule.extract('[SKILL_TRAIN]{"skill":"charm_aura","xp":20}[/SKILL_TRAIN]');
    aura = StateModule.state.char.learnedSkills.find((sk) => sk.id === "charm_aura")!;
    expect(aura.level).toBe(2);
    expect(aura.xpInvested).toBe(0);

    // +60 at Lv.2 (needs 100): stays Lv.2 with 60 banked.
    SkillModule.extract('[SKILL_TRAIN]{"skill":"charm_aura","xp":60}[/SKILL_TRAIN]');
    aura = StateModule.state.char.learnedSkills.find((sk) => sk.id === "charm_aura")!;
    expect(aura.level).toBe(2);
    expect(aura.xpInvested).toBe(60);
  });

  it("carries surplus past the threshold into the next level", () => {
    learnCharmAura();
    // 60 XP at Lv.1: 50 pays for Lv.2, the extra 10 carries over.
    SkillModule.extract('[SKILL_TRAIN]{"skill":"charm_aura","xp":60}[/SKILL_TRAIN]');
    const aura = StateModule.state.char.learnedSkills.find((sk) => sk.id === "charm_aura")!;
    expect(aura.level).toBe(2);
    expect(aura.xpInvested).toBe(10);
  });

  it("can jump multiple levels from a big training session", () => {
    learnCharmAura();
    // 160 at Lv.1: 50 → Lv.2, then 110 − 100 → Lv.3 with 10 left.
    SkillModule.extract('[SKILL_TRAIN]{"skill":"charm_aura","xp":160}[/SKILL_TRAIN]');
    const aura = StateModule.state.char.learnedSkills.find((sk) => sk.id === "charm_aura")!;
    expect(aura.level).toBe(3);
    expect(aura.xpInvested).toBe(10);
  });

  it("resolves the skill by display name and defaults XP to 10", () => {
    learnCharmAura();
    SkillModule.extract('[SKILL_TRAIN]{"skill":"Charm Aura"}[/SKILL_TRAIN]');
    const aura = StateModule.state.char.learnedSkills.find((sk) => sk.id === "charm_aura")!;
    expect(aura.xpInvested).toBe(10);
  });

  it("rejects training for skills the MC has not learned", () => {
    SkillModule.extract('[SKILL_TRAIN]{"skill":"charm_aura","xp":50}[/SKILL_TRAIN]');
    expect(StateModule.state.char.learnedSkills).toHaveLength(0);
    expect(SkillModule.lastIssues.some((i) => i.error.includes("Cannot train unlearned skill"))).toBe(true);
  });

  it("teaches the [SKILL_TRAIN] tag in the system prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("[SKILL_TRAIN]");
    expect(prompt).toContain("SKILL TRAINING");
  });

  it("a leveled-up aura grants more CHA through a real run", async () => {
    // Turn 1: learn + train straight to Lv.2 (50 XP).
    mockGenerateResponse.mockResolvedValueOnce(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK] [SKILL_TRAIN]{"skill":"charm_aura","xp":50}[/SKILL_TRAIN]',
    );
    await GameEngine.executeTurn("I practice my charm in the mirror.", false);
    const aura = StateModule.state.char.learnedSkills.find((sk) => sk.id === "charm_aura")!;
    expect(aura.level).toBe(2);

    // Turn 2: activate the Lv.2 aura.
    mockGenerateResponse.mockResolvedValueOnce(
      '[SKILL_USE]{"skill":"charm_aura","duration":5}[/SKILL_USE]',
    );
    await GameEngine.executeTurn("I activate my charm.", false);

    // Turn 3: effective CHA is 10 + (1 base + 2 levels) = 13.
    mockGenerateResponse.mockResolvedValue("You walk on.");
    await GameEngine.executeTurn("I continue.", false);
    const prompt = mockGenerateResponse.mock.calls[2][0] as string;
    expect(prompt).toContain("Base CHA: 10 (Effective: 13)");
  });
});

describe("UI skill training progress — XP bar in the learned skills panel", () => {
  beforeEach(() => {
    resetState();
    testElements.set("panel-cultivation", makeTestElement());
    testElements.set("ui-learned-skills-list", makeTestElement());
  });
  afterEach(() => {
    testElements.clear();
  });

  it("renders XP invested toward the next level", () => {
    SkillModule.extract(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK]',
    );
    SkillModule.extract('[SKILL_TRAIN]{"skill":"charm_aura","xp":30}[/SKILL_TRAIN]');
    UIManager.renderAllSidebars();

    const html = (testElements.get("ui-learned-skills-list") as TestElement).innerHTML;
    expect(html).toContain("Charm Aura");
    expect(html).toContain("Lv.1");
    expect(html).toContain("30/50 XP to Lv.2");
    expect(html).toContain('style="width:60%"');
  });
});

describe("Custom stat bonuses in skill-use effects", () => {
  beforeEach(resetState);

  it("a declared '+3 CHA' overrides the level-based default through a real turn", async () => {
    mockGenerateResponse.mockResolvedValueOnce(
      '[SKILL_UNLOCK]charm_aura:Charm Aura:social:uncommon:Radiate an aura that draws others in[/SKILL_UNLOCK]',
    );
    await GameEngine.executeTurn("I learn a new technique.", false);
    // Train to Lv.3 — but the declared +3 CHA wins over the level default (+4).
    const aura = StateModule.state.char.learnedSkills.find((sk) => sk.id === "charm_aura")!;
    aura.level = 3;
    mockGenerateResponse.mockResolvedValueOnce(
      '[SKILL_USE]{"skill":"charm_aura","effect":"+3 CHA","duration":5}[/SKILL_USE]',
    );
    await GameEngine.executeTurn("I activate my charm.", false);

    mockGenerateResponse.mockResolvedValue("You walk on.");
    await GameEngine.executeTurn("I continue.", false);
    const prompt = mockGenerateResponse.mock.calls[2][0] as string;
    expect(prompt).toContain("Base CHA: 10 (Effective: 13)"); // declared, not 14
  });

  it("a declared '+2 STR, +1 AGI' raises those stats while CHA keeps its level fallback", () => {
    SkillModule.extract(
      '[SKILL_UNLOCK]iron_skin:Iron Skin:combat:uncommon:Hardens the body to resist blunt damage[/SKILL_UNLOCK]',
    );
    SkillModule.extract(
      '[SKILL_USE]{"skill":"iron_skin","effect":"+2 STR, +1 AGI","duration":5}[/SKILL_USE]',
    );
    const eff = getEffectiveStats();
    expect(eff.str).toBe(12);
    expect(eff.agi).toBe(11);
    expect(eff.int).toBe(10);
    expect(eff.cha).toBe(10);
  });

  it("the chip and tooltip show the declared bonus", () => {
    testElements.set("ui-cha-container", makeTestElement());
    testElements.set("ui-cha", makeTestElement());
    testElements.set("ui-cha-bonus", makeTestElement());
    testElements.set("ui-str-container", makeTestElement());
    StateModule.state.modifiers.charm_aura = "active (5t/5t, 50m/50m): +3 CHA";
    UIManager.renderAllSidebars();

    const el = (id: string) => testElements.get(id) as TestElement;
    expect(el("ui-cha").innerText).toBe("13");
    expect(el("ui-cha-bonus").textContent).toBe("+3");
    expect(el("ui-cha-bonus").classList.contains("hidden")).toBe(false);
    expect(el("ui-cha-container").title).toContain("Charm Aura active: +3 CHA");
  });
});

describe("Fresh start — old autosave and director notes don't leak into a new scenario", () => {
  beforeEach(resetState);

  /** Seed a fake OLD autosave whose NPCs must not survive into a new game. */
  function seedOldAutosave(): void {
    const old = JSON.parse(JSON.stringify(StateModule.state)) as typeof StateModule.state;
    old.initialized = true;
    old.char.name = "Old Game Protagonist";
    old.npcProfiles = [{ npcName: "Wren", traits: [], aggressionThreshold: 50, jealousyThreshold: 50, trust: 50, affection: 50, schedule: [], relationships: [], equipment: [], autoGenerated: true }];
    old.memory.relations = [{ name: "Wren", aliases: [], disposition: "acquaintance", status: "Alive", modifiers: [] }];
    StateModule.state.api.key = "";
    localStorage.setItem("omninovel_autosave", JSON.stringify(old));
    expect(StorageModule.hasAutosave()).toBe(true);
  }

  it("startGenerator invalidates the old autosave so its NPCs never resurrect", async () => {
    seedOldAutosave();
    mockGenerateResponse.mockResolvedValue("The village stirs to life.");
    GameEngine.startGenerator();
    // Wait for the async INIT turn (which re-autosaves the NEW game).
    await vi.waitFor(() => expect(mockGenerateResponse).toHaveBeenCalled());
    const saved = StorageModule.loadAutosave();
    expect(saved).not.toBeNull();
    // The new game's autosave is clean: no Wren anywhere.
    expect(saved!.char.name).not.toBe("Old Game Protagonist");
    expect(saved!.npcProfiles.map((p) => p.npcName)).not.toContain("Wren");
    expect(saved!.memory.relations.map((r) => r.name)).not.toContain("Wren");
    // The live state is clean too.
    expect(StateModule.state.npcProfiles.map((p) => p.npcName)).not.toContain("Wren");
  });

  it("startFresh clears the autosave outright (no reload resurrection)", () => {
    seedOldAutosave();
    GameEngine.startFresh();
    expect(StorageModule.hasAutosave()).toBe(false);
    expect(StorageModule.loadAutosave()).toBeNull();
  });

  it("buildFromUI resets director notes so old instructions don't carry over", () => {
    StateModule.state.directorNotes.push({
      id: "note-1",
      text: "The old scenario's note",
      createdAtTurn: 1,
      createdTimeMinutes: 0,
      fired: false,
      directive: { name: "Wren" },
    });
    StateModule.buildFromUI();
    expect(StateModule.state.directorNotes).toEqual([]);
  });
});

describe("Family anchoring modal on new game — preview, keep, clean slate, edit", () => {
  const FAMILY_BACKSTORY =
    "Lin Hao lives with his widowed mother Diane and his younger sister Lily.";

  beforeEach(() => {
    resetState();
    clearFamilyAnchoringChoices();
    testElements.set("family-anchor-modal", makeTestElement());
    testElements.set("family-anchor-list", makeTestElement());
  });
  afterEach(() => {
    delete (globalThis as { confirm?: unknown }).confirm;
    (UIManager as unknown as { _familyAnchorResolver?: unknown })._familyAnchorResolver = undefined;
    testElements.delete("setup-mc-appearance");
    testElements.delete("family-anchor-modal");
    testElements.delete("family-anchor-list");
  });

  /** Feed the backstory through the real form so buildFromUI picks it up. */
  function setBackstory(text: string): void {
    const el = makeTestElement() as TestElement & { value?: string; focus?: () => void };
    el.value = text;
    el.focus = () => {}; // the edit-abort path focuses this field
    testElements.set("setup-mc-appearance", el);
  }

  /** The modal's pending resolver, present exactly while the dialog is open. */
  function pendingResolver(): ((choice: boolean | null) => void) | undefined {
    return (UIManager as unknown as { _familyAnchorResolver?: (c: boolean | null) => void })
      ._familyAnchorResolver;
  }

  async function startNewGame(
    choice?: "keep" | "clean" | "edit",
  ): Promise<void> {
    mockGenerateResponse.mockResolvedValue("The village stirs to life.");
    const game = GameEngine.startGenerator();
    // If the modal opened, answer it (or leave it to hang on purpose).
    const resolver = pendingResolver();
    if (choice !== undefined && resolver) {
      UIManager.resolveFamilyAnchoring(choice);
    }
    await game;
    if (choice !== "edit") {
      // The INIT turn runs after the modal resolves (or immediately when no
      // family was detected / a choice was remembered).
      await vi.waitFor(() => expect(mockGenerateResponse).toHaveBeenCalled());
    }
  }

  it("previews each detected member with name and role in the modal", async () => {
    setBackstory(FAMILY_BACKSTORY);
    mockGenerateResponse.mockResolvedValue("The village stirs to life.");
    const game = GameEngine.startGenerator();
    expect(pendingResolver()).toBeDefined();

    const list = testElements.get("family-anchor-list") as TestElement;
    expect(list.innerHTML).toContain("Diane");
    expect(list.innerHTML).toContain("MC&#039;s mother"); // escaped apostrophe
    expect(list.innerHTML).toContain("Lily");
    expect(list.innerHTML).toContain("MC&#039;s younger sister");

    UIManager.resolveFamilyAnchoring("keep");
    await game;
    await vi.waitFor(() => expect(mockGenerateResponse).toHaveBeenCalled());
    expect(StateModule.state.memory.relations.map((r) => r.name)).toContain("Diane");
  });

  it("Keep anchors the family (including the deceased father)", async () => {
    setBackstory(FAMILY_BACKSTORY);
    await startNewGame("keep");

    const names = StateModule.state.memory.relations.map((r) => r.name);
    expect(names).toContain("Diane");
    expect(names).toContain("Lily");
    expect(names).toContain("Father");
  });

  it("Clean slate starts with zero family NPCs", async () => {
    setBackstory(FAMILY_BACKSTORY);
    await startNewGame("clean");

    expect(StateModule.state.memory.relations).toEqual([]);
    expect(StateModule.state.npcProfiles).toEqual([]);
    // No "Family" fact bundle either — the deceased-father context is skipped.
    expect(StateModule.state.memory.facts).toEqual([]);
  });

  it("Edit backstory aborts the start — no game, no INIT turn", async () => {
    setBackstory(FAMILY_BACKSTORY);
    await startNewGame("edit");

    expect(StateModule.state.memory.relations).toEqual([]);
    expect(mockGenerateResponse).not.toHaveBeenCalled();
  });

  it("does not open the modal when the backstory has no family", async () => {
    setBackstory("A lone traveler wandering the wastes.");
    await startNewGame();
    expect(pendingResolver()).toBeUndefined();
    expect(StateModule.state.memory.relations).toEqual([]);
  });

  it("keeps anchoring by default when the modal markup is missing (headless)", async () => {
    setBackstory(FAMILY_BACKSTORY);
    testElements.delete("family-anchor-modal");
    testElements.delete("family-anchor-list");
    await startNewGame();

    expect(StateModule.state.memory.relations.map((r) => r.name)).toContain("Diane");
  });

  it("repeat start with the same backstory uses the remembered choice without re-asking", async () => {
    setBackstory(FAMILY_BACKSTORY);
    await startNewGame("keep");
    expect(StateModule.state.memory.relations.map((r) => r.name)).toContain("Diane");

    // Second start, identical backstory: the remembered "keep" wins silently.
    await startNewGame();
    expect(pendingResolver()).toBeUndefined();
    expect(StateModule.state.memory.relations.map((r) => r.name)).toContain("Diane");
  });

  it("a remembered clean slate stays clean on the next start", async () => {
    setBackstory(FAMILY_BACKSTORY);
    await startNewGame("clean");
    expect(StateModule.state.memory.relations).toEqual([]);

    // Same backstory again: no modal, the remembered "clean slate" holds.
    await startNewGame();
    expect(pendingResolver()).toBeUndefined();
    expect(StateModule.state.memory.relations).toEqual([]);
    expect(StateModule.state.npcProfiles).toEqual([]);
  });
});
