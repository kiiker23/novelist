// =============================================================================
// schema.ts — Zod schemas for validating AI output and imported saves.
//
// Phase 1: STATE_UPDATE, RELATION validation.
// Phase 3: Quest, Equipment, Currency, Transaction schemas.
// =============================================================================

import { z } from "zod";

/** A JSON-serializable scalar the AI may place in props/modifiers bags. */
const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

export const InventoryItemSchema = z.object({
  name: z.string(),
  desc: z.string().default(""),
  qty: z.number().default(1),
  props: z.record(ScalarSchema).default({}),
});

/** Shape the AI is asked to emit inside a [STATE_UPDATE] block. */
export const StateUpdateSchema = z
  .object({
    health: z.number().optional(),
    fatigue: z.number().optional(),
    str: z.number().optional(),
    agi: z.number().optional(),
    int: z.number().optional(),
    cha: z.number().optional(),
    cultivation: z.number().optional(),
    systemPoints: z.number().optional(),
    xp: z.number().optional(),
    level: z.number().optional(),
    skillPoints: z.number().optional(),
    time: z.string().optional(),
    location: z.string().optional(),
    inventory: z.array(InventoryItemSchema).optional(),
    modifiers: z.record(ScalarSchema).optional(),
    // Currency balances (USD, gold, copper, …) the AI can move directly in the
    // state block; merged by name, amounts replaced, other props preserved.
    currencies: z
      .array(
        z
          .object({
            name: z.string(),
            amount: z.coerce.number(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type StateUpdate = z.infer<typeof StateUpdateSchema>;

/** Relation modifier. Accepts either a full object or a bare string like "Drunk(3)". */
export const RelationModifierSchema = z.union([
  z.object({
    name: z.string(),
    duration: z.coerce.number().default(4),
  }),
  z.string().transform((raw) => {
    const m = raw.trim().match(/^(.*?)\((\d+)\)$/);
    if (m) return { name: m[1].trim(), duration: parseInt(m[2], 10) };
    return { name: raw.trim(), duration: 4 };
  }),
]);

export type RelationModifier = z.infer<typeof RelationModifierSchema>;

/** Structured relation UPDATE the AI emits inside [RELATION]{...}[/RELATION]. */
export const RelationUpdateSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  disposition: z.string().optional(),
  status: z
    .string()
    .transform((s) => (/dead|deceased|killed|slain/i.test(s) ? "Deceased" : "Alive"))
    .pipe(z.enum(["Alive", "Deceased"]))
    .optional(),
  modifiers: z.array(RelationModifierSchema).optional(),
});

export type RelationUpdate = z.infer<typeof RelationUpdateSchema>;

/** Full persisted relation record. */
export const RelationSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  disposition: z.string().default(""),
  status: z.enum(["Alive", "Deceased"]).default("Alive"),
  modifiers: z
    .array(z.object({ name: z.string(), duration: z.number() }))
    .default([]),
});

export const FactBundleSchema = z.object({
  title: z.string(),
  entries: z.array(z.string()),
});

// =============================================================================
// Phase 3+ schemas
// =============================================================================

export const QuestObjectiveSchema = z.object({
  description: z.string(),
  completed: z.boolean().default(false),
});

export const QuestSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  type: z.enum(["main", "side", "daily", "hidden"]).default("side"),
  status: z.enum(["active", "completed", "failed"]).default("active"),
  objectives: z.array(QuestObjectiveSchema).default([]),
  reward: z.string().default(""),
  assignedBy: z.string().optional(),
  acceptedAt: z.string().optional(),
  completedAt: z.string().optional(),
});

export type Quest = z.infer<typeof QuestSchema>;

export const EquipmentStatsSchema = z.record(z.number().optional()).default({});

export const EquippedItemSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  slot: z.enum([
    "head", "neck", "chest", "arms", "hands", "legs", "feet",
    "weapon", "offhand", "ring", "belt", "back", "trinket",
  ]),
  rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).default("common"),
  stats: EquipmentStatsSchema,
  desc: z.string(),
  equipped: z.boolean().default(false),
});

export type EquippedItem = z.infer<typeof EquippedItemSchema>;

export const CurrencyEntrySchema = z.object({
  name: z.string(),
  amount: z.coerce.number().default(0),
  props: z.record(ScalarSchema).default({}),
});

export type CurrencyEntry = z.infer<typeof CurrencyEntrySchema>;

export const ShopOfferingSchema = z.object({
  name: z.string(),
  price: z.number(),
  currency: z.string(),
  stock: z.number().default(99),
  description: z.string().default(""),
});

export type ShopOffering = z.infer<typeof ShopOfferingSchema>;

export const TransactionLogSchema = z.object({
  id: z.string(),
  type: z.enum(["buy", "sell", "reward", "fine"]),
  itemName: z.string(),
  amount: z.number(),
  currency: z.string(),
  timestamp: z.string(),
  partner: z.string().optional(),
});

export type TransactionLog = z.infer<typeof TransactionLogSchema>;

// =============================================================================
// Phase 4: XP, Skill, Cultivation schemas
// =============================================================================

export const LearnedSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(["combat", "cultivation", "social", "crafting", "stealth", "knowledge"]).default("knowledge"),
  rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).default("common"),
  level: z.number().int().min(0).max(10).default(0),
  xpInvested: z.number().default(0),
  active: z.boolean().default(false),
  props: z.record(ScalarSchema).default({}),
});

export type LearnedSkill = z.infer<typeof LearnedSkillSchema>;

/** [SKILL_USE] — activating a learned skill writes its effect into Active Modifiers. */
export const SkillUseSchema = z.object({
  /** Skill id or name, matched case-insensitively against the skill tree. */
  skill: z.string().min(1),
  /** What the effect does (defaults to the skill's description). */
  effect: z.string().optional(),
  /** Effect duration in turns (default 3). */
  duration: z.number().int().positive().max(30).optional(),
});

export type SkillUse = z.infer<typeof SkillUseSchema>;

/** [SKILL_TRAIN] — practicing a learned skill grants XP toward its next level. */
export const SkillTrainSchema = z.object({
  /** Skill id or name, matched case-insensitively against the skill tree. */
  skill: z.string().min(1),
  /** XP gained from this training session (default 10). */
  xp: z.number().int().positive().optional(),
});

export type SkillTrain = z.infer<typeof SkillTrainSchema>;

export const CultivationBreakthroughSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  minCultivation: z.number(),
  statBoost: z.record(z.number()).default({}),
  achieved: z.boolean().default(false),
  requiredSkills: z.array(z.string()).optional(),
});

export type CultivationBreakthrough = z.infer<typeof CultivationBreakthroughSchema>;

export const XpTableEntrySchema = z.object({
  level: z.number().int(),
  cumulativeXp: z.number(),
});

export type XpTableEntry = z.infer<typeof XpTableEntrySchema>;

/** Stat constants schema for validation. */
export const StatConstantsSchema = z.object({
  MIN_HUMAN_STAT: z.number(),
  MAX_HUMAN_STAT: z.number(),
  DEFAULT_HUMAN_STAT: z.number(),
  DEFAULT_CULTIVATION: z.number(),
  CULTIVATION_MULTIPLIER: z.number(),
});

export type StatConstants = z.infer<typeof StatConstantsSchema>;

// =============================================================================
// Phase 5: NPC Profile, Time State, NPC Equipment, Gift schemas
// =============================================================================

export const NPCTraitSchema = z.enum([
  "aggressive", "timid", "jealous", "generous", "greedy",
  "loyal", "deceitful", "honest", "flirtatious", "stoic",
  "empathetic", "vengeful", "cautious", "bold", "proud",
]);

export type NPCTrait = z.infer<typeof NPCTraitSchema>;

export const NPCRelationshipSchema = z.object({
  targetName: z.string().min(1),
  disposition: z.string().default("neutral"),
  strength: z.number().min(0).max(100).default(50),
  aliases: z.array(z.string()).default([]),
});

export type NPCRelationship = z.infer<typeof NPCRelationshipSchema>;

export const NPCEquipmentSchema = z.object({
  name: z.string(),
  slot: z.enum([
    "head", "neck", "chest", "arms", "hands", "legs", "feet",
    "weapon", "offhand", "ring", "belt", "back", "trinket",
  ]).default("trinket"),
  rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).default("common"),
  stats: EquipmentStatsSchema,
  giftedBy: z.string().optional(),
  receivedDate: z.string().optional(),
});

export type NPCEquipment = z.infer<typeof NPCEquipmentSchema>;

export const TimeStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  target: z.string(),
  severity: z.number().min(0).max(100).default(0),
  durationMinutes: z.number().min(0).default(60),
  tickIntervalMinutes: z.number().min(1).default(10),
  severityDeltaPerTick: z.number().default(0),
  showInUI: z.boolean().default(true),
  description: z.string().optional(),
});

export type TimeState = z.infer<typeof TimeStateSchema>;

export const NPCGiftSchema = z.object({
  npcName: z.string().min(1),
  item: NPCEquipmentSchema,
});

export const GiftLogEntrySchema = z.object({
  giver: z.string(),
  recipient: z.string(),
  itemName: z.string(),
  relationshipChange: z.string(),
  timestamp: z.string(),
  accepted: z.boolean().default(true),
});

export type GiftLogEntry = z.infer<typeof GiftLogEntrySchema>;

export const NPCProfileSchema = z.object({
  npcName: z.string().min(1),
  traits: z.array(NPCTraitSchema).default([]),
  aggressionThreshold: z.number().min(0).max(100).default(50),
  jealousyThreshold: z.number().min(0).max(100).default(50),
  trust: z.number().min(0).max(100).default(50),
  affection: z.number().min(0).max(100).default(50),
  schedule: z.array(z.string()).default([]),
  knownLocation: z.string().optional(),
  relationships: z.array(NPCRelationshipSchema).default([]),
  equipment: z.array(NPCEquipmentSchema).default([]),
  autoGenerated: z.boolean().default(false),
});

export type NPCProfile = z.infer<typeof NPCProfileSchema>;

// -----------------------------------------------------------------------------
// Safe-parse helpers
// -----------------------------------------------------------------------------

export interface SafeParseResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Parse a JSON string then validate against a schema. Never throws. */
export function safeParseJson<S extends z.ZodTypeAny>(
  schema: S,
  jsonStr: string,
): SafeParseResult<z.output<S>> {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonStr);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.message).join("; ") };
  }
  return { ok: true, data: result.data as z.output<S> };
}

// =============================================================================
// Phase 6: Template, Genre, SubSkill schemas
// =============================================================================

export const GenreDefSchema = z.object({
  id: z.string(),
  label: z.string(),
  hue: z.string(),
  desc: z.string(),
  conflictsWith: z.array(z.string()),
  pairsWell: z.array(z.string()),
  unlocks: z.array(z.string()),
});

export type GenreDef = z.infer<typeof GenreDefSchema>;

export const SavedTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  isBuiltin: z.boolean(),
  createdAt: z.number(),
  activeGenres: z.array(z.string()),
  config: z.record(z.unknown()),
});

export type SavedTemplate = z.infer<typeof SavedTemplateSchema>;

export const MechanicMetaSchema = z.object({
  label: z.string(),
  icon: z.string(),
  color: z.string(),
});

export type MechanicMeta = z.infer<typeof MechanicMetaSchema>;
