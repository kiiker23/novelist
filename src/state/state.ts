// =============================================================================
// state.ts — Ported from the original StateModule.
//
// Holds the single live GameState and the pure functions that mutate it
// (build from UI, recalc subskills). DOM reads stay isolated here so the rest
// of the engine works on typed data only.
//
// Phase 3+: Added quests, equipped items, currencies, and transaction log.
// Phase 4: Standardized stat defaults (human baseline 10, peak 20),
//          scenario-neutral default inventory, XP/Level/Cultivation systems.
// =============================================================================

import { GameState, InventoryItem, SCHEMA_VERSION, StatConstants } from "./GameState";
import { getEffectiveStats } from "../engine/equipment";

/** Default stat constants enforcing the human baseline/peak rules. */
export const STAT_CONSTANTS: StatConstants = {
  MIN_HUMAN_STAT: 1,
  MAX_HUMAN_STAT: 20,
  DEFAULT_HUMAN_STAT: 10,
  DEFAULT_CULTIVATION: 0.0,
  CULTIVATION_MULTIPLIER: 0.2,
};

/** Scenario-neutral default inventory — no anachronistic items. */
export const defaultInventory: InventoryItem[] = [
  { name: "Simple Clothes", desc: "Basic everyday attire suitable for the setting", qty: 1, props: { category: "Clothing", type: "Basic" } },
  { name: "Small Pouch", desc: "A simple cloth pouch for carrying small items", qty: 1, props: { category: "Accessory", type: "Container" } },
];

function createInitialState(): GameState {
  return {
    version: SCHEMA_VERSION,
    initialized: false,
    setup: {},
    char: {
      name: "Unnamed Protagonist",
      appearance: "",
      inventory: [],
      cultivation: STAT_CONSTANTS.DEFAULT_CULTIVATION,
      str: STAT_CONSTANTS.DEFAULT_HUMAN_STAT,
      agi: STAT_CONSTANTS.DEFAULT_HUMAN_STAT,
      int: STAT_CONSTANTS.DEFAULT_HUMAN_STAT,
      cha: STAT_CONSTANTS.DEFAULT_HUMAN_STAT,
      // Phase 6: Secondary stats
      end: STAT_CONSTANTS.DEFAULT_HUMAN_STAT,
      wil: STAT_CONSTANTS.DEFAULT_HUMAN_STAT,
      lck: STAT_CONSTANTS.DEFAULT_HUMAN_STAT,
      per: STAT_CONSTANTS.DEFAULT_HUMAN_STAT,
      health: 100,
      maxHealth: 100,
      fatigue: 0,
      // Phase 4: Progression
      xp: 0,
      level: 1,
      skillPoints: 0,
      systemPoints: 0,
      learnedSkills: [],
      breakthroughs: [],
    },
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
      descriptiveScenes: true,
      schedules: true,
    },
    subskills: {},
    modifiers: {},
    sceneLog: {},
    worldState: { time: "Monday, March 17, 07:00", location: "Starting Location", measurement: "Metric" },
    memory: { facts: [], relations: [] },
    quests: [],
    equipped: [],
    currencies: [],
    transactionLog: [],
    npcProfiles: [],
    timeStates: [],
    giftLog: [],
    directorNotes: [],
    turnCount: 0,
    templates: [],
    checkLog: [],
    checkMomentum: {},
    checkEscalation: {},
    lastFailedCheck: null,
    actionMemory: [],
    history: [],
    // Local-first default: the app probes Ollama/LM Studio on localhost and
    // the badge advertises them, so the fresh-state provider matches that
    // instead of claiming Gemini while pointing at a local server.
    api: {
      provider: "local",
      key: "",
      url: "http://localhost:11434/api/chat",
      model: "llama3.2",
    },
    statConstants: STAT_CONSTANTS,
  };
}

export const StateModule = {
  state: createInitialState(),

  /** Replace the live state (used by import / autosave restore). */
  replaceState(next: GameState): void {
    this.state = next;
  },

  initEnvKey(): void {
    const envKey = "";
    if (envKey) this.state.api.key = envKey;

    const invField = document.getElementById(
      "setup-mc-inventory-json",
    ) as HTMLTextAreaElement | null;
    if (invField) invField.value = JSON.stringify(defaultInventory, null, 2);
  },

  buildFromUI(): void {
    const val = (id: string): string => {
      const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
      return el ? el.value : "";
    };
    const checked = (id: string): boolean => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      return el ? el.checked : false;
    };

    this.state.setup = {
      genre: val("setup-genre"),
      worldSize: val("setup-world-size"),
      techStage: val("setup-tech-stage"),
      rules: val("setup-world-rules"),
      // Phase 6: Secondary fields
      activeGenres: val("setup-genre-tags").split(",").map(s => s.trim()).filter(Boolean),
      measurement: val("setup-measurement"),
      time: val("setup-time"),
      location: val("setup-location"),
      mcCultivation: parseFloat(val("setup-mc-cultivation")) || 0,
      statEnd: parseInt(val("setup-stat-end")) || 0,
      statWil: parseInt(val("setup-stat-wil")) || 0,
      statLck: parseInt(val("setup-stat-lck")) || 0,
      statPer: parseInt(val("setup-stat-per")) || 0,
    };

    let parsedInv: InventoryItem[] = [];
    try {
      const jsonInput = val("setup-mc-inventory-json").trim();
      if (jsonInput === "") {
        parsedInv = [];
      } else {
        const parsed = JSON.parse(jsonInput);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        parsedInv = parsed as InventoryItem[];
      }
    } catch {
      parsedInv = defaultInventory;
    }

    const getNum = (id: string, def: number): number => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el) return def;
      const raw = el.value.trim();
      if (raw === "") return def;
      const num = Number(raw);
      return Number.isNaN(num) ? def : num;
    };

    this.state.char = {
      name: val("setup-mc-name") || "Unnamed Protagonist",
      appearance: val("setup-mc-appearance"),
      inventory: parsedInv,
      cultivation: getNum("setup-mc-cultivation", STAT_CONSTANTS.DEFAULT_CULTIVATION),
      str: getNum("setup-stat-str", STAT_CONSTANTS.DEFAULT_HUMAN_STAT),
      agi: getNum("setup-stat-agi", STAT_CONSTANTS.DEFAULT_HUMAN_STAT),
      int: getNum("setup-stat-int", STAT_CONSTANTS.DEFAULT_HUMAN_STAT),
      cha: getNum("setup-stat-cha", STAT_CONSTANTS.DEFAULT_HUMAN_STAT),
      // Phase 6: Secondary stats
      end: getNum("setup-stat-end", STAT_CONSTANTS.DEFAULT_HUMAN_STAT),
      wil: getNum("setup-stat-wil", STAT_CONSTANTS.DEFAULT_HUMAN_STAT),
      lck: getNum("setup-stat-lck", STAT_CONSTANTS.DEFAULT_HUMAN_STAT),
      per: getNum("setup-stat-per", STAT_CONSTANTS.DEFAULT_HUMAN_STAT),
      health: 100,
      maxHealth: 100,
      fatigue: 0,
      // Phase 4: Progression
      xp: 0,
      level: 1,
      skillPoints: 0,
      systemPoints: 0,
      learnedSkills: [],
      breakthroughs: [],
    };

    this.state.toggles = {
      mcInfo: checked("toggle-mcInfo"),
      statChecks: checked("toggle-statChecks"),
      health: checked("toggle-health"),
      subskills: checked("toggle-subskills"),
      time: checked("toggle-time"),
      memory: checked("toggle-memory"),
      quests: checked("toggle-quests"),
      equipment: checked("toggle-equipment"),
      economy: checked("toggle-economy"),
      xp: checked("toggle-xp"),
      npcDepth: checked("toggle-npcDepth"),
      descriptiveScenes: checked("toggle-descriptiveScenes"),
      schedules: checked("toggle-schedules"),
    };

    this.state.worldState = {
      measurement: val("setup-measurement"),
      time: val("setup-time"),
      location: val("setup-location"),
    };

    this.state.modifiers = {};
    this.state.sceneLog = {};
    this.state.memory = { facts: [], relations: [] };
    this.state.directorNotes = [];
    this.state.quests = [];
    this.state.equipped = [];
    this.state.currencies = [];
    this.state.transactionLog = [];
    this.state.npcProfiles = [];
    this.state.timeStates = [];
    this.state.giftLog = [];
    this.state.templates = [];
    this.state.checkLog = [];
    this.state.checkMomentum = {};
    this.state.checkEscalation = {};
    this.state.lastFailedCheck = null;
    this.state.actionMemory = [];
    this.state.statConstants = STAT_CONSTANTS;

    this.recalculateSubskills();

    this.state.initialized = true;
    this.state.history = [];
  },

  recalculateSubskills(): void {
    // Effective stats already fold equipped gear bonuses on top of
    // cultivation-scaled base stats (getEffectiveStats), so gear that boosts
    // AGI also raises Sneaking, STR gear feeds Intimidation, etc. — the same
    // numbers the prompt and stat-check pipeline show the AI.
    const eff = getEffectiveStats();

    if (this.state.toggles.subskills) {
      this.state.subskills = {
        seduction: Math.floor((eff.cha + eff.int) / 2),
        sneaking: Math.floor(eff.agi * 1.5),
        negotiation: Math.floor(eff.cha * 1.5 - eff.str * 0.2),
        intimidation: Math.floor((eff.str + eff.cha) / 2),
      };
    }
  },
};
