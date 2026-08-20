// =============================================================================
// save.ts — Export / import / autosave with versioned migration (Phase 1).
//
// Every load path (import file + autosave restore) now runs the raw blob
// through migrate() so old save shapes are upgraded to the current
// SCHEMA_VERSION before touching live state. The live API key is stripped from
// every snapshot so it never lands on disk or in localStorage.
// =============================================================================

import { GameState } from "../state/GameState";
import { StateModule } from "../state/state";
import { UIManager } from "../ui/UIManager";
import { cleanHistoryTags } from "../engine/lore";
import { migrate } from "./migrate";

const AUTOSAVE_KEY = "omninovel_autosave";

/** Deep copy of state with the live API key stripped out. */
function sanitizedStateSnapshot(): GameState {
  const snapshot = JSON.parse(JSON.stringify(StateModule.state)) as GameState;
  if (snapshot.api) snapshot.api.key = "";
  return snapshot;
}

export const StorageModule = {
  AUTOSAVE_KEY,

  exportSave(): void {
    if (!StateModule.state.initialized) return;
    try {
      const safeState = sanitizedStateSnapshot();
      const defaultName = `NovelSave_${StateModule.state.char.name.replace(/\s+/g, "")}_${new Date().toISOString().slice(0, 10)}.json`;
      const input = prompt("Enter save file name (without .json):", defaultName);
      if (input === null) return; // cancelled
      const filename = input.trim()
        .replace(/[^a-zA-Z0-9_\-\s]/g, "") // strip unsafe chars
        .replace(/\s+/g, "_") + ".json";
      const dataStr =
        "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(safeState));
      const anchor = document.createElement("a");
      anchor.setAttribute("href", dataStr);
      anchor.setAttribute("download", filename);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (e) {
      console.error("Export failed", e);
    }
  },

  autosave(): void {
    if (!StateModule.state.initialized) return;
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(sanitizedStateSnapshot()));
    } catch (e) {
      console.error("Autosave failed", e);
    }
  },

  hasAutosave(): boolean {
    try {
      return !!localStorage.getItem(AUTOSAVE_KEY);
    } catch {
      return false;
    }
  },

  /** Load + migrate the autosave. Returns null if none / unreadable. */
  loadAutosave(): GameState | null {
    try {
      const rawStr = localStorage.getItem(AUTOSAVE_KEY);
      if (!rawStr) return null;
      const result = migrate(JSON.parse(rawStr));
      if (result.migrated) {
        console.info(`Autosave migrated v${result.fromVersion} -> v${result.toVersion}`);
      }
      return result.state;
    } catch (e) {
      console.error("Autosave load failed", e);
      return null;
    }
  },

  clearAutosave(): void {
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch (e) {
      console.error("Autosave clear failed", e);
    }
  },

  importSave(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const raw = JSON.parse(String(e.target?.result));
        // A valid save must at least carry setup + char; everything else is
        // repaired by migrate().
        if (!raw || !raw.setup || !raw.char) {
          UIManager.showErrorBanner("Import failed: file is not a recognizable OmniNovel save.");
          return;
        }
        const result = migrate(raw);
        if (result.migrated) {
          console.info(`Imported save migrated v${result.fromVersion} -> v${result.toVersion}`);
        }
        StateModule.replaceState(result.state);
        // Clean leaked engine tags out of imported history entries.
        cleanHistoryTags(StateModule.state.history);
        UIManager.transitionToGame();
        UIManager.renderAllSidebars();
        UIManager.renderHistory();
      } catch (err) {
        console.error("Import failed:", err);
        UIManager.showErrorBanner("Import failed: the file could not be read as JSON.");
      }
    };
    reader.readAsText(file);
    input.value = "";
  },
};
