// =============================================================================
// gifts.ts — Phase 5: Gift parsing, relationship impact, gift log.
// =============================================================================

import { StateModule } from "../state/state";
import { GiftLogEntry, NPCEquipment } from "../state/GameState";
import { GiftLogEntrySchema, NPCGiftSchema, NPCEquipmentSchema } from "../state/schema";
import { safeParseJson } from "../state/schema";
import { NPCProfileModule } from "./npc-profile";
import { safeParseJsonBlock, unwrapJsonBlock } from "./tag-utils";

export const GiftModule = {
  /**
   * Parse [GIFT] tags from AI output.
   * Format: [GIFT]{"giver":"MC","recipient":"npc_name","itemName":"Rose Bouquet","relationshipChange":"+20 affection","accepted":true}[/GIFT]
   * Returns true if any gift was logged (caller should re-render).
   */
  extract(aiText: string): boolean {
    const s = StateModule.state;
    if (!s.toggles.npcDepth) return false;

    let changed = false;
    const giftRegex = /\[GIFT\](.*?)\[\/GIFT\]/gs;
    let match: RegExpExecArray | null;

    while ((match = giftRegex.exec(aiText)) !== null) {
      const jsonStr = match[1].trim();
      if (!jsonStr) continue;

      const parsed = safeParseJsonBlock(GiftLogEntrySchema, jsonStr);
      if (!parsed.ok || !parsed.data) {
        console.warn("Skipped invalid GIFT:", parsed.error, jsonStr);
        continue;
      }

      this.logGift(parsed.data);
      changed = true;
    }
    return changed;
  },

  /**
   * Log a gift interaction and apply relationship changes.
   */
  logGift(entry: GiftLogEntry): void {
    const s = StateModule.state;

    // Add to gift log
    s.giftLog.push(entry);

    // Apply relationship changes to NPC profile
    if (entry.accepted && entry.recipient !== "mc") {
      // Capture the digits separately from the sign — with a single group the
      // parsed delta was parseInt("+" + undefined) = NaN, silently breaking
      // every explicit "+N affection" / "-N trust" gift.
      const affectionMatch = entry.relationshipChange.match(/(\+|-)(\d+)\s*affection/i);
      const trustMatch = entry.relationshipChange.match(/(\+|-)(\d+)\s*trust/i);

      if (affectionMatch) {
        const delta = parseInt(affectionMatch[1] + affectionMatch[2], 10);
        NPCProfileModule.adjustAffection(entry.recipient, delta);
      }

      if (trustMatch) {
        const delta = parseInt(trustMatch[1] + trustMatch[2], 10);
        NPCProfileModule.adjustTrust(entry.recipient, delta);
      }

      // Generic positive change if no specific match
      if (!affectionMatch && !trustMatch && entry.relationshipChange.includes("+")) {
        NPCProfileModule.adjustAffection(entry.recipient, 5);
      }
    }
  },

  /**
   * Parse [NPC_GIFT] tags for equipment given to NPCs.
   * Format: [NPC_GIFT]{"npcName":"...","item":{"name":"...","slot":"...","rarity":"...","stats":{}}}[/NPC_GIFT]
   * Returns true if any NPC equipment was applied (caller should re-render).
   */
  extractNPCEquipment(aiText: string): boolean {
    const s = StateModule.state;
    if (!s.toggles.equipment) return false;

    let changed = false;
    const npcGiftRegex = /\[NPC_GIFT\](.*?)\[\/NPC_GIFT\]/gs;
    let match: RegExpExecArray | null;

    while ((match = npcGiftRegex.exec(aiText)) !== null) {
      const jsonStr = unwrapJsonBlock(match[1].trim());
      if (!jsonStr) continue;

      // Prefer a whole-payload JSON parse — the exact shape models are asked
      // to emit. Fall back to loose field extraction for mangled envelopes.
      const whole = safeParseJsonBlock(NPCGiftSchema, jsonStr);
      if (whole.ok && whole.data) {
        this.applyNPCEquipment(whole.data.npcName, whole.data.item);
        changed = true;
        continue;
      }

      const npcMatch = jsonStr.match(/"npcName"\s*:\s*"([^"]+)"/);
      // Greedy to the LAST closing brace so a nested `stats` object stays
      // inside the item — the old `[^}]+` capture broke on exactly that.
      const itemMatch = jsonStr.match(/"item"\s*:\s*(\{[\s\S]*\})/);
      if (!npcMatch || !itemMatch) continue;

      const parsedItem = safeParseJson(NPCEquipmentSchema, itemMatch[1]);
      if (!parsedItem.ok || !parsedItem.data) {
        console.warn("Skipped invalid NPC_GIFT item:", parsedItem.error);
        continue;
      }

      this.applyNPCEquipment(npcMatch[1], parsedItem.data);
      changed = true;
    }
    return changed;
  },

  /**
   * Apply an equipment item to an NPC profile.
   */
  applyNPCEquipment(npcName: string, item: NPCEquipment): void {
    const s = StateModule.state;
    const profile = s.npcProfiles.find(
      (p) => p.npcName.toLowerCase() === npcName.toLowerCase(),
    );

    if (profile) {
      // Add or replace equipment in the same slot
      const existingIdx = profile.equipment.findIndex((e) => e.slot === item.slot);
      const equippedItem: NPCEquipment = {
        ...item,
        giftedBy: s.char.name,
        receivedDate: new Date().toISOString(),
      };

      if (existingIdx >= 0) {
        profile.equipment[existingIdx] = equippedItem;
      } else {
        profile.equipment.push(equippedItem);
      }

      // Apply stat bonuses to NPC (stored as props for now)
      if (item.stats) {
        // NPC stat bonuses could affect their behavior/thresholds
        if (item.stats.str) {
          profile.aggressionThreshold = Math.min(
            100,
            profile.aggressionThreshold + Math.floor(item.stats.str * 0.5),
          );
        }
        if (item.stats.cha) {
          profile.affection = Math.min(
            100,
            profile.affection + Math.floor(item.stats.cha * 0.3),
          );
        }
      }
    }
  },

  /**
   * Get gift history for display.
   */
  getGiftHistory(limit: number = 10): GiftLogEntry[] {
    const s = StateModule.state;
    return [...s.giftLog].slice(-limit).reverse();
  },

  /**
   * Get all items an NPC is wearing/carrying.
   */
  getNPCEquipment(npcName: string): NPCEquipment[] {
    const s = StateModule.state;
    const profile = s.npcProfiles.find(
      (p) => p.npcName.toLowerCase() === npcName.toLowerCase(),
    );
    return profile?.equipment || [];
  },

  /**
   * Check if an NPC has a specific item equipped.
   */
  hasNPCEquipment(npcName: string, itemName: string): boolean {
    const items = this.getNPCEquipment(npcName);
    return items.some((e) => e.name.toLowerCase() === itemName.toLowerCase());
  },
};
