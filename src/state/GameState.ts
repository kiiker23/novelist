// =============================================================================
// GameState.ts — Master type definitions for the OmniNovel Engine.
//
// Phase 0: compile-time types for all state.
// Phase 3: added Quest, EquipmentSlot, Currency, Economy, and progression types.
// Phase 4: added XP/Level, SkillTree, CultivationBreakthrough, and stat standardization.
// Phase 5: added NPCProfile, NPCTrait, NPCRelationship, TimeState, NPCEquipment, GiftLog.
// =============================================================================

/** Bump this whenever the persisted save shape changes. Used by save migration. */
export const SCHEMA_VERSION = 5 as const;

export type ApiProvider =
  | "gemini"
  | "openai"
  | "claude"
  | "deepseek"
  | "groq"
  | "together"
  | "mistral"
  | "local"
  | "custom";

export interface ApiConfig {
  provider: ApiProvider;
  key: string;
  url: string;
  model: string;
  /**
   * Coherence guard: when the model's response rambles (opens with reasoning
   * instead of story), re-ask once with a simpler prompt. Defaults to true
   * when undefined; disable on fast cloud models where rambling is rare so a
   * bad turn doesn't cost an extra API call.
   */
  retryOnRambling?: boolean;
}

/** A single inventory item. `props` is an open bag of custom attributes. */
export interface InventoryItem {
  name: string;
  desc: string;
  qty: number;
  props: Record<string, string | number | boolean>;
}

export interface WorldState {
  time: string;
  location: string;
  measurement: string;
}

/** A remembered scene: the location's description plus optional ambient conditions. */
export interface SceneEntry {
  description: string;
  weather?: string;
  lighting?: string;
  season?: string;
  /** Gentle consistency note when the AI's season contradicted the calendar. */
  seasonNote?: string;
}

/** Scenes keyed by lowercased location name. */
export type SceneLog = Record<string, SceneEntry>;

export interface CharacterState {
  name: string;
  appearance: string;
  inventory: InventoryItem[];
  cultivation: number;
  str: number;
  agi: number;
  int: number;
  cha: number;
  // Phase 6: Secondary stats
  end: number;
  wil: number;
  lck: number;
  per: number;
  health: number;
  maxHealth: number;
  fatigue: number;
  // Phase 4: Progression
  xp: number;
  level: number;
  skillPoints: number;
  // Phase 6: System points (LitRPG-style, distinct from cultivation)
  systemPoints: number;
  learnedSkills: LearnedSkill[];
  breakthroughs: CultivationBreakthrough[];
}

export interface SetupState {
  genre: string;
  worldSize: string;
  techStage: string;
  rules: string;
  /** Phase 6: Selected genre tags (comma-separated → array). */
  activeGenres: string[];
  /** Phase 6: World metadata. */
  measurement: string;
  time: string;
  location: string;
  /** Phase 6: Secondary stat inputs from setup form. */
  mcCultivation: number;
  statEnd: number;
  statWil: number;
  statLck: number;
  statPer: number;
  /** Phase 6: Pre-built template identifier (builtin or user). */
  templateId?: string;
}

export interface Toggles {
  mcInfo: boolean;
  statChecks: boolean;
  health: boolean;
  subskills: boolean;
  time: boolean;
  memory: boolean;
  quests: boolean;
  equipment: boolean;
  economy: boolean;
  xp: boolean;
  npcDepth: boolean;
  /** Descriptive Scenes: vivid environmental descriptions, remembered per location. */
  descriptiveScenes: boolean;
  /** Schedule awareness: logical time-of-day defaults for who is where/awake. */
  schedules: boolean;
}

export interface Subskills {
  seduction: number;
  sneaking: number;
  negotiation: number;
  intimidation: number;
}

/**
 * A Director's Note: an author-injected world event.
 * `deadlineMinutes` is parsed from the note text (e.g. "in 2 days") and counts
 * down against in-game time; when it reaches 0 the event `fired` and is
 * re-prompted to the AI as happening NOW.
 */
export interface DirectorNote {
  id: string;
  text: string;
  /** Total deadline in in-game minutes from creation (undefined = open-ended). */
  deadlineMinutes?: number;
  /** Turn count when the note was created. */
  createdAtTurn: number;
  /** Parsed in-game minute count at creation (undefined if time unparseable). */
  createdTimeMinutes?: number;
  /** Last parsed in-game minute count seen (monotonic, handles week wrap). */
  lastSeenTimeMinutes?: number;
  /** Whether the deadline has been reached. */
  fired: boolean;
  /** Turn on which the event fired. */
  firedAtTurn?: number;
  /**
   * Set when the note is an author directive that registers an NPC/
   * relationship (e.g. "Add librarian Elle to relationships"). The engine
   * applies the registration mechanically and the prompt renders the note
   * reworded as a neutral in-world mention instead of a broken instruction.
   */
  directive?: { name: string; disposition?: string };
  /**
   * Set when the note corrects which person a stored fact is about ("that
   * fact was about my Dad, not the neighbor"). The engine rewrites the
   * fact's person mention mechanically and the prompt renders the note as
   * the corrected attribution instead of the raw instruction.
   */
  factFix?: { oldPhrase: string; newName: string };
  /**
   * Set when the note names an unnamed family member ("the mother's name is
   * Diane"). The engine renames the role-titled entry (old role kept as an
   * alias) and the prompt renders the name as a natural in-world mention.
   */
  naming?: { name: string; role: string };
}

/** A time-limited status effect attached to an NPC (e.g. Drunk for 3 turns). */
export interface RelationModifier {
  name: string;
  duration: number;
}

export interface Relation {
  name: string;
  aliases: string[];
  disposition: string;
  status: "Alive" | "Deceased";
  modifiers: RelationModifier[];
}

/** A titled group of fact strings (e.g. "Household" -> ["Debt cleared", ...]). */
export interface FactBundle {
  title: string;
  entries: string[];
}

export interface Memory {
  facts: FactBundle[];
  relations: Relation[];
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  /** For assistant messages this holds the RAW text including engine tags. */
  content: string;
}

/** Persistent, free-form multipliers / buffs keyed by name. */
export type Modifiers = Record<string, string | number | boolean>;

// =============================================================================
// Phase 3+: Structured game systems
// =============================================================================

export type QuestStatus = "active" | "completed" | "failed";

export type QuestType = "main" | "side" | "daily" | "hidden";

export interface QuestObjective {
  description: string;
  completed: boolean;
}

export interface Quest {
  id: string;
  title: string;
  description: string;
  type: QuestType;
  status: QuestStatus;
  objectives: QuestObjective[];
  reward: string;
  assignedBy?: string; // NPC name
  acceptedAt?: string; // timestamp string
  completedAt?: string;
}

export type EquipmentSlot =
  | "head"
  | "neck"
  | "chest"
  | "arms"
  | "hands"
  | "legs"
  | "feet"
  | "weapon"
  | "offhand"
  | "ring"
  | "belt"
  | "back"
  | "trinket";

export interface EquipmentStats {
  str?: number;
  agi?: number;
  int?: number;
  cha?: number;
  healthBonus?: number;
  fatigueReduction?: number;
  [key: string]: number | undefined;
}

export interface EquippedItem {
  itemId: string; // reference to inventory item name
  name: string;
  slot: EquipmentSlot;
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  stats: EquipmentStats;
  desc: string;
  equipped: boolean;
}

export interface CurrencyEntry {
  name: string;
  amount: number;
  props: Record<string, string | number | boolean>;
}

export interface ShopOffering {
  name: string;
  price: number;
  currency: string;
  stock: number;
  description: string;
}

export interface TransactionLog {
  id: string;
  type: "buy" | "sell" | "reward" | "fine";
  itemName: string;
  amount: number;
  currency: string;
  timestamp: string;
  partner?: string;
}

// =============================================================================
// Phase 4: XP, Leveling, Skill Trees, Cultivation Breakthroughs
// =============================================================================

export type SkillRarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

export type SkillCategory = "combat" | "cultivation" | "social" | "crafting" | "stealth" | "knowledge";

/** A single skill node in the player's skill tree. */
export interface LearnedSkill {
  /** Unique identifier, e.g. "fireball", "spirit_sense" */
  id: string;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
  /** Category the skill belongs to */
  category: SkillCategory;
  /** Rarity determines XP cost to unlock */
  rarity: SkillRarity;
  /** Current level of this skill (0 = learned but untrained, 1-10 = mastery) */
  level: number;
  /** Total XP invested in this skill */
  xpInvested: number;
  /** Whether the skill is currently active/equipped */
  active: boolean;
  /** Custom props for skill-specific effects */
  props: Record<string, string | number | boolean>;
}

/** XP thresholds: level N requires this much total XP to reach. */
export interface XpTableEntry {
  level: number;
  cumulativeXp: number;
}

/** A breakthrough milestone in cultivation. */
export interface CultivationBreakthrough {
  /** Internal ID, e.g. "foundation_establishment" */
  id: string;
  /** Display name */
  name: string;
  /** Description of what happens at this breakthrough */
  description: string;
  /** Minimum cultivation value required */
  minCultivation: number;
  /** Stat boost granted on breakthrough */
  statBoost: Record<string, number>;
  /** Whether the player has already achieved this breakthrough */
  achieved: boolean;
  /** Optional prerequisite skill IDs */
  requiredSkills?: string[];
}

/** Stat standardization constants */
export interface StatConstants {
  /** Minimum human stat */
  MIN_HUMAN_STAT: number;
  /** Maximum natural human stat without cultivation/system aid */
  MAX_HUMAN_STAT: number;
  /** Default base stat for a normal human */
  DEFAULT_HUMAN_STAT: number;
  /** Default cultivation for a mortal */
  DEFAULT_CULTIVATION: number;
  /** Stat multiplier per cultivation tier */
  CULTIVATION_MULTIPLIER: number;
}

// =============================================================================
// Phase 5: NPC Depth, Time-Based States, and NPC-Equipment
// =============================================================================

/** Personality traits an NPC can possess. */
export type NPCTrait =
  | "aggressive"
  | "timid"
  | "jealous"
  | "generous"
  | "greedy"
  | "loyal"
  | "deceitful"
  | "honest"
  | "flirtatious"
  | "stoic"
  | "empathetic"
  | "vengeful"
  | "cautious"
  | "bold"
  | "proud"
  | "sneaky";

/** A single relationship bond between two NPCs (not MC-centric). */
export interface NPCRelationship {
  /** Name of the other NPC */
  targetName: string;
  /** Disposition toward target: "friendly", "hostile", "neutral", "romantic", "rival", "family" */
  disposition: string;
  /** Bond strength 0-100 */
  strength: number;
  /** Optional aliases for fuzzy matching */
  aliases?: string[];
}

/** Per-NPC profile: traits, thresholds, schedule, and inter-NPC relationships. */
export interface NPCProfile {
  /** Unique NPC identifier (matches Relation.name) */
  npcName: string;
  /** Personality traits */
  traits: NPCTrait[];
  /** Aggression threshold (0-100): below this, the NPC avoids conflict. Above, they escalate. */
  aggressionThreshold: number;
  /** Jealousy threshold (0-100): below this, the NPC tolerates MC's romantic attention. Above, they get jealous. */
  jealousyThreshold: number;
  /** Trust level (0-100) */
  trust: number;
  /** Affection level (0-100) for romantic/social NPCs */
  affection: number;
  /** Loyalty level (0-100): willingness to defend/obey */
  loyalty?: number;
  /** Desire level (0-100): romantic/carnal interest */
  desire?: number;
  /** Known daily schedule: array of "HH:MM activity" entries */
  schedule: string[];
  /** Current location known to the engine */
  knownLocation?: string;
  /**
   * Recent reactions applied to this NPC (turn + reaction type). Used to
   * decay repeated identical reactions so players can't farm or tank stats
   * by spamming the same action.
   */
  recentReactions?: Array<{ turn: number; reaction: string }>;
  /** Inter-NPC relationships */
  relationships: NPCRelationship[];
  /** Equipment / inventory owned by this NPC */
  equipment: NPCEquipment[];
  /** Whether this profile was auto-generated from a Relation */
  autoGenerated?: boolean;
}

/** An equipment slot item owned by an NPC. */
export interface NPCEquipment {
  /** Item name */
  name: string;
  /** Slot it occupies */
  slot: EquipmentSlot;
  /** Rarity */
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  /** Stats bonus */
  stats: EquipmentStats;
  /** Whether it was gifted by the MC */
  giftedBy?: string; // MC name
  /** Date received (ISO string) */
  receivedDate?: string;
}

/** A time-based state with real-time duration, severity, and tick behavior. */
export interface TimeState {
  /** Unique key, e.g. "poison", "drunk", "pregnant" */
  id: string;
  /** Display name */
  name: string;
  /** Attached to which NPC (or "mc" for main character) */
  target: string;
  /** Severity level 0-100 */
  severity: number;
  /** Remaining duration in minutes */
  durationMinutes: number;
  /** Tick interval in minutes (how often severity changes) */
  tickIntervalMinutes: number;
  /** Severity delta per tick (positive = worsens, negative = heals) */
  severityDeltaPerTick: number;
  /** Whether this state has a visible UI indicator */
  showInUI: boolean;
  /** Optional description */
  description?: string;
}

/**
 * Stat-check outcome tiers, from worst to best. The AI declares which stat a
 * challenge tests and how hard it is ([CHECK] tag); the ENGINE rolls the d20,
 * adds the effective stat (+ LCK modifier), compares against the difficulty
 * target, and derives one of these seven outcomes. The outcome drives the
 * chat system line and the momentum applied to the NEXT check on the same
 * stat (consecutive failures make the line harder; successes ease it).
 */
export type CheckOutcome =
  | "critical_failure"
  | "major_failure"
  | "minor_failure"
  | "neutral"
  | "minor_success"
  | "major_success"
  | "critical_success";

/** Per-stat momentum: the last outcome on a line and how many times in a row. */
export interface CheckMomentum {
  outcome: CheckOutcome;
  /** Consecutive checks on this stat with the SAME outcome sign (streak). */
  streak: number;
}

/** One resolved stat check, kept for history/UI. */
export interface CheckRecord {
  /** Turn on which the check resolved. */
  turn: number;
  /** Uppercased stat/subskill name, e.g. "CHA" or "SNEAKING". */
  stat: string;
  /** Difficulty tier used: trivial|easy|moderate|hard|brutal. */
  difficulty: string;
  /** True when the difficulty was inferred by the engine (AI omitted it). */
  inferred?: boolean;
  /** Engine d20 roll. */
  roll: number;
  /** LCK modifier applied to the roll (−2..+2). */
  lckMod: number;
  /** Effective stat (or subskill value) added to the roll. */
  effectiveStat: number;
  /** Final score = roll + lckMod + effectiveStat (what the panel shows). */
  score: number;
  /** Difficulty target AFTER momentum: DIFFICULTY_BASE + momentumMod. */
  target: number;
  /** Outcome derived from roll + stat vs target. */
  outcome: CheckOutcome;
  /** Optional short context the AI attached ("convincing the guard"). */
  context?: string;
  /**
   * True when this check is a FALLBACK: a different-stat recovery attempt
   * declared after the previous check in the same turn ("talk your way out,
   * and if that fails, dodge"). The engine hardens a fallback by
   * FALLBACK_PENALTY when the immediately preceding check FAILED — reacting
   * to a blown plan under pressure is harder than a planned attempt.
   */
  fallback?: boolean;
  /** Target penalty applied because the preceding check failed (+2 base). */
  fallbackMod?: number;
  /**
   * Half the failed primary check's momentum penalty carried into this
   * fallback (only when it lands on a DIFFERENT stat, so the dodge after a
   * blown talk feels like the same pressure, not a fresh roll).
   */
  fallbackInheritedMod?: number;
  /** The failed primary check's stat label, when inheritance applied. */
  fallbackFrom?: string;
  /** Target penalty from a still-armed scene (the NPC drew a weapon). */
  escalationMod?: number;
  /** NPC the scene escalated against (primary name), when armed. */
  escalationNpc?: string;
}

/**
 * Episodic action memory: durable records of what the MC actually DID — with
 * whom, when, and how it went — so the AI can compare current actions against
 * past ones ("this sparring partner is weaker than the one I beat yesterday",
 * "hand-holding is below what we already did"). Persisted in the save, so it
 * survives sessions/restarts where the compressed chat log alone is not
 * enough. Harvested automatically from resolved [CHECK] results, NPC
 * reactions, and gifts, plus explicit [MEMORY] tags.
 */
export type ActionCategory =
  | "combat"
  | "social"
  | "intimacy"
  | "school"
  | "family"
  | "cultivation"
  | "craft"
  | "economy"
  | "adventure"
  | "other";

export interface ActionMemoryEntry {
  /** Unique id (stable across saves so the UI can key entries). */
  id: string;
  /** Short label, e.g. "Sparring with Rook" or "Kissed Lin Mei". */
  summary: string;
  /** NPC involved (primary name), when the action targeted one. */
  npc?: string;
  /** Category so the AI can compare like with like. */
  category: ActionCategory;
  /** 0-100 scale: how intense/significant the action was (comparison aid). */
  intensity: number;
  /** What came of it, e.g. "won (major success)", "Affection +15". */
  outcome?: string;
  /** System/narrative reward, e.g. "+180 points". */
  reward?: string;
  /** In-game timestamp when it happened. */
  time: string;
  /** Turn on which it happened. */
  turn: number;
  /** Optional free-form detail. */
  detail?: string;
}

/**
 * Per-NPC stat-check escalation: a FAILED check against a named hostile NPC
 * arms the scene (the NPC draws a weapon); a later attempt against that same
 * NPC is harder (+2 target per prior failure, capped) and the fiction
 * escalates until a success defuses it. Keyed by lowercased NPC primary name.
 */
export interface CheckEscalation {
  /** NPC primary name this escalation is armed against. */
  npc: string;
  /** Consecutive failed checks against this NPC (not yet defused). */
  failures: number;
  /** Turn the most recent failure happened on (staleness/TTL check). */
  lastFailTurn: number;
  /** Weapon/stakes stage 1..3 (1 = drew a weapon, 2 = brandishing, 3 = ready to strike). */
  stage: number;
}

/**
 * The most recent FAILED check, persisted across turns so a fallback
 * recovery declared on the NEXT turn still inherits half the failed
 * primary's momentum ("the talk blew up yesterday; today's dodge is under
 * the same pressure, not a fresh roll"). Refreshed on each failure,
 * cleared on a success or when a fallback consumes it.
 */
export interface LastFailedCheck {
  /** Uppercased stat key that failed (e.g. "CHA"). */
  stat: string;
  /** Display label (e.g. "CHA"). */
  statLabel: string;
  /** Penalty that failure imparts on its own line (>= 0, streak-aware). */
  imparted: number;
  /** Turn the failure happened on. */
  turn: number;
}

/** A gift interaction log entry. */
export interface GiftLogEntry {
  /** Who gave the gift */
  giver: string;
  /** Who received the gift */
  recipient: string;
  /** Item name */
  itemName: string;
  /** Relationship change applied (e.g. "+15 affection") */
  relationshipChange: string;
  /** Timestamp */
  timestamp: string;
  /** Whether the gift was accepted */
  accepted: boolean;
}

export interface GameState {
  version?: number;
  initialized: boolean;
  setup: SetupState | Record<string, never>;
  char: CharacterState;
  toggles: Toggles;
  subskills: Subskills | Record<string, never>;
  modifiers: Modifiers;
  worldState: WorldState;
  /** Descriptive Scenes: last-known environmental description + ambient conditions per location (lowercase key). */
  sceneLog: SceneLog;
  /** Story-driven season canon set via [SEASON_SHIFT]; overrides the calendar season. */
  seasonOverride?: string;
  memory: Memory;
  quests: Quest[];
  equipped: EquippedItem[];
  currencies: CurrencyEntry[];
  transactionLog: TransactionLog[];
  history: ChatMessage[];
  api: ApiConfig;
  // Phase 4: Stat constants for prompt enforcement
  statConstants: StatConstants;
  // Phase 5: NPC profiles, time states, and gift log
  npcProfiles: NPCProfile[];
  timeStates: TimeState[];
  giftLog: GiftLogEntry[];
  // Director's notes: author-injected world events fed to the AI each turn.
  directorNotes: DirectorNote[];
  // Number of turns executed (drives timed director-note deadlines).
  turnCount: number;
  // Phase 6: Templates, genre system, conditional stats
  templates: SavedTemplate[];
  // Stat-check framework: resolved checks (history) and per-stat momentum.
  checkLog: CheckRecord[];
  checkMomentum: Record<string, CheckMomentum>;
  /** Per-NPC scene escalation (armed NPCs raise the stakes of retries). */
  checkEscalation: Record<string, CheckEscalation>;
  /** Previous turn's failed check, for cross-turn fallback inheritance. */
  lastFailedCheck?: LastFailedCheck | null;
  /** Episodic action memory: what the MC did, with whom, and how it went. */
  actionMemory: ActionMemoryEntry[];
}

// =============================================================================
// Phase 6: Template, Genre, and Conditional Stats types
// =============================================================================

/** A single genre definition used in the genre selector. */
export interface GenreDef {
  id: string;
  label: string;
  hue: string;
  desc: string;
  conflictsWith: string[];
  pairsWell: string[];
  unlocks: string[];
}

/** A saved template for quick world initialization. */
export interface SavedTemplate {
  id: string;
  name: string;
  isBuiltin: boolean;
  createdAt: number;
  activeGenres: string[];
  config: {
    worldSize?: string;
    techStage?: string;
    rules?: string;
    measurement?: string;
    time?: string;
    location?: string;
    mcName?: string;
    mcAppearance?: string;
    mcInventoryJson?: string;
    mcCultivation?: number;
    statStr?: number;
    statAgi?: number;
    statInt?: number;
    statCha?: number;
    statEnd?: number;
    statWil?: number;
    statLck?: number;
    statPer?: number;
    [key: string]: unknown;
  };
}

/** Mechanic metadata for unlocked genre features. */
export interface MechanicMeta {
  label: string;
  icon: string;
  color: string;
}

/** Subskill definition with genre-gating and stat formulas. */
export interface SubSkillDef {
  id: string;
  label: string;
  tab: "combat" | "social" | "craft" | "arcane";
  formula: (stats: { str: number; agi: number; int: number; cha: number; end: number; wil: number; lck: number; per: number; cultivation: number }) => number;
  genres: string[];
}

/** Tab metadata for subskill grouping. */
export interface TabMeta {
  label: string;
  icon: string;
  color: string;
}
