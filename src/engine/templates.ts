// =============================================================================
// templates.ts — Phase 6: Save/load/delete/export/import templates.
// Uses localStorage for persistence.
// Includes built-in templates shipped with the engine.
// =============================================================================

import { StateModule } from "../state/state";
import { SavedTemplate } from "../state/GameState";
import { GENRES } from "./genre-system";
import { GenreModule } from "./genre-system";

const TPL_STORAGE_KEY_PREFIX = "omninovel_tpl_";

// ===========================================================================
// Built-in templates
// ===========================================================================

const BUILTIN_TEMPLATES: Omit<SavedTemplate, "isBuiltin" | "createdAt">[] = [
  {
    id: "builtin-xianxia-school",
    name: "Xianxia Academy",
    activeGenres: ["xianxia", "cultivation", "school", "romance", "adult"],
    config: {
      worldSize: "Vast Continent",
      techStage: "Medieval Low-Magic",
      rules: "Cultivation is the path to immortality. Sects govern power. Spiritual roots determine talent.",
      measurement: "Metric",
      time: "Monday, March 17, 07:00", // spring term start
      location: "MC's Dormitory",
      mcName: "Lin Hao",
      mcAppearance: "Young cultivator with quiet resolve, carrying a hidden bloodline and exceptional spiritual roots.",
      mcInventoryJson: JSON.stringify([
        { name: "5 Low-Grade Spirit Stones", desc: "Basic cultivation currency", qty: 5, props: { grade: "Low", category: "Currency" } },
        { name: "Body Tempering Manual", desc: "First-tier cultivation technique", qty: 1, props: { tier: 1 } },
        { name: "Student ID - Azure Cloud Academy", desc: "Outer Disciple access pass", qty: 1 },
      ]),
      mcCultivation: 0.2,
      statStr: 29, statAgi: 29, statInt: 34, statCha: 31,
      statEnd: 22, statWil: 35, statLck: 25, statPer: 28,
    },
  },
  {
    id: "builtin-dark-fantasy",
    name: "Dark Fantasy",
    activeGenres: ["darkfantasy", "medieval", "thriller"],
    config: {
      worldSize: "Shattered Kingdoms",
      techStage: "Medieval - Rare Relics Only",
      rules: "The old gods are dead. Monsters roam the wilds. Corruption spreads like disease. Trust is a liability.",
      measurement: "Imperial",
      time: "Wednesday, October 29, 06:30", // late autumn
      location: "Roadside Tavern",
      mcName: "Aldric Vane",
      mcAppearance: "A wandering sell-sword in his mid-thirties, lean and weathered. Never speaks of his past.",
      mcInventoryJson: JSON.stringify([
        { name: "Iron Shortsword", desc: "Worn but reliable", qty: 1, props: { damage: "1d6+2", condition: 70 } },
        { name: "34 Silver Coins", desc: "Traveling funds", qty: 1 },
        { name: "Traveler's Pack", desc: "Bedroll, 3 days rations", qty: 1 },
      ]),
      mcCultivation: 0,
      statStr: 38, statAgi: 30, statInt: 24, statCha: 22,
      statEnd: 35, statWil: 20, statLck: 18, statPer: 28,
    },
  },
  {
    id: "builtin-urban-romance",
    name: "Urban Romance",
    activeGenres: ["urban", "romance", "adult"],
    config: {
      worldSize: "Contemporary Metropolis",
      techStage: "Modern - No Magic",
      rules: "No supernatural elements. Wealth, status, and social connections drive power.",
      measurement: "Metric",
      time: "Friday, September 5, 08:00", // early autumn — school/work season
      location: "Apartment - Bedroom",
      mcName: "Alex Chen",
      mcAppearance: "Late 20s, attractive and sharp-minded. Works in a competitive corporate environment.",
      mcInventoryJson: JSON.stringify([
        { name: "Smartphone", desc: "Latest model", qty: 1, props: { battery: "67%" } },
        { name: "247.50 USD", desc: "Cash", qty: 1 },
        { name: "Apartment Keys", qty: 1 },
      ]),
      mcCultivation: 0,
      statStr: 20, statAgi: 25, statInt: 36, statCha: 38,
      statEnd: 22, statWil: 25, statLck: 30, statPer: 28,
    },
  },
  {
    id: "builtin-isekai",
    name: "Isekai Adventure",
    activeGenres: ["isekai", "medieval", "romance", "cultivation"],
    config: {
      worldSize: "Vast Magical Realm",
      techStage: "Medieval High-Magic with System",
      rules: "MC transported from modern Earth. Has modern knowledge but must adapt to a world of magic.",
      measurement: "Metric",
      time: "Day 1 of arrival, 08:00",
      location: "Forest Clearing",
      mcName: "Kaito Hayashi",
      mcAppearance: "22-year-old Japanese student, unexpectedly transported. Physically average but highly adaptive.",
      mcInventoryJson: "[]",
      mcCultivation: 0,
      statStr: 22, statAgi: 28, statInt: 40, statCha: 29,
      statEnd: 20, statWil: 28, statLck: 35, statPer: 30,
    },
  },
  {
    id: "builtin-post-apoc",
    name: "Post-Apocalyptic",
    activeGenres: ["postapoc", "survival", "thriller"],
    config: {
      worldSize: "Collapsed Nation - The Wastes",
      techStage: "Scavenged Modern Tech",
      rules: "Civilization collapsed 15 years ago. Clean water and food are scarce. Trust is the rarest resource.",
      measurement: "Imperial",
      time: "Tuesday, July 8, 11:00", // high summer
      location: "Abandoned Gas Station",
      mcName: "Raya Stone",
      mcAppearance: "Hardened survivor in her late 20s, raised in the wastes. Resourceful and distrustful.",
      mcInventoryJson: JSON.stringify([
        { name: "Combat Knife", desc: "8-inch blade", qty: 1, props: { condition: 85 } },
        { name: "Water Bottle (Partial)", qty: 1, props: { liters: 0.9 } },
        { name: "First Aid Kit (Used)", qty: 1, props: { uses_remaining: 4 } },
        { name: "9mm Rounds", qty: 12, props: { caliber: "9mm" } },
      ]),
      mcCultivation: 0,
      statStr: 32, statAgi: 34, statInt: 30, statCha: 24,
      statEnd: 36, statWil: 28, statLck: 20, statPer: 32,
    },
  },
];

// ===========================================================================
// Module
// ===========================================================================

export const TemplateModule = {
  /** Called once on page load to populate the template grid. */
  init(): void {
    this.renderGrid();
  },

  /** Module-level pending delete ID (avoids TS object literal issues). */
  _pendingDeleteId: "" as string,

  /** Populate the template card grid. */
  renderGrid(): void {
    const grid = document.getElementById("template-grid");
    const count = document.getElementById("tpl-count");
    if (!grid) return;

    const all = this.loadAll();
    if (count) count.textContent = String(all.length);

    if (all.length === 0) {
      grid.innerHTML = '<div class="col-span-full text-center text-slate-500 italic py-4 text-sm">No templates available.</div>';
      return;
    }

    grid.innerHTML = all.map(t => {
      const ids = t.activeGenres || [];
      const tags = ids.slice(0, 4).map(id => {
        const g = GENRES.find(x => x.id === id);
        return g ? `<span class="text-[9px] px-1.5 py-0.5 rounded font-medium" style="color:${g.hue};background:${g.hue}25;border:1px solid ${g.hue}44">${g.label}</span>` : "";
      }).join("");

      const cfg = t.config || {};
      const name = cfg.mcName ? `<span class="text-slate-300 font-medium">${cfg.mcName}</span>` : "";
      const world = cfg.worldSize || "";

      const delBtn = !t.isBuiltin
        ? `<button onclick="TemplateModule.openDeleteModal('${t.id}')" class="text-xs bg-red-900/40 hover:bg-red-800/60 text-red-400 rounded px-2.5 py-1.5 transition"><i class="fa-solid fa-trash text-[10px]"></i></button>`
        : "";

      return `<div class="tpl-card bg-slate-800/80 border border-slate-700 rounded-lg p-3 flex flex-col gap-2 relative">
        ${t.isBuiltin ? '<span class="absolute top-2 right-2 text-[8px] bg-primary/20 text-primary border border-primary/30 px-1.5 py-0.5 rounded font-bold uppercase">BUILT-IN</span>' : ''}
        <div class="font-semibold text-sm text-white pr-14 leading-tight">${t.name}</div>
        <div class="flex flex-wrap gap-1">${tags || '<span class="text-[9px] text-slate-500">No genres</span>'}</div>
        <div class="text-[10px] text-slate-400">${name}${name && world ? ' · ' : ''}${world}</div>
        <div class="flex gap-1.5 mt-auto pt-2 border-t border-slate-700/50">
          <button onclick="TemplateModule.loadTemplate('${t.id}'); TemplateModule.renderGrid();" class="flex-1 text-xs bg-primary hover:bg-blue-600 text-white rounded px-2 py-1.5 transition font-medium"><i class="fa-solid fa-play mr-1 text-[9px]"></i>Load</button>
          <button onclick="TemplateModule.duplicateTemplate('${t.id}')" class="text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded px-2.5 py-1.5 transition"><i class="fa-solid fa-copy text-[10px]"></i></button>
          ${delBtn}
        </div>
      </div>`;
    }).join("");
  },

  // --- Modal helpers ---

  togglePanel(): void {
    const body = document.getElementById("tpl-panel-body");
    const chevron = document.getElementById("tpl-chevron");
    if (!body || !chevron) return;
    const hidden = body.classList.toggle("hidden");
    chevron.className = hidden ? "fa-solid fa-chevron-up" : "fa-solid fa-chevron-down";
  },

  openSaveModal(): void {
    document.getElementById("tpl-save-modal")?.classList.remove("hidden");
    const input = document.getElementById("tpl-name-input") as HTMLInputElement;
    if (input) {
      input.value = "";
      input.focus();
      // Wire up Enter key
      input.onkeydown = (e) => { if (e.key === "Enter") this.confirmSave(); };
    }
  },

  closeSaveModal(): void {
    document.getElementById("tpl-save-modal")?.classList.add("hidden");
  },

  async confirmSave(): Promise<void> {
    const n = (document.getElementById("tpl-name-input") as HTMLInputElement)?.value.trim();
    if (!n) return;
    await this.saveTemplate(n);
    this.renderGrid();
    this.closeSaveModal();
  },

  openDeleteModal(id: string): void {
    this._pendingDeleteId = id;
    document.getElementById("tpl-delete-modal")?.classList.remove("hidden");
    const btn = document.getElementById("delete-tpl-confirm-btn");
    if (btn) {
      btn.onclick = () => { this.deleteTemplate(id); this.renderGrid(); this.closeDeleteModal(); };
    }
  },

  closeDeleteModal(): void {
    document.getElementById("tpl-delete-modal")?.classList.add("hidden");
    this._pendingDeleteId = "";
  },

  async duplicateTemplate(id: string): Promise<void> {
    const all = this.loadAll();
    const src = all.find(t => t.id === id);
    if (!src) return;
    const dup: SavedTemplate = {
      ...src,
      id: `${TPL_STORAGE_KEY_PREFIX}${Date.now()}`,
      name: `${src.name} (Copy)`,
      isBuiltin: false,
      createdAt: Date.now(),
    };
    localStorage.setItem(dup.id, JSON.stringify(dup));
    this.renderGrid();
  },

  /** Load all templates (built-in + user) from localStorage. */
  loadAll(): SavedTemplate[] {
    const userTemplates: SavedTemplate[] = [];

    // Scan localStorage for keys matching our prefix
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(TPL_STORAGE_KEY_PREFIX)) {
        const raw = localStorage.getItem(key);
        if (raw) {
          try {
            const tpl = JSON.parse(raw) as SavedTemplate;
            userTemplates.push(tpl);
          } catch { /* skip corrupt */ }
        }
      }
    }

    // Combine built-in + user (user templates take precedence by ID)
    const builtin = BUILTIN_TEMPLATES.map(t => ({
      ...t,
      isBuiltin: true,
      createdAt: 0,
    })) as SavedTemplate[];

    // Deduplicate: user templates override builtins with same ID
    const map = new Map<string, SavedTemplate>();
    for (const b of builtin) map.set(b.id, b);
    for (const u of userTemplates) map.set(u.id, u);

    return [...map.values()].sort((a, b) => {
      if (a.isBuiltin && !b.isBuiltin) return -1;
      if (!a.isBuiltin && b.isBuiltin) return 1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  },

  /** Capture current form values as a template config (reads from DOM, not state). */
  captureConfig(): Record<string, unknown> {
    const gv = (id: string): string => {
      const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      return el ? el.value : "";
    };
    const gn = (id: string, def: number): number => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el) return def;
      const v = parseFloat(el.value);
      return Number.isNaN(v) ? def : v;
    };

    return {
      worldSize: gv("setup-world-size"),
      techStage: gv("setup-tech-stage"),
      rules: gv("setup-world-rules"),
      measurement: gv("setup-measurement"),
      time: gv("setup-time"),
      location: gv("setup-location"),
      mcName: gv("setup-mc-name"),
      mcAppearance: gv("setup-mc-appearance"),
      mcInventoryJson: gv("setup-mc-inventory-json"),
      mcCultivation: gn("setup-mc-cultivation", 0),
      statStr: gn("setup-stat-str", 10),
      statAgi: gn("setup-stat-agi", 10),
      statInt: gn("setup-stat-int", 10),
      statCha: gn("setup-stat-cha", 10),
      statEnd: gn("setup-stat-end", 10),
      statWil: gn("setup-stat-wil", 10),
      statLck: gn("setup-stat-lck", 10),
      statPer: gn("setup-stat-per", 10),
    };
  },

  /** Save current state as a user template. */
  saveTemplate(name: string): void {
    const id = `${TPL_STORAGE_KEY_PREFIX}${Date.now()}`;
    const tpl: SavedTemplate = {
      id,
      name,
      isBuiltin: false,
      createdAt: Date.now(),
      activeGenres: [...(StateModule.state.setup.activeGenres || [])],
      config: this.captureConfig(),
    };
    try {
      localStorage.setItem(id, JSON.stringify(tpl));
    } catch (e) {
      console.error("Template save failed:", e);
      throw e;
    }
  },

  /** Helper: populate HTML form fields from a template config. */
  _applyFormValues(c: Record<string, unknown>): void {
    const sv = (fieldId: string, value: unknown): void => {
      const el = document.getElementById(fieldId);
      if (!el) return;
      const str = value == null ? "" : String(value);
      if (el instanceof HTMLSelectElement) {
        for (let i = 0; i < el.options.length; i++) {
          if (el.options[i].value === str) { el.selectedIndex = i; break; }
        }
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        (el as HTMLInputElement | HTMLTextAreaElement).value = str;
      }
    };

    sv("setup-world-size", c.worldSize);
    sv("setup-tech-stage", c.techStage);
    sv("setup-world-rules", c.rules);
    sv("setup-measurement", c.measurement);
    sv("setup-time", c.time);
    sv("setup-location", c.location);
    sv("setup-mc-name", c.mcName);
    sv("setup-mc-appearance", c.mcAppearance);
    sv("setup-mc-inventory-json", c.mcInventoryJson);
    sv("setup-mc-cultivation", c.mcCultivation);
    sv("setup-stat-str", c.statStr);
    sv("setup-stat-agi", c.statAgi);
    sv("setup-stat-int", c.statInt);
    sv("setup-stat-cha", c.statCha);
    sv("setup-stat-end", c.statEnd);
    sv("setup-stat-wil", c.statWil);
    sv("setup-stat-lck", c.statLck);
    sv("setup-stat-per", c.statPer);
  },

  /** Load a template into the current state. */
  loadTemplate(id: string): void {
    let tpl: SavedTemplate | undefined;

    // Check built-in first
    const builtin = BUILTIN_TEMPLATES.find(t => t.id === id);
    if (builtin) {
      tpl = { ...builtin, isBuiltin: true, createdAt: 0 };
    } else {
      // Check localStorage
      const raw = localStorage.getItem(id);
      if (raw) {
        try {
          tpl = JSON.parse(raw) as SavedTemplate;
        } catch { /* ignore corrupt */ }
      }
    }

    if (!tpl) {
      console.warn(`Template not found: ${id}`);
      return;
    }

    const s = StateModule.state;

    // Apply genres
    s.setup.activeGenres = [...(tpl.activeGenres || [])];
    s.setup.genre = s.setup.activeGenres.join(", ");

    // Apply config to state
    const c = tpl.config;
    if (c.worldSize) s.setup.worldSize = String(c.worldSize);
    if (c.techStage) s.setup.techStage = String(c.techStage);
    if (c.rules) s.setup.rules = String(c.rules);
    if (c.measurement) s.setup.measurement = String(c.measurement);
    if (c.time) s.setup.time = String(c.time);
    if (c.location) s.setup.location = String(c.location);

    // Apply MC to state
    if (c.mcName) s.char.name = String(c.mcName);
    if (c.mcAppearance) s.char.appearance = String(c.mcAppearance);
    if (c.mcCultivation != null) s.char.cultivation = Number(c.mcCultivation);
    if (c.statStr != null) s.char.str = Number(c.statStr);
    if (c.statAgi != null) s.char.agi = Number(c.statAgi);
    if (c.statInt != null) s.char.int = Number(c.statInt);
    if (c.statCha != null) s.char.cha = Number(c.statCha);
    if (c.statEnd != null) s.char.end = Number(c.statEnd);
    if (c.statWil != null) s.char.wil = Number(c.statWil);
    if (c.statLck != null) s.char.lck = Number(c.statLck);
    if (c.statPer != null) s.char.per = Number(c.statPer);

    // Apply inventory
    if (c.mcInventoryJson) {
      try {
        s.char.inventory = JSON.parse(String(c.mcInventoryJson)) as typeof s.char.inventory;
      } catch { /* keep existing */ }
    }

    // Mark as loaded from template
    s.setup.templateId = id;

    // Populate HTML form fields so buildFromUI picks them up
    this._applyFormValues(c);

    // Sync hidden genre fields (critical for buildFromUI)
    const hidden = document.getElementById("setup-genre-tags") as HTMLInputElement | null;
    if (hidden && tpl.activeGenres) {
      hidden.value = tpl.activeGenres.join(", ");
    }
    const hiddenGenre = document.getElementById("setup-genre") as HTMLInputElement | null;
    if (hiddenGenre && tpl.activeGenres) {
      hiddenGenre.value = tpl.activeGenres.join(", ");
    }

    // Refresh genre UI after loading
    GenreModule.renderGrid();
    GenreModule.renderConflictWarning();
    GenreModule.renderUnlockedMechanics();
    GenreModule.updateConditionalStats();
  },

  /** Delete a user template. */
  deleteTemplate(id: string): void {
    try {
      localStorage.removeItem(id);
    } catch (e) {
      console.error("Template delete failed:", e);
      throw e;
    }
  },

  /** Export all user templates as JSON file. */
  exportTemplates(): void {
    const exported = BUILTIN_TEMPLATES.map(t => ({ ...t, isBuiltin: true, createdAt: 0 }));
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "omninovel-templates.json";
    a.click();
    URL.revokeObjectURL(url);
  },

  /** Import templates from a JSON file. */
  async importTemplates(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement)?.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const imported = JSON.parse(text) as Omit<SavedTemplate, "isBuiltin" | "createdAt">[];
      for (const tpl of imported) {
        const userTpl: SavedTemplate = {
          ...tpl,
          id: tpl.id.startsWith(TPL_STORAGE_KEY_PREFIX) ? tpl.id : `${TPL_STORAGE_KEY_PREFIX}${Date.now()}-${tpl.id}`,
          isBuiltin: false,
          createdAt: Date.now(),
        };
        localStorage.setItem(userTpl.id, JSON.stringify(userTpl));
      }
    } catch (e) {
      console.error("Template import failed:", e);
    }
  },
};
