// =============================================================================
// skill.ts — Phase 4: Skill tree definitions, effects, and management.
// =============================================================================

import { StateModule } from "../state/state";
import { UIManager } from "../ui/UIManager";
import { GenreModule } from "./genre-system";
import { LearnedSkill, SkillCategory, SkillRarity } from "../state/GameState";
import { SkillUseSchema, SkillTrainSchema } from "../state/schema";
import { safeParseJsonBlock } from "./tag-utils";
import { formatSkillEffectValue } from "./skill-effects";

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// isSkillEffectActive lives in the leaf module skill-effects.ts (imported by
// equipment/vacuum-safety/npc-profile without creating a UIManager cycle);
// re-exported here so existing importers keep working.
export { isSkillEffectActive } from "./skill-effects";

/** Default effect duration in turns when [SKILL_USE] omits it. */
const DEFAULT_SKILL_EFFECT_DURATION = 3;

/** Default XP granted by a [SKILL_TRAIN] session when the tag omits it. */
const DEFAULT_TRAIN_XP = 10;

/**
 * XP required to raise a skill from `level` to `level + 1`: 50 × current
 * level (Lv.1→2 costs 50, Lv.2→3 costs 100, ...). Leveling makes the skill's
 * bonuses stronger (e.g. Charm Aura grants more CHA per level).
 */
export function xpRequiredForLevel(level: number): number {
  return 50 * Math.max(1, level);
}

/**
 * Activation verbs — a learned skill named in prose NEAR one of these counts
 * as the AI using it, so effects land without requiring the tag (or trigger
 * words the player must type). Requires a first-person subject in the same
 * sentence to avoid "She activates her charm aura." buffing the MC.
 */
const SKILL_ACTIVATION_VERBS =
  /\b(?:activ\w*|ignit\w*|channel\w*|release\w*|engage\w*|unleash\w*|trigger\w*|invoke\w*|enact\w*|conjur\w*|flare\w*|kindle\w*|switch\s+on|turn\s+on)\b/i;
const FIRST_PERSON_RE = /\b(?:i|me|my|mine)\b/i;

/**
 * Pre-defined skill trees per category.
 * `genres` follows the SUBSKILLS convention from genre-system.ts:
 * an empty list means the skill is available in every genre; otherwise the
 * skill only appears when at least one listed genre is active.
 */
const DEFAULT_SKILL_TREES: Array<{
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  rarity: SkillRarity;
  genres: string[];
  requiredSkill?: string; // prerequisite skill ID
}> = [
  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------
  { id: "basic_strike", name: "Basic Strike", description: "Fundamental melee attack technique", category: "combat", rarity: "common", genres: [] },
  { id: "iron_skin", name: "Iron Skin", description: "Hardens the body to resist blunt damage", category: "combat", rarity: "uncommon", genres: [] },
  { id: "improvised_weapons", name: "Improvised Weapons", description: "Turn everyday objects into effective weapons", category: "combat", rarity: "common", genres: ["urban", "postapoc", "survival", "thriller", "school"] },
  { id: "firearms_proficiency", name: "Firearms Proficiency", description: "Safe, accurate handling of pistols, rifles, and shotguns", category: "combat", rarity: "uncommon", genres: ["urban", "scifi", "postapoc", "survival", "thriller", "historical"] },
  { id: "tactical_training", name: "Tactical Training", description: "Room clearing, cover usage, and squad awareness", category: "combat", rarity: "rare", genres: ["urban", "scifi", "postapoc", "thriller"], requiredSkill: "firearms_proficiency" },
  { id: "flame_blade", name: "Flame Blade", description: "Infuses weapon with fire energy", category: "combat", rarity: "rare", genres: ["xianxia", "wuxia", "cultivation", "medieval", "darkfantasy", "isekai"] },
  { id: "heavenly_smash", name: "Heavenly Smash", description: "Channel spiritual energy into a devastating strike", category: "combat", rarity: "epic", genres: ["cultivation", "xianxia", "wuxia", "isekai"] },

  // -------------------------------------------------------------------------
  // Cultivation / inner development
  // -------------------------------------------------------------------------
  { id: "meditation_focus", name: "Meditation & Focus", description: "Calm the mind to recover stamina and think clearly under pressure", category: "cultivation", rarity: "common", genres: [] },
  { id: "breathing_technique", name: "Breathing Technique", description: "Basic method to gather and circulate spiritual energy", category: "cultivation", rarity: "common", genres: ["cultivation", "xianxia", "wuxia", "isekai"] },
  { id: "meridian_opening", name: "Meridian Opening", description: "Unblocks spiritual pathways for faster cultivation", category: "cultivation", rarity: "uncommon", genres: ["cultivation", "xianxia", "wuxia"], requiredSkill: "breathing_technique" },
  { id: "spiritual_perception", name: "Spiritual Perception", description: "Sense spiritual energy and aura of others", category: "cultivation", rarity: "rare", genres: ["cultivation", "xianxia", "wuxia", "darkfantasy", "horror", "isekai"] },
  { id: "inner_alchemy", name: "Inner Alchemy", description: "Condense spiritual energy into a core", category: "cultivation", rarity: "epic", genres: ["cultivation", "xianxia"], requiredSkill: "meridian_opening" },

  // -------------------------------------------------------------------------
  // Social
  // -------------------------------------------------------------------------
  { id: "persuasive_speech", name: "Persuasive Speech", description: "Enhance ability to convince and influence others", category: "social", rarity: "common", genres: [] },
  { id: "truth_reading", name: "Truth Reading", description: "Detect lies and read emotional states", category: "social", rarity: "rare", genres: [] },
  { id: "streetwise", name: "Streetwise", description: "Navigate back alleys, gangs, and the urban underworld", category: "social", rarity: "common", genres: ["urban", "thriller", "postapoc", "school"] },
  { id: "etiquette", name: "Etiquette & Protocol", description: "Master formal manners of courts, boardrooms, and high society", category: "social", rarity: "common", genres: ["historical", "medieval", "romance", "school", "urban"] },
  { id: "interrogation", name: "Interrogation", description: "Extract information through pressure, leverage, and psychology", category: "social", rarity: "uncommon", genres: ["thriller", "urban", "scifi", "historical"] },
  { id: "charm_aura", name: "Charm Aura", description: "Radiate an aura that draws others in", category: "social", rarity: "uncommon", genres: ["romance", "harem", "adult", "darkfantasy", "isekai"] },

  // -------------------------------------------------------------------------
  // Crafting / practical skills
  // -------------------------------------------------------------------------
  { id: "field_medicine", name: "Field Medicine", description: "Patch wounds, set bones, and stabilize the injured with limited supplies", category: "crafting", rarity: "common", genres: [] },
  { id: "cooking", name: "Cooking", description: "Prepare satisfying meals from whatever is at hand", category: "crafting", rarity: "common", genres: [] },
  { id: "engineering", name: "Engineering", description: "Repair, jury-rig, and build machines and electronics", category: "crafting", rarity: "uncommon", genres: ["scifi", "urban", "postapoc", "survival", "school"] },
  { id: "herbal_knowledge", name: "Herbal Knowledge", description: "Identify and prepare medicinal herbs", category: "crafting", rarity: "common", genres: ["medieval", "survival", "postapoc", "historical", "xianxia", "wuxia", "darkfantasy", "horror"] },
  { id: "artifact_refinement", name: "Artifact Refinement", description: "Forge and enhance magical items", category: "crafting", rarity: "uncommon", genres: ["xianxia", "cultivation", "wuxia", "medieval", "darkfantasy", "isekai"] },

  // -------------------------------------------------------------------------
  // Stealth
  // -------------------------------------------------------------------------
  { id: "disguise", name: "Disguise", description: "Alter appearance and mannerisms to pass unnoticed", category: "stealth", rarity: "common", genres: [] },
  { id: "urban_stealth", name: "Urban Stealth", description: "Tail targets, slip through crowds, and vanish in the city", category: "stealth", rarity: "common", genres: ["urban", "thriller", "postapoc", "scifi", "school"] },
  { id: "shadow_step", name: "Shadow Step", description: "Move silently and blend into darkness", category: "stealth", rarity: "uncommon", genres: ["darkfantasy", "horror", "xianxia", "wuxia", "cultivation", "isekai"] },
  { id: "vanishing_trick", name: "Vanishing Trick", description: "Temporarily become undetectable", category: "stealth", rarity: "rare", genres: ["darkfantasy", "horror", "isekai", "xianxia"], requiredSkill: "shadow_step" },

  // -------------------------------------------------------------------------
  // Knowledge
  // -------------------------------------------------------------------------
  { id: "survival_instinct", name: "Survival Instinct", description: "Read terrain, weather, and danger before it strikes", category: "knowledge", rarity: "common", genres: ["survival", "postapoc", "horror", "thriller"] },
  { id: "scavenging", name: "Scavenging", description: "Salvage useful parts, food, and gear from ruins", category: "knowledge", rarity: "common", genres: ["postapoc", "survival", "urban"] },
  { id: "driving", name: "Driving", description: "Handle cars, bikes, and trucks under stress", category: "knowledge", rarity: "common", genres: ["urban", "postapoc", "thriller", "survival", "scifi"] },
  { id: "computer_literacy", name: "Computer Literacy", description: "Program, research, and crack everyday systems", category: "knowledge", rarity: "common", genres: ["urban", "scifi", "school", "thriller"] },
  { id: "cyber_interface", name: "Cyber Interface", description: "Jack into networks and command neural-linked hardware", category: "knowledge", rarity: "rare", genres: ["scifi"], requiredSkill: "computer_literacy" },
  { id: "starship_piloting", name: "Starship Piloting", description: "Navigate and pilot spacecraft through hostile voids", category: "knowledge", rarity: "epic", genres: ["scifi"] },
  { id: "ancient_tongue", name: "Ancient Tongue", description: "Read and understand ancient scripts", category: "knowledge", rarity: "common", genres: ["xianxia", "cultivation", "wuxia", "medieval", "darkfantasy", "isekai", "historical"] },
  { id: "runecoding", name: "Runecoding", description: "Decode and create magical runes", category: "knowledge", rarity: "rare", genres: ["xianxia", "cultivation", "darkfantasy", "isekai", "medieval"], requiredSkill: "ancient_tongue" },
];

export const SkillModule = {
  lastIssues: [] as Array<{ kind: string; error: string }>,

  /**
   * Get the full skill tree (pre-defined skills not yet learned), filtered
   * by the active genres. Skills with an empty `genres` list are universal;
   * the rest require at least one matching active genre (same convention
   * as GenreModule.isSubskillAvailable).
   */
  getSkillTree(): typeof DEFAULT_SKILL_TREES {
    const s = StateModule.state;
    const learnedIds = new Set(s.char.learnedSkills.map((sk) => sk.id));
    const activeGenres = GenreModule.getActive();
    return DEFAULT_SKILL_TREES.filter((sk) => {
      if (learnedIds.has(sk.id)) return false;
      if (sk.genres.length === 0) return true;
      return sk.genres.some((g) => activeGenres.includes(g));
    });
  },

  /** Get all learned skills. */
  getLearnedSkills(): LearnedSkill[] {
    const s = StateModule.state;
    return s.char.learnedSkills;
  },

  /** Get skills by category. */
  getSkillsByCategory(category: SkillCategory): LearnedSkill[] {
    return this.getLearnedSkills().filter((s) => s.category === category);
  },

  /** Activate/deactivate a skill. */
  toggleSkill(skillId: string): boolean {
    const s = StateModule.state;
    const skill = s.char.learnedSkills.find((sk) => sk.id === skillId);
    if (!skill) return false;
    skill.active = !skill.active;
    UIManager.renderAllSidebars();
    return true;
  },

  /** Calculate the total stat bonus from all active skills. */
  getSkillBonuses(): Record<string, number> {
    const s = StateModule.state;
    const bonuses: Record<string, number> = {};
    for (const skill of s.char.learnedSkills) {
      if (!skill.active || skill.level === 0) continue;
      // Each skill level grants a small bonus based on rarity
      const rarityMult = { common: 1, uncommon: 1.5, rare: 2, epic: 3, legendary: 5 }[skill.rarity];
      const bonus = skill.level * rarityMult;
      // Distribute bonuses proportionally across stats
      bonuses.str = (bonuses.str || 0) + Math.floor(bonus * 0.3);
      bonuses.agi = (bonuses.agi || 0) + Math.floor(bonus * 0.3);
      bonuses.int = (bonuses.int || 0) + Math.floor(bonus * 0.2);
      bonuses.cha = (bonuses.cha || 0) + Math.floor(bonus * 0.2);
    }
    return bonuses;
  },

  /** Learn a skill from the skill tree using a skill point. */
  learnSkill(skillId: string): boolean {
    const s = StateModule.state;
    if (s.char.skillPoints <= 0) return false;

    const treeEntry = DEFAULT_SKILL_TREES.find((t) => t.id === skillId);
    if (!treeEntry) return false;

    // Check prerequisites
    if (treeEntry.requiredSkill) {
      const hasPrereq = s.char.learnedSkills.some(
        (sk) => sk.id === treeEntry.requiredSkill && sk.level > 0,
      );
      if (!hasPrereq) return false;
    }

    // Check if already learned
    if (s.char.learnedSkills.some((sk) => sk.id === skillId)) return false;

    const newSkill: LearnedSkill = {
      id: treeEntry.id,
      name: treeEntry.name,
      description: treeEntry.description,
      category: treeEntry.category,
      rarity: treeEntry.rarity,
      level: 1,
      xpInvested: 0,
      active: false,
      props: {},
    };

    s.char.learnedSkills.push(newSkill);
    s.char.skillPoints -= 1;

    UIManager.renderAllSidebars();
    UIManager.showSkillLearnNotice(treeEntry.name);
    return true;
  },

  /** Resolve a skill-tree entry by id or name (case-insensitive). */
  findSkillTreeEntry(
    ref: string,
  ): (typeof DEFAULT_SKILL_TREES)[number] | null {
    const q = (ref || "").trim().toLowerCase();
    if (!q) return null;
    return (
      DEFAULT_SKILL_TREES.find((sk) => sk.id.toLowerCase() === q) ||
      DEFAULT_SKILL_TREES.find((sk) => sk.name.toLowerCase() === q) ||
      null
    );
  },

  /** True when the MC has learned the skill. */
  hasLearnedSkill(skillId: string): boolean {
    return StateModule.state.char.learnedSkills.some(
      (sk) => sk.id.toLowerCase() === skillId.toLowerCase(),
    );
  },

  /**
   * Grant training XP to a learned skill (resolved by id or name). XP
   * accumulates in xpInvested and ranks the skill up when it crosses the
   * threshold, carrying surplus over. Returns what happened so callers can
   * surface level-up moments.
   */
  trainSkill(
    ref: string,
    xp: number,
  ): { trained: boolean; leveledUp: boolean; newLevel?: number; error?: string } {
    const treeEntry = this.findSkillTreeEntry(ref);
    if (!treeEntry) {
      return { trained: false, leveledUp: false, error: `Unknown skill: ${ref}` };
    }
    const skill = StateModule.state.char.learnedSkills.find(
      (sk) => sk.id === treeEntry.id,
    );
    if (!skill) {
      return {
        trained: false,
        leveledUp: false,
        error: `Cannot train unlearned skill '${treeEntry.name}' — learn it first`,
      };
    }

    skill.xpInvested = (skill.xpInvested || 0) + Math.max(1, Math.round(xp));
    let leveledUp = false;
    while (skill.xpInvested >= xpRequiredForLevel(skill.level)) {
      skill.xpInvested -= xpRequiredForLevel(skill.level);
      skill.level += 1;
      leveledUp = true;
    }

    UIManager.renderAllSidebars();
    if (leveledUp) {
      UIManager.showSkillLearnNotice(`${skill.name} reached Lv.${skill.level}!`);
    }
    return { trained: true, leveledUp, newLevel: skill.level };
  },

  /**
   * Write a skill's effect into Active Modifiers / Artifact State
   * (state.modifiers) — the same object the AI reports and the sidebar
   * renders. Re-applying replaces the entry.
   */
  applySkillUse(
    treeEntry: (typeof DEFAULT_SKILL_TREES)[number],
    effect: string,
    duration: number,
  ): void {
    // The value carries its remaining/total duration (e.g. "active (5t/5t,
    // 50m/50m): ...") so the sidebar can render a progress indicator and
    // the remaining time ticks down each turn (see tickSkillEffects).
    StateModule.state.modifiers[treeEntry.id] = formatSkillEffectValue(duration, effect);
  },

  /**
   * Prose fallback: when the AI activates a learned skill narratively
   * ("I activate my Charm Aura.") without emitting [SKILL_USE], record the
   * effect anyway. First-person subject + skill name + activation verb in the
   * same sentence; never overrides an entry the tag (or [STATE_UPDATE])
   * already wrote this turn.
   */
  applySkillUseFromProse(text: string): number {
    const s = StateModule.state;
    let applied = 0;
    for (const sentence of (text || "").split(/(?<=[.!?])\s+/)) {
      if (!FIRST_PERSON_RE.test(sentence)) continue;
      if (!SKILL_ACTIVATION_VERBS.test(sentence)) continue;
      for (const sk of s.char.learnedSkills) {
        if (s.modifiers[sk.id]) continue; // already recorded this turn
        if (!new RegExp(`\\b${escapeRegExp(sk.name)}\\b`, "i").test(sentence)) {
          continue;
        }
        const treeEntry = this.findSkillTreeEntry(sk.name);
        if (!treeEntry) continue;
        this.applySkillUse(treeEntry, treeEntry.description, DEFAULT_SKILL_EFFECT_DURATION);
        applied++;
      }
    }
    return applied;
  },

  /** Extract skill unlocks and skill activations from AI response text. */
  extract(aiText: string): string {
    const issues: Array<{ kind: string; error: string }> = [];

    // Parse [SKILL_UNLOCK] tags from AI (auto-unlock without skill point cost)
    const unlockRegex = /\[SKILL_UNLOCK\](.*?)\[\/SKILL_UNLOCK\]/gs;
    let match: RegExpExecArray | null;
    while ((match = unlockRegex.exec(aiText)) !== null) {
      const raw = match[1].trim();
      const parts = raw.split(":");
      if (parts.length >= 4) {
        const skill: LearnedSkill = {
          id: parts[0].trim(),
          name: parts[1].trim(),
          description: parts.slice(3).join(":").trim(),
          category: (["combat", "cultivation", "social", "crafting", "stealth", "knowledge"].includes(parts[2].trim())
            ? parts[2].trim()
            : "knowledge") as SkillCategory,
          rarity: (["common", "uncommon", "rare", "epic", "legendary"].includes(parts[3].trim())
            ? parts[3].trim()
            : "common") as SkillRarity,
          level: 1,
          xpInvested: 0,
          active: false,
          props: {},
        };
        StateModule.state.char.learnedSkills.push(skill);
      } else {
        issues.push({ kind: "SKILL", error: `Malformed skill unlock: ${raw}` });
      }
    }

    // Parse [SKILL_TRAIN] tags — practicing a LEARNED skill grants XP toward
    // its next level; ranking up strengthens the skill's bonuses (e.g. a
    // higher-level Charm Aura grants more CHA). Unlearned skills are rejected.
    const trainRegex = /\[SKILL_TRAIN\](.*?)\[\/SKILL_TRAIN\]/gs;
    let trainMatch: RegExpExecArray | null;
    while ((trainMatch = trainRegex.exec(aiText)) !== null) {
      const raw = trainMatch[1].trim();
      if (!raw) continue;
      const parsed = safeParseJsonBlock(SkillTrainSchema, raw);
      if (!parsed.ok || !parsed.data) {
        issues.push({ kind: "SKILL", error: `Malformed skill train: ${raw}` });
        continue;
      }
      const result = this.trainSkill(
        parsed.data.skill,
        parsed.data.xp ?? DEFAULT_TRAIN_XP,
      );
      if (result.error) {
        issues.push({ kind: "SKILL", error: result.error });
      }
    }

    // Parse [SKILL_USE] tags — using a LEARNED skill writes its effect into
    // Active Modifiers / Artifact State (state.modifiers). Unlearned skills
    // are rejected so the AI can't grant itself powers.
    const useRegex = /\[SKILL_USE\](.*?)\[\/SKILL_USE\]/gs;
    let useMatch: RegExpExecArray | null;
    while ((useMatch = useRegex.exec(aiText)) !== null) {
      const raw = useMatch[1].trim();
      if (!raw) continue;
      const parsed = safeParseJsonBlock(SkillUseSchema, raw);
      if (!parsed.ok || !parsed.data) {
        issues.push({ kind: "SKILL", error: `Malformed skill use: ${raw}` });
        continue;
      }
      const treeEntry = this.findSkillTreeEntry(parsed.data.skill);
      if (!treeEntry) {
        issues.push({ kind: "SKILL", error: `Unknown skill: ${parsed.data.skill}` });
        continue;
      }
      if (!this.hasLearnedSkill(treeEntry.id)) {
        issues.push({
          kind: "SKILL",
          error: `Cannot use unlearned skill '${treeEntry.name}' — learn it first`,
        });
        continue;
      }
      this.applySkillUse(
        treeEntry,
        parsed.data.effect || treeEntry.description,
        parsed.data.duration ?? DEFAULT_SKILL_EFFECT_DURATION,
      );
    }

    // Prose fallback — no trigger words required: "I activate my Charm Aura."
    this.applySkillUseFromProse(aiText);

    SkillModule.lastIssues = issues;
    if (issues.length > 0) UIManager.showParseNotice(issues);
    UIManager.renderAllSidebars();
    return aiText;
  },

  /** Get category display info. */
  getCategoryInfo(category: SkillCategory): { icon: string; label: string; color: string } {
    const info: Record<SkillCategory, { icon: string; label: string; color: string }> = {
      combat: { icon: "fa-swords", label: "Combat", color: "text-red-400" },
      cultivation: { icon: "fa-star", label: "Cultivation", color: "text-emerald-400" },
      social: { icon: "fa-comments", label: "Social", color: "text-blue-400" },
      crafting: { icon: "fa-hammer", label: "Crafting", color: "text-amber-400" },
      stealth: { icon: "fa-user-secret", label: "Stealth", color: "text-purple-400" },
      knowledge: { icon: "fa-book", label: "Knowledge", color: "text-cyan-400" },
    };
    return info[category];
  },
};
