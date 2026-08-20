// =============================================================================
// xp.ts — Phase 4: XP/Leveling system with skill point allocation.
// =============================================================================

import { StateModule } from "../state/state";
import { UIManager } from "../ui/UIManager";
import { extractNumber } from "./tag-utils";

/** XP thresholds per level (cumulative). Designed for slow early-game progression. */
const XP_TABLE: Array<{ level: number; cumulativeXp: number }> = [
  { level: 1, cumulativeXp: 0 },
  { level: 2, cumulativeXp: 100 },
  { level: 3, cumulativeXp: 250 },
  { level: 4, cumulativeXp: 500 },
  { level: 5, cumulativeXp: 900 },
  { level: 6, cumulativeXp: 1500 },
  { level: 7, cumulativeXp: 2300 },
  { level: 8, cumulativeXp: 3400 },
  { level: 9, cumulativeXp: 4800 },
  { level: 10, cumulativeXp: 6500 },
  { level: 11, cumulativeXp: 8500 },
  { level: 12, cumulativeXp: 11000 },
  { level: 13, cumulativeXp: 14000 },
  { level: 14, cumulativeXp: 17500 },
  { level: 15, cumulativeXp: 22000 },
  { level: 16, cumulativeXp: 27500 },
  { level: 17, cumulativeXp: 34000 },
  { level: 18, cumulativeXp: 42000 },
  { level: 19, cumulativeXp: 52000 },
  { level: 20, cumulativeXp: 65000 },
];

/** Max level before cultivation is required to go further. */
const MAX_MORTAL_LEVEL = 20;

/** XP awarded per level milestone. */
const SKILL_POINTS_PER_LEVEL = 1;

export interface XpGainResult {
  xpGained: number;
  leveledUp: boolean;
  newLevel: number;
  skillPointsEarned: number;
}

export function getXpForLevel(level: number): number {
  if (level <= 1) return 0;
  const idx = level - 1;
  if (idx >= XP_TABLE.length) return XP_TABLE[XP_TABLE.length - 1].cumulativeXp * 2;
  return XP_TABLE[idx].cumulativeXp;
}

export function getCurrentLevel(xp: number): number {
  let lvl = 1;
  for (let i = XP_TABLE.length - 1; i >= 0; i--) {
    if (xp >= XP_TABLE[i].cumulativeXp) {
      lvl = XP_TABLE[i].level;
      break;
    }
  }
  return lvl;
}

export function getNextLevelThreshold(currentLevel: number): number {
  const nextLvl = currentLevel + 1;
  return getXpForLevel(nextLvl);
}

export const XpModule = {
  lastIssues: [] as Array<{ kind: string; error: string }>,

  /** Award XP to the MC. Handles leveling up and skill point grants. */
  awardXp(amount: number): XpGainResult {
    const s = StateModule.state;
    const char = s.char;
    const oldLevel = char.level;
    char.xp = Math.max(0, char.xp + amount);

    const newLevel = getCurrentLevel(char.xp);
    const leveledUp = newLevel > oldLevel;
    const skillPointsEarned = leveledUp ? SKILL_POINTS_PER_LEVEL * (newLevel - oldLevel) : 0;

    if (leveledUp) {
      char.level = newLevel;
      char.skillPoints += skillPointsEarned;

      // Small HP restore on level up
      char.health = Math.min(char.maxHealth, char.health + Math.floor(char.maxHealth * 0.1));
    }

    UIManager.renderAllSidebars();
    if (leveledUp) {
      UIManager.showLevelUpNotice(newLevel, skillPointsEarned);
    }

    return {
      xpGained: amount,
      leveledUp,
      newLevel,
      skillPointsEarned,
    };
  },

  /** Spend a skill point to learn/unlock a skill. */
  spendSkillPoint(skillId: string): boolean {
    const s = StateModule.state;
    const char = s.char;
    if (char.skillPoints <= 0) return false;

    const existing = char.learnedSkills.find((sk) => sk.id === skillId);
    if (existing) {
      // Train existing skill
      if (existing.level >= 10) return false;
      existing.level += 1;
      existing.xpInvested += 50;
      char.skillPoints -= 1;
    } else {
      // Learn new skill (basic info provided by AI via [SKILL] tag)
      // The skill must have been pre-registered via lore parser
      char.skillPoints -= 1;
    }

    UIManager.renderAllSidebars();
    return true;
  },

  /** Calculate XP progress bar percentage (0-100). */
  getXpProgress(): number {
    const s = StateModule.state;
    const char = s.char;
    const currentThreshold = getXpForLevel(char.level);
    const nextThreshold = getNextLevelThreshold(char.level);
    const range = nextThreshold - currentThreshold;
    if (range <= 0) return 100;
    const progress = char.xp - currentThreshold;
    return Math.min(100, Math.max(0, (progress / range) * 100));
  },

  /** Get current level and XP info for the UI. */
  getLevelInfo(): { current: number; xp: number; nextLevel: number; nextThreshold: number; progress: number } {
    const s = StateModule.state;
    const char = s.char;
    return {
      current: char.level,
      xp: char.xp,
      nextLevel: char.level + 1,
      nextThreshold: getNextLevelThreshold(char.level),
      progress: this.getXpProgress(),
    };
  },

  /** Check if the character has reached the mortal cap. */
  isMortalCapReached(): boolean {
    const s = StateModule.state;
    return s.char.level >= MAX_MORTAL_LEVEL;
  },

  /** Extract XP gains from AI response text. */
  extract(aiText: string): string {
    const issues: Array<{ kind: string; error: string }> = [];

    // Parse [XP_GAIN] tags from AI. Accept loose payloads like "50", "+50",
    // "50 XP", or markdown-wrapped "**50**" (Qwythos habits).
    const xpRegex = /\[XP_GAIN\](.*?)\[\/XP_GAIN\]/gs;
    let match: RegExpExecArray | null;
    while ((match = xpRegex.exec(aiText)) !== null) {
      const amount = extractNumber(match[1]);
      if (amount !== null && amount > 0) {
        this.awardXp(Math.round(amount));
      }
    }

    // Parse [SKILL_LEARNED] tags
    const skillRegex = /\[SKILL_LEARNED\](.*?)\[\/SKILL_LEARNED\]/gs;
    while ((match = skillRegex.exec(aiText)) !== null) {
      const raw = match[1].trim();
      // Simple format: "skillId:Skill Name:category:rarity:description"
      const parts = raw.split(":");
      if (parts.length >= 5) {
        const s = StateModule.state;
        const skill = {
          id: parts[0].trim(),
          name: parts[1].trim(),
          description: parts.slice(4).join(":").trim(),
          category: (["combat", "cultivation", "social", "crafting", "stealth", "knowledge"].includes(parts[2].trim())
            ? parts[2].trim()
            : "knowledge") as typeof s.char.learnedSkills[0]["category"],
          rarity: (["common", "uncommon", "rare", "epic", "legendary"].includes(parts[3].trim())
            ? parts[3].trim()
            : "common") as typeof s.char.learnedSkills[0]["rarity"],
          level: 0,
          xpInvested: 0,
          active: false,
          props: {},
        };
        s.char.learnedSkills.push(skill);
      } else {
        issues.push({ kind: "SKILL", error: `Malformed skill tag: ${raw}` });
      }
    }

    XpModule.lastIssues = issues;
    if (issues.length > 0) UIManager.showParseNotice(issues);
    UIManager.renderAllSidebars();
    return aiText;
  },
};
