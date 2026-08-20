// =============================================================================
// migrate.ts - Versioned save migration.
// Phase 4: Added v3->v4 patch for stat standardization and XP/cultivation fields.
// Phase 5: Added v4->v5 patch converting Relations to NPCProfiles.
// =============================================================================

import { ActionCategory, GameState, SCHEMA_VERSION } from "../state/GameState";
import { STAT_CONSTANTS } from "../state/state";
import { NPCProfileModule } from "../engine/npc-profile";
import { findEconomicMilestones, findNpcReactions } from "../engine/action-memory";

interface MigrationPatch {
  fromVersion: number;
  apply(state: GameState): void;
}

const MIGRATION_PATCHES: MigrationPatch[] = [
  {
    fromVersion: 1,
    apply(state: GameState): void {
      if (!state.quests) state.quests = [];
      if (!state.equipped) state.equipped = [];
      if (!state.currencies) state.currencies = [];
      if (!state.transactionLog) state.transactionLog = [];
      if (state.toggles) {
        (state.toggles as any).quests = true;
        (state.toggles as any).equipment = true;
        (state.toggles as any).economy = true;
        (state.toggles as any).xp = true;
      }
    },
  },
  // Phase 4: Stat standardization and progression fields
  {
    fromVersion: 3,
    apply(state: GameState): void {
      // Standardize character stats to human baseline
      const char = state.char;
      char.cultivation = STAT_CONSTANTS.DEFAULT_CULTIVATION;
      char.str = Math.max(STAT_CONSTANTS.MIN_HUMAN_STAT, Math.min(STAT_CONSTANTS.MAX_HUMAN_STAT, char.str));
      char.agi = Math.max(STAT_CONSTANTS.MIN_HUMAN_STAT, Math.min(STAT_CONSTANTS.MAX_HUMAN_STAT, char.agi));
      char.int = Math.max(STAT_CONSTANTS.MIN_HUMAN_STAT, Math.min(STAT_CONSTANTS.MAX_HUMAN_STAT, char.int));
      char.cha = Math.max(STAT_CONSTANTS.MIN_HUMAN_STAT, Math.min(STAT_CONSTANTS.MAX_HUMAN_STAT, char.cha));

      // Cap at human peak if cultivation is 0
      if (char.cultivation <= 0) {
        char.str = Math.min(char.str, STAT_CONSTANTS.MAX_HUMAN_STAT);
        char.agi = Math.min(char.agi, STAT_CONSTANTS.MAX_HUMAN_STAT);
        char.int = Math.min(char.int, STAT_CONSTANTS.MAX_HUMAN_STAT);
        char.cha = Math.min(char.cha, STAT_CONSTANTS.MAX_HUMAN_STAT);
      }

      // Add Phase 4 progression fields if missing
      if (typeof (char as any).xp !== "number") (char as any).xp = 0;
      if (typeof (char as any).level !== "number") (char as any).level = 1;
      if (typeof (char as any).skillPoints !== "number") (char as any).skillPoints = 0;
      if (!Array.isArray((char as any).learnedSkills)) (char as any).learnedSkills = [];
      if (!Array.isArray((char as any).breakthroughs)) (char as any).breakthroughs = [];

      // Add statConstants if missing
      if (!(state as any).statConstants) {
        (state as any).statConstants = STAT_CONSTANTS;
      }

      // Standardize inventory - remove anachronistic items if cultivation is 0
      if (char.cultivation <= 0) {
        char.inventory = char.inventory.filter(function(item) {
          const anachronistic = ["Crypto", "Smartphone", "Bomb", "ShadowNet", "Liquidity"];
          return !anachronistic.some(function(a) { return (item.name + " " + item.desc).toLowerCase().includes(a.toLowerCase()); });
        });
      }

      // Clear legacy currencies for standardized start
      if (!state.currencies || state.currencies.length === 0) {
        state.currencies = [];
      }
    },
  },
  // Phase 5: Convert Relations to NPCProfiles
  {
    fromVersion: 4,
    apply(state: GameState): void {
      // Initialize Phase 5 containers
      if (!state.npcProfiles) state.npcProfiles = [];
      if (!state.timeStates) state.timeStates = [];
      if (!state.giftLog) state.giftLog = [];

      // Convert existing Relations to NPCProfiles
      const relations = state.memory?.relations || [];
      for (const rel of relations) {
        if (rel.status === "Deceased") continue; // Skip dead NPCs

        const profile = NPCProfileModule.profileFromRelation(
          rel.name,
          rel.disposition,
          rel.aliases || [],
        );
        state.npcProfiles.push(profile);
      }
    },
  },
];

interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  migrated: boolean;
  state: GameState;
}

export function migrate(state: Partial<GameState>): MigrationResult {
  const gs = state as GameState;
  const currentVersion = gs.version ?? 0;

  // Backfill missing containers for legacy saves.
  if (!gs.memory || Array.isArray(gs.memory)) {
    if (state.memory && Array.isArray(state.memory)) {
      gs.memory = { facts: [{ title: "General Facts", entries: state.memory as string[] }], relations: [] };
    } else {
      gs.memory = { facts: [], relations: [] };
    }
  } else if (gs.memory && typeof gs.memory === "object") {
    // gs.memory exists as an object — check if facts contain legacy string entries.
    var mem = gs.memory as any;
    if (Array.isArray(mem.facts) && mem.facts.length > 0 && typeof mem.facts[0] === "string") {
      mem.facts = [{ title: "General Facts", entries: mem.facts as string[] }];
    }
    if (!mem.relations) mem.relations = [];
  }
  if (!gs.modifiers) gs.modifiers = {};
  if (!gs.sceneLog) (gs as any).sceneLog = {};
  else {
    // Pre-ambient saves stored scenes as plain strings; normalize them into
    // SceneEntry objects so ambient fields can be added later.
    const log = (gs as any).sceneLog as Record<string, unknown>;
    for (const k of Object.keys(log)) {
      if (typeof log[k] === "string") log[k] = { description: log[k] as string };
    }
  }
  if (!gs.char) gs.char = { name: "", appearance: "", inventory: [], cultivation: 0, str: 0, agi: 0, int: 0, cha: 0, end: 0, wil: 0, lck: 0, per: 0, systemPoints: 0, health: 100, maxHealth: 100, fatigue: 0, xp: 0, level: 1, skillPoints: 0, learnedSkills: [], breakthroughs: [] };
  if (!gs.char.inventory) gs.char.inventory = [];
  if (!gs.worldState) gs.worldState = { time: "", location: "", measurement: "Metric" };
  if (!gs.history) gs.history = [];
  if (!gs.setup) (gs.setup as any) = { genre: "", activeGenres: [], measurement: "Metric", time: "", location: "", mcCultivation: 0, statEnd: 0, statWil: 0, statLck: 0, statPer: 0 };
  if (typeof gs.setup === "object") {
    const su = gs.setup as any;
    if (!su.activeGenres) su.activeGenres = [];
    if (!su.measurement) su.measurement = "Metric";
    if (!su.time) su.time = "";
    if (!su.location) su.location = "";
    if (su.mcCultivation == null) su.mcCultivation = 0;
    if (su.statEnd == null) su.statEnd = 0;
    if (su.statWil == null) su.statWil = 0;
    if (su.statLck == null) su.statLck = 0;
    if (su.statPer == null) su.statPer = 0;
  }
  if (!gs.api) gs.api = { provider: "local", key: "", url: "http://localhost:11434/api/chat", model: "" };
  // Normalize legacy relation shapes.
  if (gs.memory && gs.memory.relations) {
    gs.memory.relations = gs.memory.relations.map(function(rel: any) {
      return {
        name: rel.name || "",
        aliases: rel.aliases || [],
        disposition: rel.disposition || "",
        status: rel.status === "Deceased" || rel.status === "dead" ? "Deceased" : "Alive",
        modifiers: rel.modifiers || [],
      };
    });
  }

  if (!gs.toggles) gs.toggles = { mcInfo: true, statChecks: true, health: true, subskills: true, time: true, memory: true, quests: true, equipment: true, economy: true, xp: true, npcDepth: true, descriptiveScenes: true, schedules: true };
  else if ((gs.toggles as any).descriptiveScenes === undefined || (gs.toggles as any).schedules === undefined) {
    // Existing saves predate these modules — enable them so resumed games also
    // get richer scene descriptions and logical schedule defaults (the
    // setup-screen checkboxes govern new games).
    if ((gs.toggles as any).descriptiveScenes === undefined) (gs.toggles as any).descriptiveScenes = true;
    if ((gs.toggles as any).schedules === undefined) (gs.toggles as any).schedules = true;
  }
  if (!gs.subskills) gs.subskills = {};
  if (!gs.npcProfiles) gs.npcProfiles = [];
  if (!gs.timeStates) gs.timeStates = [];
  if (!gs.giftLog) gs.giftLog = [];
  if (gs.turnCount == null) (gs as any).turnCount = 0;
  // Stat-check framework containers (pre-framework saves gain empty ones).
  if (!gs.checkLog) (gs as any).checkLog = [];
  if (!gs.checkMomentum) (gs as any).checkMomentum = {};
  if (!gs.checkEscalation) (gs as any).checkEscalation = {};
  if (gs.lastFailedCheck === undefined) (gs as any).lastFailedCheck = null;
  if (!gs.actionMemory) (gs as any).actionMemory = [];
  // Seed runs whenever the log is empty AND a check log exists (an older
  // save, or one that predates the action-memory feature entirely).
  if (gs.actionMemory.length === 0 && gs.checkLog && gs.checkLog.length > 0) {
    // Seed the episodic action memory from the persisted check log so a save
    // that predates the feature (like yesterday's game) still lets the AI
    // compare against what actually happened — sparring outcomes, escapes,
    // and the stat tiers behind them — instead of starting from nothing.
    const seedIntensity: Record<string, number> = {
      critical_failure: 15,
      major_failure: 30,
      minor_failure: 45,
      neutral: 55,
      minor_success: 65,
      major_success: 80,
      critical_success: 95,
    };
    const seedCategory: Record<string, ActionCategory> = {
      STR: "combat",
      AGI: "combat",
      END: "combat",
      CHA: "social",
      SEDUCTION: "intimacy",
      NEGOTIATION: "social",
      INTIMIDATION: "social",
      SNEAKING: "adventure",
      INT: "school",
      WIL: "cultivation",
      LCK: "other",
      PER: "adventure",
    };
    gs.actionMemory = gs.checkLog
      .filter((c: any) => c && c.stat)
      .map((c: any, i: number) => ({
        id: "am_seed_" + i + "_" + (c.turn ?? 0),
        summary: c.context && c.context.trim() ? c.context.trim() : c.stat + " check",
        category: seedCategory[c.stat] || "other",
        intensity: seedIntensity[c.outcome] ?? 50,
        outcome: (c.outcome || "").replace(/_/g, " ") + " (" + c.stat + " " + (c.difficulty || "") + ")",
        time: gs.worldState ? gs.worldState.time || "" : "",
        turn: c.turn ?? 0,
      }));
  }
  // Backfill economic milestones from the persisted chat history: trades,
  // marketplace runs, gambling, and purchases live ONLY in the prose (the
  // model rarely emits [TRANSACTION] tags for them), so a save that predates
  // the economic scanner otherwise lets the AI claim "first time" for a trade
  // it already made 20 turns ago. Scans the stored history once, on load, so
  // yesterday's save immediately knows what the MC did economically. Runs
  // AFTER the check-log seed (which replaces the log when it is empty) and
  // dedupes by summary so re-loads never duplicate.
  {
    const existing = new Set(
      (gs.actionMemory || []).map((e: any) => (e.summary || "").toLowerCase()),
    );
    const hist = (gs.history || []) as any[];
    // Each turn contributes ~2 history entries (user + assistant, plus the odd
    // system line), so half the entry index is a decent turn estimate for
    // ordering — good enough for the memory log's "when" field.
    for (let i = 0; i < hist.length; i++) {
      const h = hist[i];
      const text = h && typeof h.content === "string" ? h.content : typeof h === "string" ? h : "";
      if (!text) continue;
      const found = findEconomicMilestones(text);
      for (const m of found) {
        const key = m.summary.toLowerCase();
        if (existing.has(key)) continue;
        existing.add(key);
        (gs.actionMemory as any[]).push({
          id: "am_seed_econ_" + (gs.actionMemory as any[]).length + "_" + i,
          summary: m.summary,
          category: "economy",
          intensity: m.intensity,
          outcome: m.amount ? `for ${m.amount}` : undefined,
          time: gs.worldState ? gs.worldState.time || "" : "",
          turn: Math.floor(i / 2),
        });
      }
    }
  }
  // Backfill narration-only NPC reactions from the persisted history too
  // ("Nina reacts warmly" with no [CHECK]/[MEMORY]/reaction tag). Uses the
  // migrated save's OWN NPC names — the live module state is stale during
  // migration. Dedupes by summary so re-loads never duplicate.
  {
    const existing = new Set(
      (gs.actionMemory || []).map((e: any) => (e.summary || "").toLowerCase()),
    );
    const npcNames: string[] = [];
    for (const p of gs.npcProfiles || []) npcNames.push(p.npcName);
    for (const r of gs.memory?.relations || []) {
      npcNames.push(r.name);
      for (const a of r.aliases || []) npcNames.push(a);
    }
    const hist = (gs.history || []) as any[];
    for (let i = 0; i < hist.length; i++) {
      const h = hist[i];
      const text = h && typeof h.content === "string" ? h.content : typeof h === "string" ? h : "";
      if (!text) continue;
      for (const r of findNpcReactions(text, npcNames)) {
        const key = r.summary.toLowerCase();
        if (existing.has(key)) continue;
        existing.add(key);
        (gs.actionMemory as any[]).push({
          id: "am_seed_reac_" + (gs.actionMemory as any[]).length + "_" + i,
          summary: r.summary,
          npc: r.npc,
          category: "social",
          intensity: r.valence > 0 ? 55 : r.valence < 0 ? 65 : 45,
          outcome: r.valence > 0 ? "warm reaction" : r.valence < 0 ? "cold reaction" : undefined,
          time: gs.worldState ? gs.worldState.time || "" : "",
          turn: Math.floor(i / 2),
        });
      }
    }
  }
  // Backfill the persisted transaction log into action memory: buys, sells,
  // rewards, and fines the engine recorded (from [TRANSACTION] tags or the
  // structured fallback) are remembered even when the AI never mentioned them
  // in prose — nothing the engine recorded is forgotten. Dedupes by summary.
  {
    const existing = new Set(
      (gs.actionMemory || []).map((e: any) => (e.summary || "").toLowerCase()),
    );
    for (const t of gs.transactionLog || []) {
      if (!t || !t.itemName) continue;
      const verb =
        t.type === "sell" ? "Sold" : t.type === "reward" ? "Rewarded with" : t.type === "fine" ? "Paid" : "Bought";
      const summary = `${verb} ${t.itemName}${t.partner ? ` from ${t.partner}` : ""}`;
      const key = summary.toLowerCase();
      if (existing.has(key)) continue;
      existing.add(key);
      const price = t.amount != null ? `${t.amount} ${t.currency || ""}`.trim() : undefined;
      (gs.actionMemory as any[]).push({
        id: "am_seed_txn_" + (gs.actionMemory as any[]).length + "_" + (t.id || "").replace(/[^a-zA-Z0-9_\-]/g, "_"),
        summary,
        category: "economy",
        intensity: t.type === "reward" ? 35 : t.type === "sell" ? 55 : 40,
        outcome: price ? `for ${price}` : undefined,
        time: t.timestamp || (gs.worldState ? gs.worldState.time || "" : ""),
        turn: 0,
      });
    }
  }
  // Backfill CURRENCY-BALANCE history from the transaction log: every
  // recorded buy/fine spent the currency and every sell/reward earned it.
  // Old saves predate the state-delta diff, so the balance-level story
  // ("Spent 250 USD", "Earned 3 Copper") is missing even though the item
  // transactions were remembered — seed it now so the Economy History panel
  // and the AI's comparisons see the balances moving. Mirrors the live
  // harvest step 9 (same summaries, outcomes, and intensities). Dedupes by
  // summary; idempotent across reloads.
  {
    const existing = new Set(
      (gs.actionMemory || []).map((e: any) => (e.summary || "").toLowerCase()),
    );
    for (const t of gs.transactionLog || []) {
      if (!t || t.amount == null || !t.currency) continue;
      const spend = t.type === "buy" || t.type === "fine";
      const summary = spend
        ? `Spent ${t.amount} ${t.currency}`
        : `Earned ${t.amount} ${t.currency}`;
      const key = summary.toLowerCase();
      if (existing.has(key)) continue;
      existing.add(key);
      (gs.actionMemory as any[]).push({
        id: "am_seed_cur_" + (gs.actionMemory as any[]).length + "_" + (t.id || "").replace(/[^a-zA-Z0-9_\-]/g, "_"),
        summary,
        category: "economy",
        intensity: spend ? 40 : 35,
        outcome: `${t.currency} ${spend ? "-" : "+"}${t.amount}`,
        time: t.timestamp || (gs.worldState ? gs.worldState.time || "" : ""),
        turn: 0,
      });
    }
  }
  if (!gs.directorNotes) (gs as any).directorNotes = [];
  else {
    // Normalize legacy plain-string notes into DirectorNote objects.
    (gs as any).directorNotes = gs.directorNotes.map((n: any) =>
      typeof n === "string"
        ? {
            id: "dn_legacy_" + Math.random().toString(36).slice(2, 10),
            text: n,
            createdAtTurn: gs.turnCount ?? 0,
            fired: false,
          }
        : n,
    );
  }

  var fromVersion = currentVersion;
  var migrated = false;

  for (const patch of MIGRATION_PATCHES) {
    if (patch.fromVersion === currentVersion) {
      patch.apply(gs);
      gs.version = patch.fromVersion + 1;
      migrated = true;
    }
  }

  if (!migrated) {
    gs.version = SCHEMA_VERSION;
  }

  return {
    fromVersion: fromVersion,
    toVersion: gs.version ?? SCHEMA_VERSION,
    migrated: migrated,
    state: gs,
  };
}
