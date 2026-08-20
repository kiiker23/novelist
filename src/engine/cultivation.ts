// =============================================================================
// cultivation.ts — Phase 4: Cultivation breakthrough mechanics and bottleneck handling.
// =============================================================================

import { StateModule } from "../state/state";
import { UIManager } from "../ui/UIManager";
import { CultivationBreakthrough } from "../state/GameState";
import { extractNumber } from "./tag-utils";

/** Predefined breakthrough milestones ordered by cultivation threshold. */
const BREAKTHROUGH_MILESTONES: Omit<CultivationBreakthrough, "achieved">[] = [
  {
    id: "mortal_awakening",
    name: "Mortal Awakening",
    description: "First stirrings of spiritual energy. The body begins to adapt.",
    minCultivation: 0.5,
    statBoost: { str: 1, agi: 1, int: 1, cha: 1 },
    requiredSkills: [],
  },
  {
    id: "qi_gathering",
    name: "Qi Gathering",
    description: "Spiritual energy flows through meridians. Enhanced senses and reflexes.",
    minCultivation: 1.0,
    statBoost: { str: 2, agi: 2, int: 2, cha: 1, healthBonus: 20 },
    requiredSkills: [],
  },
  {
    id: "foundation_establishment",
    name: "Foundation Establishment",
    description: "A solid foundation for cultivation is laid. Cultivation speed doubles.",
    minCultivation: 2.0,
    statBoost: { str: 3, agi: 3, int: 3, cha: 2, healthBonus: 30 },
    requiredSkills: [],
  },
  {
    id: "golden_core",
    name: "Golden Core Formation",
    description: "Cultivation condenses into a Golden Core. Immense power surge.",
    minCultivation: 5.0,
    statBoost: { str: 5, agi: 5, int: 5, cha: 3, healthBonus: 50 },
    requiredSkills: [],
  },
  {
    id: "nascent_soul",
    name: "Nascent Soul",
    description: "A spiritual embryo forms. The soul gains independence from the body.",
    minCultivation: 10.0,
    statBoost: { str: 8, agi: 8, int: 8, cha: 5, healthBonus: 100 },
    requiredSkills: [],
  },
  {
    id: "dao_comprehension",
    name: "Dao Comprehension",
    description: "Understanding of cosmic laws. Reality bends to will.",
    minCultivation: 20.0,
    statBoost: { str: 10, agi: 10, int: 10, cha: 10, healthBonus: 200 },
    requiredSkills: [],
  },
];

export interface BreakthroughResult {
  succeeded: boolean;
  newCultivation: number;
  milestonesAchieved: CultivationBreakthrough[];
  bottleneck: string | null;
}

export const CultivationModule = {
  lastIssues: [] as Array<{ kind: string; error: string }>,

  /** Check if any breakthrough milestones are available and attempt them. */
  checkBreakthroughs(): BreakthroughResult {
    const s = StateModule.state;
    const char = s.char;
    const currentCultivation = char.cultivation;
    const milestonesAchieved: CultivationBreakthrough[] = [];
    let bottleneck: string | null = null;

    for (const milestone of BREAKTHROUGH_MILESTONES) {
      // Skip if already achieved
      const existing = char.breakthroughs.find((b) => b.id === milestone.id);
      if (existing && existing.achieved) continue;

      // Check if cultivation threshold is met
      if (currentCultivation >= milestone.minCultivation) {
        // Check prerequisite skills
        if (milestone.requiredSkills && milestone.requiredSkills.length > 0) {
          const hasAllSkills = milestone.requiredSkills.every((sid) =>
            char.learnedSkills.some((ls) => ls.id === sid && ls.level > 0),
          );
          if (!hasAllSkills) {
            bottleneck = `Missing prerequisite skills for ${milestone.name}`;
            continue;
          }
        }

        // Achieve the breakthrough
        const breakthrough: CultivationBreakthrough = {
          ...milestone,
          achieved: true,
        };
        char.breakthroughs.push(breakthrough);
        milestonesAchieved.push(breakthrough);

        // Apply stat boosts
        for (const [stat, boost] of Object.entries(milestone.statBoost)) {
          if (stat === "healthBonus") {
            char.maxHealth += boost;
            char.health += boost;
          } else if (stat === "str" || stat === "agi" || stat === "int" || stat === "cha") {
            (char as any)[stat] = (char as any)[stat] + boost;
          }
        }
      } else {
        // Not yet eligible — this is the next bottleneck
        bottleneck = `Reach cultivation ${milestone.minCultivation} for "${milestone.name}"`;
        break;
      }
    }

    // Recalculate subskills after stat changes
    StateModule.recalculateSubskills();
    UIManager.renderAllSidebars();

    if (milestonesAchieved.length > 0) {
      UIManager.showBreakthroughNotice(
        milestonesAchieved.map((m) => m.name).join(", "),
      );
    }

    return {
      succeeded: milestonesAchieved.length > 0,
      newCultivation: currentCultivation,
      milestonesAchieved,
      bottleneck,
    };
  },

  /** Update cultivation value and check for breakthroughs. */
  setCultivation(value: number): BreakthroughResult {
    const s = StateModule.state;
    s.char.cultivation = Math.max(0, value);
    return this.checkBreakthroughs();
  },

  /** Get all breakthrough milestones with their achieved status. */
  getBreakthroughStatus(): CultivationBreakthrough[] {
    const s = StateModule.state;
    const char = s.char;
    return BREAKTHROUGH_MILESTONES.map((m) => {
      const existing = char.breakthroughs.find((b) => b.id === m.id);
      return {
        ...m,
        achieved: existing ? existing.achieved : false,
      };
    });
  },

  /** Extract cultivation changes from AI response text. */
  extract(aiText: string): string {
    const issues: Array<{ kind: string; error: string }> = [];

    // Parse [CULTIVATION_CHANGE] tags. Accept loose payloads like "0.5",
    // "+0.5", or markdown-wrapped "**0.5**" (Qwythos habits).
    const cultRegex = /\[CULTIVATION_CHANGE\](.*?)\[\/CULTIVATION_CHANGE\]/gs;
    let match: RegExpExecArray | null;
    while ((match = cultRegex.exec(aiText)) !== null) {
      const delta = extractNumber(match[1]);
      if (delta !== null) {
        const result = this.setCultivation(StateModule.state.char.cultivation + delta);
        if (result.bottleneck && !result.succeeded) {
          // Bottleneck noted but no breakthrough triggered
        }
      }
    }

    CultivationModule.lastIssues = issues;
    if (issues.length > 0) UIManager.showParseNotice(issues);
    return aiText;
  },

  /** Get the next unachieved milestone. */
  getNextMilestone(): CultivationBreakthrough | null {
    const s = StateModule.state;
    const char = s.char;
    for (const milestone of BREAKTHROUGH_MILESTONES) {
      const existing = char.breakthroughs.find((b) => b.id === milestone.id);
      if (!existing || !existing.achieved) {
        return { ...milestone, achieved: existing?.achieved ?? false };
      }
    }
    return null;
  },
};
