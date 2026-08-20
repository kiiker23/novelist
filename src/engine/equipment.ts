// =============================================================================
// equipment.ts - Slot-based equipment system with stat bonuses.
// =============================================================================

import { EquippedItem } from "../state/GameState";
import { EquippedItemSchema } from "../state/schema";
import { StateModule } from "../state/state";
import { UIManager } from "../ui/UIManager";
import { safeParseJsonBlock } from "./tag-utils";
import { getSkillEffectStatBonuses } from "./skill-effects";

function parseEquipmentBlock(block: string): EquippedItem | null {
  const parsed = safeParseJsonBlock(EquippedItemSchema, block);
  if (!parsed.ok || !parsed.data) return null;
  return parsed.data;
}

function equipItem(item: EquippedItem): void {
  const equipped = StateModule.state.equipped || [];
  const existingIdx = equipped.findIndex(function(e: EquippedItem) { return e.slot === item.slot; });
  if (existingIdx >= 0) {
    equipped[existingIdx].equipped = false;
  }
  const newItem = { ...item, equipped: true };
  if (existingIdx >= 0) {
    equipped[existingIdx] = newItem;
  } else {
    equipped.push(newItem);
  }
  StateModule.state.equipped = equipped;
}

function getTotalEquipmentBonuses(): Record<string, number> {
  const equipped = StateModule.state.equipped || [];
  const totals: Record<string, number> = {};
  for (const item of equipped) {
    if (!item.equipped || !item.stats) continue;
    for (const key of Object.keys(item.stats)) {
      const val = item.stats[key];
      if (val !== undefined) {
        totals[key] = (totals[key] || 0) + val;
      }
    }
  }
  return totals;
}

/**
 * Effective stats = cultivation-scaled base stats PLUS flat equipped bonuses
 * PLUS active skill effects' declared stat bonuses (flat and % of base):
 * floor(base * (1 + 0.2 * cultivation)) + gear + skill effect. An active
 * Charm Aura that declares no numeric CHA in its effect text falls back to
 * the level-scaled bonus. This is the number the stat-check pipeline feeds
 * the AI, so equipped gear and active skill effects genuinely raise the MC's
 * effective stats. Shared by the system prompt, the per-turn state reminder,
 * the UI stat panel, and the subskill recalculation so they never disagree.
 */
export function getEffectiveStats(): Record<"str" | "agi" | "int" | "cha", number> {
  const s = StateModule.state;
  const mult = 1 + s.char.cultivation * 0.2;
  const bonuses = getTotalEquipmentBonuses();
  const skill = getSkillEffectStatBonuses();
  const eff = (base: number, bonus: number | undefined, flat: number, percent: number) =>
    Math.floor(base * mult) + (bonus || 0) + flat + Math.floor(base * percent);
  return {
    str: eff(s.char.str, bonuses.str, skill.flat.str, skill.percent.str),
    agi: eff(s.char.agi, bonuses.agi, skill.flat.agi, skill.percent.agi),
    int: eff(s.char.int, bonuses.int, skill.flat.int, skill.percent.int),
    cha: eff(s.char.cha, bonuses.cha, skill.flat.cha, skill.percent.cha),
  };
}

export const EquipmentModule = {
  lastIssues: [] as Array<{ kind: string; error: string }>,

  extract(aiText: string): string {
    const issues: Array<{ kind: string; error: string }> = [];
    const eqRegex = /\[EQUIPMENT\](.*?)\[\/EQUIPMENT\]/gs;
    let match: RegExpExecArray | null;
    while ((match = eqRegex.exec(aiText)) !== null) {
      const item = parseEquipmentBlock(match[1]);
      if (item) equipItem(item);
      else issues.push({ kind: "EQUIPMENT", error: "Failed to parse equipment block" });
    }
    EquipmentModule.lastIssues = issues;
    if (issues.length > 0) UIManager.showParseNotice(issues);
    UIManager.renderEquipmentPanel();
    return aiText;
  },

  getBonuses(): Record<string, number> {
    return getTotalEquipmentBonuses();
  },

  getEquippedBySlot(): Record<string, EquippedItem | null> {
    const equipped = StateModule.state.equipped || [];
    var slots: Record<string, EquippedItem | null> = {
      head: null, neck: null, chest: null, arms: null, hands: null,
      legs: null, feet: null, weapon: null, offhand: null,
      ring: null, belt: null, back: null, trinket: null,
    };
    for (const item of equipped) {
      if (item.equipped) {
        slots[item.slot] = item;
      }
    }
    return slots;
  },

  unequip(slot: string): void {
    const equipped = StateModule.state.equipped || [];
    const idx = equipped.findIndex(function(e: EquippedItem) { return e.slot === slot; });
    if (idx >= 0) {
      equipped[idx].equipped = false;
    }
    UIManager.renderEquipmentPanel();
  },

  getRarityClass(rarity: string): string {
    var classes: Record<string, string> = {
      common: "text-slate-400",
      uncommon: "text-green-400",
      rare: "text-blue-400",
      epic: "text-purple-400",
      legendary: "text-amber-400",
    };
    return classes[rarity] || "text-slate-400";
  },
};
