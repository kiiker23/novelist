// =============================================================================
// time-states.ts — Phase 5: Time-based state tracking, severity math, tick intervals.
// =============================================================================

import { StateModule } from "../state/state";
import { TimeState } from "../state/GameState";
import { TimeStateSchema } from "../state/schema";
import { safeParseJsonBlock } from "./tag-utils";

export const TimeStateModule = {
  /**
   * Parse [TIME_STATE] tags from AI output.
   * Format: [TIME_STATE]{"id":"poison","name":"Poisoned","target":"npc_name","severity":30,"durationMinutes":120,"tickIntervalMinutes":10,"severityDeltaPerTick":-5}[/TIME_STATE]
   * Returns true if any time state was added, updated, or removed.
   */
  extract(aiText: string): boolean {
    const s = StateModule.state;
    if (!s.toggles.time) return false;

    let changed = false;

    // Parse TIME_STATE additions
    const tsRegex = /\[TIME_STATE\](.*?)\[\/TIME_STATE\]/gs;
    let match: RegExpExecArray | null;

    while ((match = tsRegex.exec(aiText)) !== null) {
      const jsonStr = match[1].trim();
      if (!jsonStr) continue;

      const parsed = safeParseJsonBlock(TimeStateSchema, jsonStr);
      if (!parsed.ok || !parsed.data) {
        console.warn("Skipped invalid TIME_STATE:", parsed.error, jsonStr);
        continue;
      }

      this.upsertTimeState(parsed.data);
      changed = true;
    }

    // Parse TIME_STATE_REMOVE
    const trRegex = /\[TIME_STATE_REMOVE\](.*?)\[\/TIME_STATE_REMOVE\]/gs;
    let trMatch: RegExpExecArray | null;
    while ((trMatch = trRegex.exec(aiText)) !== null) {
      const targetId = trMatch[1].trim();
      if (targetId) {
        this.removeTimeState(targetId);
        changed = true;
      }
    }
    return changed;
  },

  /** Insert or update a time state. */
  upsertTimeState(ts: TimeState): void {
    const s = StateModule.state;
    const idx = s.timeStates.findIndex((t) => t.id === ts.id);

    if (idx >= 0) {
      s.timeStates[idx] = { ...s.timeStates[idx], ...ts };
    } else {
      s.timeStates.push(ts);
    }
  },

  /** Remove a time state by ID. */
  removeTimeState(id: string): void {
    const s = StateModule.state;
    s.timeStates = s.timeStates.filter((t) => t.id !== id);
  },

  /**
   * Tick all time states forward by the given number of minutes.
   * Called at the start of each turn (assumes ~10-minute turn increment).
   */
  tick(elapsedMinutes: number = 10): void {
    const s = StateModule.state;

    for (let i = s.timeStates.length - 1; i >= 0; i--) {
      const ts = s.timeStates[i];

      // Reduce duration
      ts.durationMinutes = Math.max(0, ts.durationMinutes - elapsedMinutes);

      // Apply severity ticks
      if (elapsedMinutes >= ts.tickIntervalMinutes && ts.durationMinutes > 0) {
        const ticks = Math.floor(elapsedMinutes / ts.tickIntervalMinutes);
        ts.severity = Math.max(
          0,
          Math.min(
            100,
            ts.severity + ticks * ts.severityDeltaPerTick,
          ),
        );
      }

      // Auto-remove if duration expired
      if (ts.durationMinutes <= 0) {
        s.timeStates.splice(i, 1);
      }
    }
  },

  /**
   * Get time states for a specific target (NPC name or "mc").
   */
  getByTarget(target: string): TimeState[] {
    const s = StateModule.state;
    return s.timeStates.filter((ts) => ts.target === target && ts.durationMinutes > 0);
  },

  /**
   * Get all active time states.
   */
  getAllActive(): TimeState[] {
    const s = StateModule.state;
    return s.timeStates.filter((ts) => ts.durationMinutes > 0);
  },

  /**
   * Get a severity label for UI display.
   */
  getSeverityLabel(severity: number): string {
    if (severity <= 0) return "None";
    if (severity < 25) return "Mild";
    if (severity < 50) return "Moderate";
    if (severity < 75) return "Severe";
    return "Critical";
  },

  /**
   * Get a CSS color class for severity.
   */
  getSeverityColor(severity: number): string {
    if (severity <= 0) return "text-slate-500";
    if (severity < 25) return "text-emerald-400";
    if (severity < 50) return "text-yellow-400";
    if (severity < 75) return "text-orange-400";
    return "text-red-400";
  },

  /**
   * Check if an NPC is affected by a specific time state.
   */
  hasTimeState(npcName: string, stateId: string): boolean {
    const s = StateModule.state;
    return s.timeStates.some(
      (ts) => ts.target === npcName && ts.id === stateId && ts.durationMinutes > 0,
    );
  },

  /**
   * Get the combined effect of all time states on an NPC for prompt injection.
   */
  getNPCStatusSummary(npcName: string): string {
    const states = this.getByTarget(npcName);
    if (states.length === 0) return "";

    return states
      .map((ts) => {
        const label = this.getSeverityLabel(ts.severity);
        const mins = Math.ceil(ts.durationMinutes / 60);
        return `${ts.name} (${label}, ${mins}h remaining, severity ${ts.severity})`;
      })
      .join(" | ");
  },
};
