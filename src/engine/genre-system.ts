// =============================================================================
// genre-system.ts — Phase 6: Genre definitions, conflicts, unlocks, conditional stats.
// =============================================================================

import { StateModule } from "../state/state";
import { UIManager } from "../ui/UIManager";
import { GenreDef, MechanicMeta, SubSkillDef, TabMeta } from "../state/GameState";
import { getEffectiveStats } from "./equipment";

// ===========================================================================
// Built-in genre definitions
// ===========================================================================

export const GENRES: GenreDef[] = [
  { id: "xianxia",    label: "Xianxia",          hue: "#f59e0b", desc: "Chinese cultivation mythology; fantastical cosmology, sects, and hidden bloodlines.", conflictsWith: ["urban", "scifi", "postapoc"], pairsWell: ["cultivation", "school", "darkfantasy", "wuxia"], unlocks: ["cultivation_tier"] },
  { id: "wuxia",      label: "Wuxia",             hue: "#d97706", desc: "Chinese martial heroism; honor codes, wandering warriors, and martial sects.", conflictsWith: ["scifi", "urban"], pairsWell: ["cultivation", "xianxia", "romance"], unlocks: ["cultivation_tier"] },
  { id: "cultivation",label: "Cultivation",       hue: "#10b981", desc: "Power progression through inner practice. Pairs freely with any genre.", conflictsWith: [], pairsWell: [], unlocks: ["cultivation_tier"] },
  { id: "medieval",   label: "Medieval Fantasy",  hue: "#f97316", desc: "Classic feudal world of magic, monsters, knights, and kingdoms.", conflictsWith: ["scifi", "urban"], pairsWell: ["darkfantasy", "romance", "cultivation"], unlocks: ["stamina", "hunger"] },
  { id: "darkfantasy",label: "Dark Fantasy",      hue: "#8b5cf6", desc: "Grim worlds where corruption spreads, trust is rare, and darkness reshapes people.", conflictsWith: [], pairsWell: ["medieval", "horror", "romance"], unlocks: ["corruption"] },
  { id: "school",     label: "School / Academy",  hue: "#3b82f6", desc: "Academy or school setting; social hierarchies, rival clubs, coming-of-age dynamics.", conflictsWith: ["postapoc"], pairsWell: ["romance", "xianxia", "urban"], unlocks: [] },
  { id: "urban",      label: "Urban / Modern",    hue: "#06b6d4", desc: "Contemporary city life; wealth, status, and social connections drive everything.", conflictsWith: ["xianxia", "medieval", "wuxia"], pairsWell: ["romance", "school", "thriller"], unlocks: ["modern_tech"] },
  { id: "scifi",      label: "Sci-Fi",            hue: "#14b8a6", desc: "Futuristic technology, cybernetics, space travel, and advanced science.", conflictsWith: ["xianxia", "medieval", "wuxia"], pairsWell: ["postapoc", "thriller", "horror"], unlocks: ["space_tech"] },
  { id: "postapoc",   label: "Post-Apocalyptic",  hue: "#ef4444", desc: "Civilization collapse. Scavenged tech, roving gangs, and the ruins of the old world.", conflictsWith: ["school"], pairsWell: ["survival", "scifi", "horror"], unlocks: ["hunger", "thirst", "stamina"] },
  { id: "survival",   label: "Survival",          hue: "#eab308", desc: "Harsh resource management and desperate endurance. Nature is the enemy.", conflictsWith: [], pairsWell: ["medieval", "postapoc", "horror"], unlocks: ["hunger", "thirst", "stamina"] },
  { id: "isekai",     label: "Isekai",            hue: "#a855f7", desc: "MC transported from modern Earth; retains memories, adapts to a new world.", conflictsWith: [], pairsWell: [], unlocks: [] },
  { id: "romance",    label: "Romance",           hue: "#ec4899", desc: "Romantic elements and relationship progression. Tone modifier — pairs with anything.", conflictsWith: [], pairsWell: [], unlocks: [] },
  { id: "harem",      label: "Harem",             hue: "#f43f5e", desc: "Multiple romantic interests centered on the MC.", conflictsWith: [], pairsWell: ["romance", "adult", "xianxia"], unlocks: [] },
  { id: "adult",      label: "Adult / Explicit",  hue: "#be185d", desc: "Mature content flag — enables explicit scene generation.", conflictsWith: [], pairsWell: ["romance", "harem"], unlocks: [] },
  { id: "horror",     label: "Horror",            hue: "#6b7280", desc: "Fear, dread, and psychological horror. Things that should not exist do.", conflictsWith: [], pairsWell: ["darkfantasy", "survival"], unlocks: ["corruption"] },
  { id: "thriller",   label: "Thriller / Mystery", hue: "#475569", desc: "Tension, suspense, and hidden truths. Conspiracies and dangerous knowledge.", conflictsWith: [], pairsWell: ["urban", "scifi"], unlocks: [] },
  { id: "historical", label: "Historical",        hue: "#92400e", desc: "Grounded in real historical periods; accurate customs, politics, and technology.", conflictsWith: ["scifi", "urban", "postapoc"], pairsWell: ["medieval", "romance"], unlocks: [] },
];

// ===========================================================================
// Unlocked mechanics metadata
// ===========================================================================

export const MECHANIC_META: Record<string, MechanicMeta> = {
  cultivation_tier: { label: "Cultivation Tier", icon: "fa-fire", color: "#10b981" },
  stamina:          { label: "Stamina Bar",      icon: "fa-heart-pulse", color: "#22c55e" },
  hunger:           { label: "Hunger Bar",       icon: "fa-utensils", color: "#f97316" },
  thirst:           { label: "Thirst Bar",       icon: "fa-droplet", color: "#60a5fa" },
  corruption:       { label: "Corruption Bar",   icon: "fa-skull-crossbones", color: "#8b5cf6" },
  modern_tech:      { label: "Modern Tech",      icon: "fa-mobile-alt", color: "#06b6d4" },
  space_tech:       { label: "Space Tech",       icon: "fa-rocket", color: "#14b8a6" },
};

// ===========================================================================
// Secondary stat genre gating
// ===========================================================================

/** Genres that enable the END (Endurance) stat column. */
export const END_GENRES = ["medieval", "survival", "postapoc", "darkfantasy", "horror", "scifi", "thriller", "historical", "wuxia", "isekai"];

/** Genres that enable the WIL (Willpower) stat column. */
export const WIL_GENRES = ["cultivation", "xianxia", "wuxia", "darkfantasy", "horror", "isekai"];

// ===========================================================================
// Subskills with genre-gating and stat formulas
// ===========================================================================

export const SUBSKILLS: SubSkillDef[] = [
  { id: "melee",       label: "Melee Combat",  tab: "combat",  formula: e => Math.floor(e.str * 1.2 + e.agi * 0.3), genres: [] },
  { id: "ranged",      label: "Ranged",         tab: "combat",  formula: e => Math.floor(e.agi * 1.3 + e.per * 0.2), genres: [] },
  { id: "dodge",       label: "Dodge / Parry",  tab: "combat",  formula: e => Math.floor(e.agi * 1.4 + e.per * 0.1), genres: [] },
  { id: "endurance_c", label: "Endure Blows",   tab: "combat",  formula: e => Math.floor(e.end * 1.5), genres: ["medieval", "survival", "postapoc", "darkfantasy"] },
  { id: "negotiation", label: "Negotiation",    tab: "social",  formula: e => Math.floor(e.cha * 1.5 - e.str * 0.2), genres: [] },
  { id: "intimidation",label: "Intimidation",   tab: "social",  formula: e => Math.floor((e.str + e.cha) / 2), genres: [] },
  { id: "deception",   label: "Deception",      tab: "social",  formula: e => Math.floor((e.int + e.cha) / 2), genres: [] },
  { id: "seduction",   label: "Seduction",      tab: "social",  formula: e => Math.floor((e.cha + e.int) / 2), genres: ["romance", "adult", "harem"] },
  { id: "leadership",  label: "Leadership",     tab: "social",  formula: e => Math.floor(e.cha * 1.3 + e.wil * 0.2), genres: ["medieval", "historical", "scifi", "urban"] },
  { id: "sneaking",    label: "Sneaking",       tab: "craft",   formula: e => Math.floor(e.agi * 1.5), genres: [] },
  { id: "lockpicking", label: "Lockpicking",     tab: "craft",   formula: e => Math.floor((e.agi + e.int) / 2), genres: ["darkfantasy", "urban", "thriller"] },
  { id: "foraging",    label: "Foraging",       tab: "craft",   formula: e => Math.floor((e.per + e.end) / 2), genres: ["medieval", "survival", "postapoc", "historical"] },
  { id: "alchemy",     label: "Alchemy",        tab: "craft",   formula: e => Math.floor(e.int * 1.5), genres: ["xianxia", "medieval", "wuxia", "darkfantasy"] },
  { id: "riding",      label: "Riding",         tab: "craft",   formula: e => Math.floor((e.agi + e.end) / 2), genres: ["medieval", "historical", "darkfantasy"] },
  { id: "hacking",     label: "Hacking",        tab: "craft",   formula: e => Math.floor(e.int * 1.8), genres: ["scifi", "urban"] },
  { id: "tracking",    label: "Tracking",       tab: "craft",   formula: e => Math.floor(e.per * 1.4 + e.int * 0.2), genres: ["medieval", "survival", "postapoc", "historical"] },
  { id: "qi_sensing",  label: "Qi Sensing",     tab: "arcane",  formula: e => Math.floor((e.wil + e.per) / 2), genres: ["cultivation", "xianxia", "wuxia"] },
  { id: "spell_power", label: "Spell Power",    tab: "arcane",  formula: e => Math.floor(e.int * 1.3 + e.wil * 0.5), genres: ["medieval", "darkfantasy", "isekai"] },
  { id: "willforce",   label: "Willforce",       tab: "arcane",  formula: e => Math.floor(e.wil * 1.8), genres: ["cultivation", "xianxia", "darkfantasy", "horror", "wuxia"] },
  { id: "spirit_sense",label: "Spirit Sense",    tab: "arcane",  formula: e => Math.floor((e.wil + e.per + e.int) / 3), genres: ["xianxia", "darkfantasy", "horror", "isekai"] },
];

export const TAB_META: Record<string, TabMeta> = {
  combat: { label: "Combat",  icon: "fa-hand-fist", color: "#ef4444" },
  social: { label: "Social",  icon: "fa-comments",  color: "#ec4899" },
  craft:  { label: "Craft",   icon: "fa-wrench",    color: "#f97316" },
  arcane: { label: "Arcane",  icon: "fa-wand-magic", color: "#a855f7" },
};

export const TAB_ORDER = ["combat", "social", "craft", "arcane"];

// ===========================================================================
// Runtime logic
// ===========================================================================

export const GenreModule = {
  /** Called once on page load to render the genre selector. */
  init(): void {
    this.renderGrid();
    this.renderConflictWarning();
    this.renderUnlockedMechanics();
    this.updateConditionalStats();
  },

  /** Render the genre tag buttons in the setup screen. */
  renderGrid(): void {
    const grid = document.getElementById("genre-grid");
    if (!grid) return;
    const active = this.getActive();
    const conflicts = this.getConflicts();
    const conflictIds = new Set(conflicts.flatMap(c => [c.aId, c.bId]));

    grid.innerHTML = GENRES.map(g => {
      const isActive = active.includes(g.id);
      const isConflicting = isActive && conflictIds.has(g.id);
      const bg = isActive ? `${g.hue}30` : "rgba(30,41,59,0.8)";
      const bdr = isActive ? (isConflicting ? "#ef444488" : `${g.hue}88`) : "rgba(71,85,105,0.5)";
      const col = isActive ? g.hue : "#94a3b8";
      const pairs = g.pairsWell.map(p => {
        const pg = GENRES.find(x => x.id === p);
        return pg ? pg.label : p;
      }).join(", ");
      const confl = g.conflictsWith.map(c => {
        const cg = GENRES.find(x => x.id === c);
        return cg ? cg.label : c;
      }).join(", ");

      let title = g.desc;
      if (pairs) title += `\n→ Pairs: ${pairs}`;
      if (confl) title += `\n⊘ Conflicts: ${confl}`;

      return `<button class="genre-tag px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5" style="background:${bg};border-color:${bdr};color:${col}" onclick="GenreModule.toggle('${g.id}')" title="${title}">${isActive ? '<i class="fa-solid fa-check text-[9px]"></i>' : ''} ${g.label}</button>`;
    }).join("");

    const lbl = document.getElementById("genre-count-label");
    if (lbl) lbl.textContent = `${active.length} selected`;
  },

  /** Render conflict warning banner. */
  renderConflictWarning(): void {
    const el = document.getElementById("genre-conflict-warning");
    const txt = document.getElementById("genre-conflict-text");
    if (!el || !txt) return;
    const c = this.getConflicts();
    if (!c.length) {
      el.classList.add("hidden");
      return;
    }
    txt.innerHTML = c.map(x => `<strong>${x.a}</strong> + <strong>${x.b}</strong>: conflicting cosmologies — AI will prioritise whichever fits the current scene.`).join("<br>");
    el.classList.remove("hidden");
  },

  /** Render unlocked mechanic badges. */
  renderUnlockedMechanics(): void {
    const el = document.getElementById("genre-unlocks");
    if (!el) return;
    const active = this.getActive();
    if (!active.length) {
      el.innerHTML = '<span class="text-xs text-slate-600 italic">Select genres to see unlocked mechanics.</span>';
      return;
    }
    const ids = [...new Set(active.flatMap(id => {
      const g = GENRES.find(g => g.id === id);
      return g ? g.unlocks : [];
    }))];
    if (!ids.length) {
      el.innerHTML = '<span class="text-xs text-slate-500">No special mechanics unlocked.</span>';
      return;
    }
    el.innerHTML = '<span class="text-xs text-slate-500 mr-1">Unlocked:</span>' + ids.map(mid => {
      const m = MECHANIC_META[mid];
      if (!m) return "";
      return `<span class="unlock-badge" style="color:${m.color};background:${m.color}22;border-color:${m.color}44"><i class="fa-solid ${m.icon}"></i>${m.label}</span>`;
    }).join("");
  },

  /** Show/hide secondary stat columns based on active genres. */
  updateConditionalStats(): void {
    const active = this.getActive();
    const showEnd = END_GENRES.some(g => active.includes(g));
    const showWil = WIL_GENRES.some(g => active.includes(g));
    const ec = document.getElementById("stat-col-end");
    const wc = document.getElementById("stat-col-wil");
    if (ec) ec.style.display = showEnd ? "" : "none";
    if (wc) wc.style.display = showWil ? "" : "none";
    const count = [showEnd, showWil, true, true].filter(Boolean).length;
    const row = document.getElementById("secondary-stat-row");
    if (row) row.style.gridTemplateColumns = `repeat(${count},1fr)`;
    const note = document.getElementById("secondary-stat-note");
    if (note) note.textContent = (!showEnd && !showWil) ? "LCK & PER always active" : `${count} attributes active`;
  },

  /** Get currently active genre IDs from setup. */
  getActive(): string[] {
    const s = StateModule.state;
    return s.setup.activeGenres || [];
  },

  /** Check if any two active genres conflict. Returns conflict pairs. */
  getConflicts(): Array<{ a: string; b: string; aId: string; bId: string }> {
    const active = this.getActive();
    const conflicts: Array<{ a: string; b: string; aId: string; bId: string }> = [];

    for (let i = 0; i < active.length; i++) {
      const gA = GENRES.find(g => g.id === active[i]);
      if (!gA) continue;
      for (let j = i + 1; j < active.length; j++) {
        const gB = GENRES.find(g => g.id === active[j]);
        if (!gB) continue;
        if (gA.conflictsWith.includes(gB.id) || gB.conflictsWith.includes(gA.id)) {
          conflicts.push({ a: gA.label, b: gB.label, aId: gA.id, bId: gB.id });
        }
      }
    }
    return conflicts;
  },

  /** Get all unlocked mechanic IDs from active genres. */
  getUnlockedMechanics(): string[] {
    const active = this.getActive();
    const ids = new Set<string>();
    for (const gid of active) {
      const g = GENRES.find(x => x.id === gid);
      if (g) {
        for (const m of g.unlocks) ids.add(m);
      }
    }
    return [...ids];
  },

  /** Check if a genre is active. */
  isActive(genreId: string): boolean {
    return this.getActive().includes(genreId);
  },

  /** Check if a subskill is available given current genres and stats. */
  isSubskillAvailable(subskill: SubSkillDef): boolean {
    if (subskill.genres.length === 0) return true;
    const active = this.getActive();
    return subskill.genres.some(g => active.includes(g));
  },

  /** Compute subskill value from current character stats. */
  computeSubskill(subskill: SubSkillDef): number {
    const c = StateModule.state.char;
    // Core stats are gear-aware effective stats (cultivation-scaled base +
    // equipped bonuses), so e.g. INT gear raises Alchemy/Hacking just like
    // it raises the four derived skills. Secondary stats (END/WIL/LCK/PER)
    // have no gear channel yet, so they stay at base values.
    const eff = getEffectiveStats();
    return subskill.formula({
      str: eff.str, agi: eff.agi, int: eff.int, cha: eff.cha,
      end: c.end, wil: c.wil, lck: c.lck, per: c.per,
      cultivation: c.cultivation,
    });
  },

  /** Get all available subskills for current genres. */
  getAvailableSubskills(): SubSkillDef[] {
    return SUBSKILLS.filter(s => this.isSubskillAvailable(s));
  },

  /** Get subskills grouped by tab. */
  getSubskillsByTab(): Record<string, SubSkillDef[]> {
    const available = this.getAvailableSubskills();
    const grouped: Record<string, SubSkillDef[]> = {};
    for (const tab of TAB_ORDER) {
      grouped[tab] = available.filter(s => s.tab === tab);
    }
    return grouped;
  },

  /** Check if END stat column should be shown. */
  shouldShowEnd(): boolean {
    return END_GENRES.some(g => this.isActive(g));
  },

  /** Check if WIL stat column should be shown. */
  shouldShowWil(): boolean {
    return WIL_GENRES.some(g => this.isActive(g));
  },

  /** Toggle a genre on/off in setup. */
  toggle(genreId: string): void {
    const s = StateModule.state;
    const active = s.setup.activeGenres || [];
    const idx = active.indexOf(genreId);
    if (idx >= 0) {
      active.splice(idx, 1);
    } else {
      active.push(genreId);
    }
    s.setup.activeGenres = active;
    s.setup.genre = active.join(", ");

    // Sync hidden inputs for buildFromUI
    const hidden = document.getElementById("setup-genre-tags") as HTMLInputElement | null;
    if (hidden) hidden.value = active.join(", ");
    const hiddenGenre = document.getElementById("setup-genre") as HTMLInputElement | null;
    if (hiddenGenre) hiddenGenre.value = active.join(", ");

    // Re-render UI
    this.renderGrid();
    this.renderConflictWarning();
    this.renderUnlockedMechanics();
    this.updateConditionalStats();
    // Refresh sidebars so the genre-filtered skill tree updates immediately.
    UIManager.renderAllSidebars();
  },

  /** Clear all genres. */
  clearAll(): void {
    StateModule.state.setup.activeGenres = [];
    StateModule.state.setup.genre = "";

    // Sync hidden inputs for buildFromUI
    const hidden = document.getElementById("setup-genre-tags") as HTMLInputElement | null;
    if (hidden) hidden.value = "";
    const hiddenGenre = document.getElementById("setup-genre") as HTMLInputElement | null;
    if (hiddenGenre) hiddenGenre.value = "";

    // Re-render UI
    this.renderGrid();
    this.renderConflictWarning();
    this.renderUnlockedMechanics();
    this.updateConditionalStats();
    // Refresh sidebars so the genre-filtered skill tree updates immediately.
    UIManager.renderAllSidebars();
  },
};
