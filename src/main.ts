// =============================================================================
// main.ts — Entry point.
//
// Imports the styles, wires up the modules, exposes the handful of objects the
// inline HTML onclick/onsubmit/onchange attributes reference on `window`, and
// runs the original window.onload boot sequence.
// =============================================================================

import "./styles.css";

import { StateModule } from "./state/state";
import { StorageModule } from "./storage/save";
import { GameEngine } from "./engine/turn";
import { UIManager } from "./ui/UIManager";
import { GenreModule } from "./engine/genre-system";
import { TemplateModule } from "./engine/templates";

// The original HTML uses inline handlers like onclick="GameEngine.startGenerator()".
// Expose the objects globally so that markup keeps working unchanged.
declare global {
  interface Window {
    StateModule: typeof StateModule;
    StorageModule: typeof StorageModule;
    GameEngine: typeof GameEngine;
    UIManager: typeof UIManager;
    GenreModule: typeof GenreModule;
    TemplateModule: typeof TemplateModule;
  }
}

window.StateModule = StateModule;
window.StorageModule = StorageModule;
window.GameEngine = GameEngine;
window.UIManager = UIManager;
window.GenreModule = GenreModule;
window.TemplateModule = TemplateModule;

// Inventory items are rendered with data-item-idx; delegate clicks here instead
// of inlining onclick with an index (cleaner + CSP-friendlier than the original).
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const li = target.closest<HTMLElement>(".inv-item");
  if (li && li.dataset.itemIdx !== undefined) {
    UIManager.showItemDetails(Number(li.dataset.itemIdx));
  }
});

window.addEventListener("load", () => {
  StateModule.initEnvKey();
  if (StorageModule.hasAutosave()) {
    UIManager.showResumeBanner();
  }

  // Phase 6: Initialize genre selector and template library
  GenreModule.init();
  TemplateModule.init();

  // Local API auto-detection: live navbar badge, refreshed periodically.
  UIManager.initLocalApiBadge();
});
