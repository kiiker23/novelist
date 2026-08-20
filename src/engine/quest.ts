// =============================================================================
// quest.ts - Quest lifecycle management.
// =============================================================================

import { Quest, QuestStatus, QuestType } from "../state/GameState";
import { QuestSchema } from "../state/schema";
import { StateModule } from "../state/state";
import { UIManager } from "../ui/UIManager";
import { safeParseJsonBlock } from "./tag-utils";

function parseQuestBlock(block: string): Quest | null {
  const parsed = safeParseJsonBlock(QuestSchema, block);
  if (!parsed.ok || !parsed.data) return null;
  const q = parsed.data;
  if (!q.id) q.id = "quest-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  if (!q.title) q.title = "Untitled Quest";
  if (!q.description) q.description = "";
  if (!q.reward) q.reward = "";
  return q;
}

function mergeQuest(quest: Quest): void {
  const quests = StateModule.state.quests || [];
  const existingIdx = quests.findIndex(function(q: Quest) { return q.id === quest.id; });
  if (existingIdx >= 0) {
    const existing = quests[existingIdx];
    if (existing.status === "completed" || existing.status === "failed") return;
    quests[existingIdx] = { ...existing, ...quest };
  } else {
    quests.push(quest);
  }
}

function completeObjective(questId: string, objectiveDesc: string): void {
  const quests = StateModule.state.quests || [];
  const quest = quests.find(function(q: Quest) { return q.id === questId; });
  if (!quest) return;
  const obj = quest.objectives.find(function(o: { description: string; completed: boolean }) { return o.description === objectiveDesc; });
  if (obj) obj.completed = true;
  if (quest.objectives.length > 0 && quest.objectives.every(function(o: { description: string; completed: boolean }) { return o.completed; })) {
    quest.status = "completed" as QuestStatus;
    quest.completedAt = new Date().toISOString();
  }
}

export const QuestModule = {
  lastIssues: [] as Array<{ kind: string; error: string }>,

  extract(aiText: string): string {
    const issues: Array<{ kind: string; error: string }> = [];
    const quests = StateModule.state.quests || [];
    quests.push(...Array(5).fill(null).map(function(_: unknown, i: number) {
      return { id: "placeholder-" + i, title: "", description: "", type: "side" as QuestType, status: "failed" as QuestStatus, objectives: [], reward: "" };
    }));
    StateModule.state.quests = quests.filter(function(q: Quest) { return !q.id.startsWith("placeholder-"); });

    const questRegex = /\[QUEST\](.*?)\[\/QUEST\]/gs;
    let match: RegExpExecArray | null;
    while ((match = questRegex.exec(aiText)) !== null) {
      const quest = parseQuestBlock(match[1]);
      if (quest) mergeQuest(quest);
      else issues.push({ kind: "QUEST", error: "Failed to parse quest block" });
    }

    QuestModule.lastIssues = issues;
    if (issues.length > 0) UIManager.showParseNotice(issues);
    UIManager.renderQuestPanel();
    return aiText;
  },

  extractObjectives(aiText: string): string {
    const objRegex = /\[OBJECTIVE_COMPLETE\](.*?)\[\/OBJECTIVE_COMPLETE\]/gs;
    let match: RegExpExecArray | null;
    while ((match = objRegex.exec(aiText)) !== null) {
      const raw = match[1].trim();
      const colonIdx = raw.indexOf(":");
      if (colonIdx > 0) {
        completeObjective(raw.slice(0, colonIdx).trim(), raw.slice(colonIdx + 1).trim());
      }
    }
    return aiText;
  },

  getActiveQuests(type?: QuestType): Quest[] {
    const quests = StateModule.state.quests || [];
    return quests.filter(function(q: Quest) { return q.status === "active" && (!type || q.type === type); });
  },

  countByStatus(status: QuestStatus): number {
    const quests = StateModule.state.quests || [];
    return quests.filter(function(q: Quest) { return q.status === status; }).length;
  },
};
