// =============================================================================
// UIManager.ts — Phase 2: Token meter added. Phase 3: Quest/Equipment/Economy panels.
// Phase 4: XP bar, Level badge, Skill Tree UI, Cultivation panel.
// =============================================================================

import { StateModule } from "../state/state";
import { Subskills, EquippedItem, ApiConfig, Relation } from "../state/GameState";
import { ApiModule, providerNeedsApiKey } from "../api/providers";
import { EquipmentModule, getEffectiveStats } from "../engine/equipment";
import { XpModule } from "../engine/xp";
import { SkillModule, xpRequiredForLevel } from "../engine/skill";
import {
  parseSkillModifier,
  formatRemainingTime,
  isSkillEffectActive,
  activeChaBonus,
} from "../engine/skill-effects";
import { CultivationModule } from "../engine/cultivation";
import { TimeStateModule } from "../engine/time-states";
import { GiftModule } from "../engine/gifts";
import { GenreModule, TAB_META, TAB_ORDER } from "../engine/genre-system";
import { isFamilyRelation } from "../engine/family";
import { OUTCOME_LABELS } from "../engine/stat-checks";
import { formatRemainingMinutes, getNoteElapsedMinutes, rewordFiredNote } from "../engine/director-notes";
import {
  detectLocalApis,
  checkServerAlive,
  scanLanForApis,
  expandSubnet,
  subnetFromIp,
  guessLocalIp,
} from "../api/discovery";
import type { DetectedServer } from "../api/discovery";

type StatKey = "str" | "agi" | "int" | "cha";

export const UIManager = {
  transitionToGame(): void {
    document.getElementById("setup-screen")?.classList.add("hidden");
    document.getElementById("play-screen")?.classList.remove("hidden");
  },

  renderAllSidebars(): void {
    const s = StateModule.state;
    const setup = s.setup as { genre?: string };
    const setText = (id: string, text: string) => {
      const el = document.getElementById(id);
      if (el) el.innerText = text;
    };

    setText("ui-mc-name", s.char.name);
    setText("ui-genre-label", `Tier ${s.char.cultivation} | ${setup.genre ?? ""}`);

    const eff = getEffectiveStats();

    const stats: StatKey[] = ["str", "agi", "int", "cha"];
    stats.forEach((stat) => {
      const baseVal = s.char[stat];
      const effVal = eff[stat];
      setText(`ui-${stat}`, `${effVal}`);
      const container = document.getElementById(`ui-${stat}-container`);
      if (container) {
        let source = `(+${Math.round(
          s.char.cultivation * 20,
        )}% scaling from Tier ${s.char.cultivation} Cultivation)`;
        if (stat === "cha" && isSkillEffectActive("charm_aura")) {
          source += `\nCharm Aura active: +${activeChaBonus()} CHA`;
        }
        container.title = `Base ${stat.toUpperCase()}: ${baseVal} | Effective: ${effVal}\n${source}`;
      }
    });

    // Active skill effects render as a green bonus chip on the affected stat:
    // an active (level-scaled) Charm Aura shows +N next to CHA while it runs.
    const chaBonusEl = document.getElementById("ui-cha-bonus");
    if (chaBonusEl) {
      const bonus = activeChaBonus();
      if (bonus > 0) {
        chaBonusEl.textContent = `+${bonus}`;
        chaBonusEl.classList.remove("hidden");
      } else {
        chaBonusEl.classList.add("hidden");
      }
    }

    setText("ui-time", s.worldState.time);
    setText("ui-location", s.worldState.location);

    const setDisplay = (id: string, show: boolean) => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? "block" : "none";
    };

    if (s.toggles.health) {
      setDisplay("panel-health", true);
      setText("ui-health-val", `${s.char.health}/${s.char.maxHealth}`);
      const hb = document.getElementById("ui-health-bar");
      if (hb) hb.style.width = `${(s.char.health / s.char.maxHealth) * 100}%`;
      setText("ui-fatigue-val", `${s.char.fatigue}%`);
      const fb = document.getElementById("ui-fatigue-bar");
      if (fb) fb.style.width = `${s.char.fatigue}%`;
    } else {
      setDisplay("panel-health", false);
    }

    setDisplay("panel-stats", s.toggles.mcInfo);
    setDisplay("panel-inventory", s.toggles.mcInfo);
    setDisplay("panel-modifiers", s.toggles.mcInfo);
    setDisplay("panel-health", s.toggles.health);
    // Household panel mirrors the NPC Profiles panel but only appears when
    // the MC actually has registered family (it's character identity, so it
    // is not gated by any engine toggle).
    setDisplay("panel-household", (s.memory.relations || []).filter(isFamilyRelation).length > 0);
    setDisplay("panel-npc", s.toggles.npcDepth);
    setDisplay("panel-time-states", s.toggles.time);
    setDisplay("panel-gifts", s.toggles.npcDepth);
    setDisplay("panel-checks", s.toggles.statChecks);
    setDisplay("panel-action-memory", s.toggles.memory);
    // Economy History mirrors the Action Memory panel (the movements it lists
    // are harvested into memory), so it shares the memory toggle.
    setDisplay("panel-economy-history", s.toggles.memory);

    // Subskills panel
    const subPanel = document.getElementById("panel-subskills");
    if (s.toggles.subskills && subPanel) {
      subPanel.classList.remove("hidden");
      const ss = s.subskills as Subskills;
      const ssHtml = Object.entries(ss)
        .map(
          ([k, v]) =>
            `<div class="flex justify-between capitalize"><span>${k}</span><span class="text-white">${v}</span></div>`,
        )
        .join("");
      const list = document.getElementById("ui-subskills-list");
      if (list) list.innerHTML = ssHtml;
    } else if (subPanel) {
      subPanel.classList.add("hidden");
    }

    // Phase 4: XP/Level bar
    const xpPanel = document.getElementById("panel-xp");
    if (xpPanel) {
      if (s.toggles.xp) {
        xpPanel.classList.remove("hidden");
        const lvlInfo = XpModule.getLevelInfo();
        const xpBar = document.getElementById("ui-xp-bar");
        const xpVal = document.getElementById("ui-xp-val");
        const lvlBadge = document.getElementById("ui-level-badge");
        const spVal = document.getElementById("ui-sp-val");
        if (xpBar) xpBar.style.width = `${lvlInfo.progress}%`;
        if (xpVal) xpVal.innerText = `${lvlInfo.xp}/${lvlInfo.nextThreshold} XP`;
        if (lvlBadge) lvlBadge.innerText = `Lv.${lvlInfo.current}`;
        if (spVal) spVal.innerText = `${s.char.skillPoints}`;
      } else {
        xpPanel.classList.add("hidden");
      }
    }

    // Phase 4: Cultivation panel
    const cultPanel = document.getElementById("panel-cultivation");
    if (cultPanel) {
      if (s.toggles.xp) {
        cultPanel.classList.remove("hidden");
        const breakthroughs = CultivationModule.getBreakthroughStatus();
        const cultVal = document.getElementById("ui-cultivation-val");
        if (cultVal) cultVal.innerText = s.char.cultivation.toFixed(1);

        // Render breakthrough progress
        const btList = document.getElementById("ui-breakthrough-list");
        if (btList) {
          let btHtml = "";
          for (const bt of breakthroughs) {
            const icon = bt.achieved ? "fa-check-circle text-emerald-400" : "fa-circle text-slate-600";
            btHtml += `<div class="flex items-center gap-1.5 text-[10px] ${bt.achieved ? 'text-emerald-400' : 'text-slate-500'}"><i class="fa-solid ${icon}"></i>${bt.achieved ? bt.name : `Req: ${bt.name}`}</div>`;
          }
          btList.innerHTML = btHtml;
        }

        // Render skill tree
        const skillTreeList = document.getElementById("ui-skill-tree-list");
        if (skillTreeList) {
          const tree = SkillModule.getSkillTree();
          const treeCount = document.getElementById("ui-skill-tree-count");
          if (treeCount) treeCount.innerText = tree.length > 0 ? `(${tree.length} available)` : "";
          let treeHtml = "";
          for (const sk of tree) {
            const catInfo = SkillModule.getCategoryInfo(sk.category);
            treeHtml += `<div class="flex items-center justify-between bg-slate-900/50 p-1.5 rounded border border-slate-800/60 text-[10px] mb-1">
              <div class="flex items-center gap-1.5">
                <i class="fa-solid ${catInfo.icon} text-[8px] ${catInfo.color}"></i>
                <span class="text-slate-300">${sk.name}</span>
              </div>
              <span class="text-[8px] px-1 rounded ${EquipmentModule.getRarityClass(sk.rarity)} bg-slate-900">${sk.rarity}</span>
            </div>`;
          }
          if (tree.length === 0) treeHtml = `<div class="text-slate-500 italic text-[10px]">All skills learned!</div>`;
          skillTreeList.innerHTML = treeHtml;
        }

        // Render learned skills
        const learnedList = document.getElementById("ui-learned-skills-list");
        if (learnedList) {
          const learned = s.char.learnedSkills;
          let learnedHtml = "";
          for (const sk of learned) {
            const catInfo = SkillModule.getCategoryInfo(sk.category);
            const activeIcon = sk.active ? "fa-toggle-on text-emerald-400" : "fa-toggle-off text-slate-600";
            // Training progress: XP invested toward the next level, so
            // [SKILL_TRAIN] sessions visibly fill the bar until a rank-up.
            const invested = sk.xpInvested || 0;
            const nextXp = xpRequiredForLevel(sk.level);
            const xpPct = Math.max(0, Math.min(100, Math.round((invested / nextXp) * 100)));
            learnedHtml += `<div class="bg-slate-800 p-1.5 rounded border border-slate-700/50 text-[10px] mb-1">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-1.5">
                  <i class="fa-solid ${catInfo.icon} text-[8px] ${catInfo.color}"></i>
                  <span class="text-slate-300">${sk.name}</span>
                  <span class="text-slate-500">Lv.${sk.level}</span>
                </div>
                <i class="fa-solid ${activeIcon} text-[8px]"></i>
              </div>
              <div class="mt-1 h-1 rounded-full bg-slate-700 overflow-hidden">
                <div class="h-full rounded-full bg-cyan-400/80 transition-all" style="width:${xpPct}%"></div>
              </div>
              <div class="text-[8px] text-slate-500 mt-0.5">${invested}/${nextXp} XP to Lv.${sk.level + 1}</div>
            </div>`;
          }
          if (learned.length === 0) learnedHtml = `<div class="text-slate-500 italic text-[10px]">No skills learned yet.</div>`;
          learnedList.innerHTML = learnedHtml;
        }
      } else {
        cultPanel.classList.add("hidden");
      }
    }

    // Modifiers list
    const modContainer = document.getElementById("ui-modifiers-list");
    if (modContainer) {
      if (s.modifiers && Object.keys(s.modifiers).length > 0) {
        modContainer.innerHTML = Object.entries(s.modifiers)
          .map(([key, val]) => {
            const effect = parseSkillModifier(val);
            // A skill effect carries a ticking duration: render its effect
            // text, the remaining time (minutes/hours/days), and a thin
            // progress bar showing how much duration is left.
            if (effect) {
              const frac =
                effect.minutesTotal > 0
                  ? Math.max(0, Math.min(1, effect.minutesLeft / effect.minutesTotal))
                  : 0;
              const pct = Math.round(frac * 100);
              return `
                <li class="bg-slate-800 p-1.5 rounded border border-slate-700/50 text-xs">
                  <div class="flex justify-between items-center gap-2">
                    <span class="text-slate-300 capitalize font-medium">${key.replace(/_/g, " ")}</span>
                    <span class="text-emerald-400 font-semibold">${formatRemainingTime(effect.minutesLeft)}</span>
                  </div>
                  <div class="text-[10px] text-slate-400 leading-tight mt-0.5">${effect.effect}</div>
                  <div class="mt-1 h-1 rounded-full bg-slate-700 overflow-hidden">
                    <div class="h-full rounded-full bg-emerald-400/80 transition-all" style="width:${pct}%"></div>
                  </div>
                </li>`;
            }
            // Plain [STATE_UPDATE] modifier — permanent, no timer.
            return `
              <li class="flex justify-between bg-slate-800 p-1.5 rounded border border-slate-700/50 text-xs">
                <span class="text-slate-400 capitalize">${key.replace(/_/g, " ")}</span>
                <span class="text-emerald-400 font-semibold">${val}</span>
              </li>`;
          })
          .join("");
      } else {
        modContainer.innerHTML = `<li class="text-slate-500 italic text-xs">No active passive buffs.</li>`;
      }
    }

    // Inventory list
    const invEl = document.getElementById("ui-inventory-list");
    if (invEl) {
      const inventoryList = s.char.inventory || [];
      if (inventoryList.length === 0) {
        invEl.innerHTML = `<li class="text-slate-500 italic text-xs">Inventory is empty.</li>`;
      } else {
        invEl.innerHTML = inventoryList
          .map((item, idx) => {
            const hasProps = item.props && Object.keys(item.props).length > 0;
            return `
              <li data-item-idx="${idx}" class="inv-item flex items-start gap-2 p-1.5 rounded hover:bg-slate-700 cursor-pointer transition border border-transparent hover:border-slate-600">
                <i class="fa-solid fa-box text-slate-500 mt-1 text-xs"></i>
                <div class="flex-1">
                  <div class="font-medium text-slate-200 flex justify-between items-center">
                    <span>${item.name}</span>
                    ${item.qty && item.qty > 1 ? `<span class="text-[10px] bg-slate-800 px-1 rounded text-accent">x${item.qty}</span>` : ""}
                  </div>
                  <div class="text-[10px] text-slate-400 leading-tight">${item.desc || "No description"}</div>
                  ${hasProps ? `<div class="text-[9px] text-accent mt-0.5"><i class="fa-solid fa-list-check mr-1"></i>View Properties</div>` : ""}
                </div>
              </li>`;
          })
          .join("");
      }
    }

    this.renderMemoryPanel();
    this.renderQuestPanel();
    this.renderEquipmentPanel();
    this.renderEconomyPanel();
    this.renderHouseholdPanel();
    this.renderNPCPanel();
    this.renderTimeStatesPanel();
    this.renderGiftPanel();
    this.renderScenePanel();
    this.renderSecondaryStats();
    this.renderSubskillsPanel();
    this.renderDirectorNotes();
    this.renderChecksPanel();
    this.renderActionMemoryPanel();
    this.renderEconomyHistoryPanel();
  },

  // ===========================================================================
  // Descriptive Scenes: Current Scene Panel
  // ===========================================================================

  renderScenePanel(): void {
    const s = StateModule.state;
    const el = document.getElementById("ui-scene-text");
    const panel = document.getElementById("panel-scene");
    if (!el || !panel) return;
    const sceneKey = (s.worldState.location || "").trim().toLowerCase();
    const entry = s.toggles.descriptiveScenes && s.sceneLog && s.sceneLog[sceneKey];
    panel.style.display = entry ? "block" : "none";
    if (!entry) {
      el.innerHTML = "";
      return;
    }
    let html = this.escapeHtml(entry.description);
    const ambient: string[] = [];
    if (entry.weather) ambient.push(`☁ ${this.escapeHtml(entry.weather)}`);
    if (entry.lighting) ambient.push(`💡 ${this.escapeHtml(entry.lighting)}`);
    if (entry.season) ambient.push(`🍂 ${this.escapeHtml(entry.season)}`);
    if (ambient.length > 0 || entry.seasonNote) {
      html += `<div class="mt-1.5 pt-1.5 border-t border-slate-700/40 text-[10px] text-slate-400">${ambient.join(" · ")}${entry.seasonNote ? `<div class="text-amber-400/80 mt-0.5">⚠ ${this.escapeHtml(entry.seasonNote)}</div>` : ""}</div>`;
    }
    // Story-driven season canon, when set: the calendar no longer rules.
    if (s.seasonOverride) {
      html += `<div class="mt-1 text-[10px] text-amber-300/90">🌓 Story season: ${this.escapeHtml(s.seasonOverride)} (canon, overrides calendar)</div>`;
    }
    el.innerHTML = html;
  },

  /** Render the active Director's Note chips above the input area. */
  renderDirectorNotes(): void {
    const list = document.getElementById("director-notes-list");
    if (!list) return;
    const notes = StateModule.state.directorNotes || [];
    if (notes.length === 0) {
      list.innerHTML = "";
      return;
    }
    list.innerHTML = notes
      .map((n, i) => {
        const isFired = n.fired;
        let label = this.escapeHtml(n.text);
        let extraClass = "bg-amber-950/40 border-amber-500/30 text-amber-200/90";
        if (isFired) {
          // Reword stale deadline phrasing ("in 2 days") to "NOW" so the chip
          // reads as active; keep the NOW badge when there's nothing to reword.
          const reworded = rewordFiredNote(n);
          const badge = reworded === n.text ? `<span class="text-emerald-300 font-bold">NOW</span> ` : "";
          label = `${badge}${this.escapeHtml(reworded)}`;
          extraClass = "bg-emerald-950/40 border-emerald-500/40 text-emerald-200";
        } else if (n.deadlineMinutes !== undefined) {
          const remaining = Math.max(0, n.deadlineMinutes - getNoteElapsedMinutes(n));
          label = `${label} <span class="text-amber-400/70 text-[9px]">· ${formatRemainingMinutes(remaining)}</span>`;
        }
        return `<span class="inline-flex items-center gap-1.5 ${extraClass} text-[10px] px-2 py-1 rounded-full max-w-full">
             <i class="fa-solid fa-clapperboard shrink-0"></i>
             <span class="truncate">${label}</span>
             <button onclick="GameEngine.removeDirectorNote(${i})" class="hover:text-white shrink-0" title="Remove note" aria-label="Remove note"><i class="fa-solid fa-times"></i></button>
           </span>`;
      })
      .join("");
  },

  /** Expand or collapse the skill tree section (collapsed by default). */
  toggleSkillTree(): void {
    const body = document.getElementById("ui-skill-tree-body");
    const chevron = document.getElementById("ui-skill-tree-chevron");
    if (!body) return;
    const collapsed = body.classList.toggle("hidden");
    if (chevron) {
      chevron.classList.toggle("fa-chevron-right", collapsed);
      chevron.classList.toggle("fa-chevron-down", !collapsed);
    }
  },

  /** Expand or collapse the household section (expanded by default). */
  toggleHousehold(): void {
    const body = document.getElementById("ui-household-body");
    const chevron = document.getElementById("ui-household-chevron");
    if (!body) return;
    const collapsed = body.classList.toggle("hidden");
    if (chevron) {
      chevron.classList.toggle("fa-chevron-right", collapsed);
      chevron.classList.toggle("fa-chevron-down", !collapsed);
    }
  },

  /** Expand or collapse the recent-checks section (expanded by default). */
  toggleChecks(): void {
    const body = document.getElementById("ui-checks-body");
    const chevron = document.getElementById("ui-checks-chevron");
    if (!body) return;
    const collapsed = body.classList.toggle("hidden");
    if (chevron) {
      chevron.classList.toggle("fa-chevron-right", collapsed);
      chevron.classList.toggle("fa-chevron-down", !collapsed);
    }
  },

  toggleActionMemory(): void {
    const body = document.getElementById("ui-action-memory-body");
    const chevron = document.getElementById("ui-action-memory-chevron");
    if (!body) return;
    const collapsed = body.classList.toggle("hidden");
    if (chevron) {
      chevron.classList.toggle("fa-chevron-right", collapsed);
      chevron.classList.toggle("fa-chevron-down", !collapsed);
    }
  },

  /** Expand or collapse the economy-history section (expanded by default). */
  toggleEconomyHistory(): void {
    const body = document.getElementById("ui-economy-body");
    const chevron = document.getElementById("ui-economy-chevron");
    if (!body) return;
    const collapsed = body.classList.toggle("hidden");
    if (chevron) {
      chevron.classList.toggle("fa-chevron-right", collapsed);
      chevron.classList.toggle("fa-chevron-down", !collapsed);
    }
  },

  /**
   * "Compare with past actions" — fills the chat input with an explicit
   * out-of-character comparison request. The RECENT ACTION MEMORY block is
   * already injected into every payload, so pressing Enter sends the model
   * a grounded request to contrast the current situation against what the MC
   * actually did (past checks and outcomes, intimacy milestones, gifts,
   * reactions) instead of letting the model guess — or forget.
   */
  prepareComparison(): void {
    const inputEl = document.getElementById("user-input") as HTMLInputElement | null;
    if (!inputEl) return;
    const s = StateModule.state;
    const memCount = (s.actionMemory || []).length;
    const loc = s.worldState.location ? ` at ${s.worldState.location}` : "";
    const plural = memCount === 1 ? "remembered action" : "remembered actions";
    inputEl.value =
      `[OOC compare] Out-of-character question — answer briefly, then return to the story when I act. ` +
      `Compare my current situation${loc} against the ACTION MEMORY LOG in your context (${memCount} ${plural}). ` +
      `Name what you actually remember — past checks and their outcomes, intimacy milestones, gifts, reactions — ` +
      `then contrast: is what I'm considering easier or harder than last time? Is this relationship step above or ` +
      `below what we've already done? Who is stronger, more hostile, or warmer than before? Verify against the log; ` +
      `don't just repeat my claims — if the log contradicts me, say so.`;
    if (typeof inputEl.focus === "function") inputEl.focus();
  },

  // ===========================================================================
  // Stat-Check Framework: Recent Checks Panel
  // The last few engine-resolved stat checks (stat, difficulty, roll vs
  // target, outcome tier, margin) so the player can scan WHY checks have been
  // passing or failing — the same math the chat system line reports, in a
  // scannable sidebar list instead of buried in the log.
  // ===========================================================================

  renderActionMemoryPanel(): void {
    const s = StateModule.state;
    const list = document.getElementById("ui-action-memory-list");
    if (!list) return;

    const mem = s.actionMemory || [];
    if (mem.length === 0) {
      list.innerHTML =
        '<div class="text-slate-500 italic text-[10px]">No remembered actions yet — sparring, kisses, heists, and every stat check land here and survive restarts.</div>';
      return;
    }

    const catColor: Record<string, string> = {
      combat: "text-red-400",
      social: "text-sky-400",
      intimacy: "text-pink-400",
      school: "text-amber-300",
      family: "text-emerald-400",
      cultivation: "text-violet-400",
      craft: "text-orange-300",
      adventure: "text-lime-400",
      other: "text-slate-400",
    };

    list.innerHTML = mem
      .slice(-6)
      .reverse()
      .map((e) => {
        const out = e.outcome ? `<span class="text-slate-400"> · ${this.escapeHtml(e.outcome)}</span>` : "";
        const rew = e.reward ? `<span class="text-emerald-400"> · ${this.escapeHtml(e.reward)}</span>` : "";
        const det = e.detail ? `<div class="text-slate-500 italic truncate mt-0.5">${this.escapeHtml(e.detail)}</div>` : "";
        return `
          <div class="bg-slate-800 p-1.5 rounded border border-slate-700/60 text-[10px]">
            <div class="flex justify-between items-center gap-2">
              <span class="font-semibold text-slate-200 truncate">${this.escapeHtml(e.summary)}</span>
              <span class="font-bold ${catColor[e.category] || "text-slate-300"} shrink-0">${e.category}</span>
            </div>
            <div class="text-slate-500 mt-0.5">${this.escapeHtml(e.time)} · turn ${e.turn} · intensity ${e.intensity ?? "—"}${out}${rew}</div>
            ${det}
          </div>`;
      })
      .join("");
  },

  // ===========================================================================
  // Economy History: the state-level story. The last few systemPoints,
  // inventory, and currency movements the engine diffed from [STATE_UPDATE]
  // each turn (the same entries the memory log carries, viewed through an
  // economy lens) — so the player sees the balance moving even when the AI
  // never mentioned a trade. Gains green, outflows red.
  // ===========================================================================

  renderEconomyHistoryPanel(): void {
    const s = StateModule.state;
    const list = document.getElementById("ui-economy-list");
    if (!list) return;

    const entries = (s.actionMemory || []).filter((e) => e.category === "economy");
    if (entries.length === 0) {
      list.innerHTML =
        '<div class="text-slate-500 italic text-[10px]">No economy movement yet — spent system points, acquired or lost items, and currency balance changes land here and survive restarts.</div>';
      return;
    }

    list.innerHTML = entries
      .slice(-6)
      .reverse()
      .map((e) => {
        const summary = e.summary || "";
        const gain =
          /^(Earned|Acquired|Rewarded|Sold)/i.test(summary);
        const outflow =
          /^(Spent|Lost|Paid|Bought)/i.test(summary);
        const color = gain
          ? "text-emerald-400"
          : outflow
            ? "text-red-400"
            : "text-slate-300";
        const icon = gain
          ? "fa-arrow-trend-up"
          : outflow
            ? "fa-arrow-trend-down"
            : "fa-coins";
        const out = e.outcome
          ? `<span class="text-slate-500"> · ${this.escapeHtml(e.outcome)}</span>`
          : "";
        return `
          <div class="bg-slate-800 p-1.5 rounded border border-slate-700/60 text-[10px]">
            <div class="flex justify-between items-center gap-2">
              <span class="font-semibold ${color} truncate"><i class="fa-solid ${icon} mr-1"></i>${this.escapeHtml(summary)}</span>
              <span class="text-slate-500 shrink-0">turn ${e.turn}</span>
            </div>
            <div class="text-slate-500 mt-0.5">${this.escapeHtml(e.time)}${out}</div>
          </div>`;
      })
      .join("");
  },

  renderChecksPanel(): void {
    const s = StateModule.state;
    const list = document.getElementById("ui-checks-list");
    if (!list) return;

    const checks = s.checkLog || [];
    if (checks.length === 0) {
      list.innerHTML =
        '<div class="text-slate-500 italic text-[10px]">No checks yet — they appear when the AI declares [CHECK] challenges.</div>';
      return;
    }

    const color: Record<string, string> = {
      critical_failure: "text-red-400",
      major_failure: "text-orange-400",
      minor_failure: "text-amber-300",
      neutral: "text-slate-400",
      minor_success: "text-lime-400",
      major_success: "text-emerald-400",
      critical_success: "text-teal-300",
    };

    list.innerHTML = checks
      .slice(-6)
      .reverse()
      .map((c) => {
        const margin = c.score - c.target;
        const marginSign = margin > 0 ? "+" : "";
        const lckStr =
          c.lckMod !== 0 ? ` + LCK ${c.lckMod > 0 ? "+" : ""}${c.lckMod}` : "";
        const inferred = c.inferred ? " · inferred" : "";
        return `
          <div class="bg-slate-800 p-1.5 rounded border border-slate-700/60 text-[10px]">
            <div class="flex justify-between items-center gap-2">
              <span class="font-semibold text-slate-200">${c.stat}</span>
              <span class="font-bold ${color[c.outcome] || "text-slate-300"}">${OUTCOME_LABELS[c.outcome]}</span>
            </div>
            <div class="text-slate-400 mt-0.5">roll ${c.roll}${lckStr} + ${c.stat} ${c.effectiveStat} = ${c.score} vs ${c.difficulty} ${c.target} (margin ${marginSign}${margin})${inferred}</div>
            ${c.context ? `<div class="text-slate-500 italic truncate mt-0.5">${this.escapeHtml(c.context)}</div>` : ""}
          </div>`;
      })
      .join("");
  },

  // ===========================================================================
  // Phase 3: Quest Panel Rendering
  // ===========================================================================

  renderQuestPanel(): void {
    const s = StateModule.state;
    const container = document.getElementById("ui-quest-list");
    if (!container) return;

    if (!s.toggles.quests) {
      container.innerHTML = `<li class="text-slate-500 text-center italic">Quest System Disabled.</li>`;
      return;
    }

    const quests = s.quests || [];
    const active = quests.filter((q) => q.status === "active");
    const completed = quests.filter((q) => q.status === "completed");
    const failed = quests.filter((q) => q.status === "failed");

    let html = "";

    if (active.length > 0) {
      html += `<div class="mb-3"><h4 class="text-[10px] uppercase text-emerald-400 font-bold mb-1.5 tracking-wider flex items-center gap-1"><i class="fa-solid fa-scroll"></i> Active (${active.length})</h4>`;
      for (const q of active) {
        const typeColor = q.type === "main" ? "text-amber-400" : q.type === "daily" ? "text-blue-400" : q.type === "hidden" ? "text-purple-400" : "text-slate-400";
        const typeIcon = q.type === "main" ? "fa-crown" : q.type === "daily" ? "fa-calendar-check" : q.type === "hidden" ? "fa-eye-slash" : "fa-flag";
        const completedObjCount = q.objectives.filter((o) => o.completed).length;
        const totalObjCount = q.objectives.length;
        const progressPct = totalObjCount > 0 ? Math.round((completedObjCount / totalObjCount) * 100) : 0;

        html += `
          <div class="bg-slate-800 p-2 rounded border border-slate-700/60 mb-2">
            <div class="flex justify-between items-start mb-1">
              <span class="font-bold text-xs text-white flex items-center gap-1">
                <i class="fa-solid ${typeIcon} text-[8px] ${typeColor}"></i> ${q.title}
              </span>
              <span class="text-[8px] px-1.5 rounded font-mono ${typeColor} bg-slate-900 uppercase">${q.type}</span>
            </div>
            <div class="text-[10px] text-slate-400 mb-1.5">${q.description}</div>
            ${totalObjCount > 0 ? `
              <div class="w-full bg-slate-700/50 rounded-full h-1 mb-1">
                <div class="bg-emerald-500 h-1 rounded-full" style="width: ${progressPct}%"></div>
              </div>
              <div class="text-[9px] text-slate-500">${completedObjCount}/${totalObjCount} objectives</div>
            ` : ""}
            ${q.reward ? `<div class="text-[9px] text-amber-400 mt-1"><i class="fa-solid fa-gift mr-1"></i>${q.reward}</div>` : ""}
          </div>`;
      }
      html += "</div>";
    }

    if (completed.length > 0) {
      html += `<div class="mb-3"><h4 class="text-[10px] uppercase text-slate-500 font-bold mb-1.5 tracking-wider"><i class="fa-solid fa-trophy mr-1"></i> Completed (${completed.length})</h4>`;
      for (const q of completed) {
        html += `<div class="bg-slate-900/50 p-1.5 rounded border border-slate-800/60 text-slate-500 text-xs mb-1"><i class="fa-solid fa-check mr-1"></i>${q.title}</div>`;
      }
      html += "</div>";
    }

    if (failed.length > 0) {
      html += `<div class="mb-3"><h4 class="text-[10px] uppercase text-slate-500 font-bold mb-1.5 tracking-wider"><i class="fa-solid fa-skull mr-1"></i> Failed (${failed.length})</h4>`;
      for (const q of failed) {
        html += `<div class="bg-slate-900/50 p-1.5 rounded border border-slate-800/60 text-slate-500 text-xs mb-1"><i class="fa-solid fa-times mr-1"></i>${q.title}</div>`;
      }
      html += "</div>";
    }

    if (quests.length === 0) {
      html = `<li class="text-slate-500 text-center italic">No quests yet.</li>`;
    }

    container.innerHTML = html;
  },

  // ===========================================================================
  // Phase 3: Equipment Panel Rendering
  // ===========================================================================

  renderEquipmentPanel(): void {
    const container = document.getElementById("ui-equipment-list");
    if (!container) return;

    const equipped = EquipmentModule.getEquippedBySlot();
    const slots: Array<{ key: string; label: string; icon: string }> = [
      { key: "head", label: "Head", icon: "fa-hat-wizard" },
      { key: "neck", label: "Neck", icon: "fa-link" },
      { key: "chest", label: "Chest", icon: "fa-shirt" },
      { key: "arms", label: "Arms", icon: "fa-hand-fist" },
      { key: "hands", label: "Hands", icon: "fa-hand" },
      { key: "legs", label: "Legs", icon: "fa-shoe-prints" },
      { key: "feet", label: "Feet", icon: "fa-boot" },
      { key: "weapon", label: "Weapon", icon: "fa-gavel" },
      { key: "offhand", label: "Off-Hand", icon: "fa-shield" },
      { key: "ring", label: "Ring", icon: "fa-ring" },
      { key: "belt", label: "Belt", icon: "fa-belt" },
      { key: "back", label: "Back", icon: "fa-feather-pointed" },
      { key: "trinket", label: "Trinket", icon: "fa-gem" },
    ];

    let html = '<div class="grid grid-cols-2 gap-1">';
    for (const slot of slots) {
      const item = equipped[slot.key as keyof typeof equipped] as EquippedItem | null;
      if (item) {
        const rarityClass = EquipmentModule.getRarityClass(item.rarity);
        const statsStr = Object.entries(item.stats)
          .filter(([, v]) => v !== undefined && v !== 0)
          .map(([k, v]) => `${k}+${v}`)
          .join(" ");
        html += `
          <div class="eq-slot bg-slate-800 p-1.5 rounded border border-slate-700/60 text-center cursor-pointer hover:border-slate-500 transition group" title="${item.name}: ${statsStr}">
            <i class="fa-solid ${slot.icon} text-[8px] ${rarityClass} mb-0.5"></i>
            <div class="text-[8px] ${rarityClass} font-semibold truncate">${item.name}</div>
            <div class="text-[7px] text-slate-500 uppercase">${slot.label}</div>
          </div>`;
      } else {
        html += `
          <div class="eq-slot bg-slate-900/40 p-1.5 rounded border border-slate-800/40 text-center">
            <i class="fa-solid ${slot.icon} text-[8px] text-slate-700 mb-0.5"></i>
            <div class="text-[8px] text-slate-600 uppercase">${slot.label}</div>
          </div>`;
      }
    }
    html += "</div>";
    container.innerHTML = html;
  },

  // ===========================================================================
  // Phase 3: Economy Panel Rendering
  // ===========================================================================

  renderEconomyPanel(): void {
    const s = StateModule.state;
    const currenciesEl = document.getElementById("ui-currency-list");
    const txLogEl = document.getElementById("ui-transaction-log");
    if (!currenciesEl) return;

    if (!s.toggles.economy) {
      currenciesEl.innerHTML = `<li class="text-slate-500 text-center italic">Economy System Disabled.</li>`;
      return;
    }

    const currencies = s.currencies || [];
    const transactions = s.transactionLog || [];

    // Currency display
    let currencyHtml = "";
    for (const c of currencies) {
      const color = c.amount > 1000 ? "text-emerald-400" : c.amount > 0 ? "text-yellow-400" : "text-slate-500";
      currencyHtml += `
        <li class="flex justify-between bg-slate-800 p-1.5 rounded border border-slate-700/50 text-xs">
          <span class="text-slate-400 capitalize">${c.name}</span>
          <span class="${color} font-semibold">${c.amount.toLocaleString()}</span>
        </li>`;
    }
    currenciesEl.innerHTML = currencyHtml || `<li class="text-slate-500 italic text-xs">No currencies tracked.</li>`;

    // Transaction log
    if (txLogEl) {
      let txHtml = "";
      const recentTx = transactions.slice(-10).reverse();
      for (const tx of recentTx) {
        const typeIcon = tx.type === "buy" ? "fa-arrow-down text-red-400" :
                         tx.type === "sell" ? "fa-arrow-up text-green-400" :
                         tx.type === "reward" ? "fa-gift text-amber-400" :
                         "fa-gavel text-orange-400";
        txHtml += `
          <li class="flex justify-between items-center bg-slate-800/50 p-1.5 rounded border border-slate-700/30 text-[10px] mb-1">
            <div class="flex items-center gap-1.5">
              <i class="fa-solid ${typeIcon}"></i>
              <span class="text-slate-300">${tx.itemName}</span>
              ${tx.partner ? `<span class="text-slate-500">via ${tx.partner}</span>` : ""}
            </div>
            <span class="${tx.type === "buy" || tx.type === "fine" ? "text-red-400" : "text-green-400"} font-mono">
              ${tx.type === "buy" || tx.type === "fine" ? "-" : "+"}${tx.amount} ${tx.currency}
            </span>
          </li>`;
      }
      if (transactions.length === 0) {
        txHtml = `<li class="text-slate-500 italic text-xs">No transactions yet.</li>`;
      }
      txLogEl.innerHTML = txHtml;
    }
  },

  // ===========================================================================
  // Phase 5: NPC Profiles Panel Rendering
  // ===========================================================================

  renderNPCPanel(): void {
    const s = StateModule.state;
    const npcList = document.getElementById("ui-npc-list");
    if (!npcList) return;

    if (!s.toggles.npcDepth) {
      npcList.innerHTML = `<li class="text-slate-500 text-center italic">NPC Depth Disabled.</li>`;
      return;
    }

    const profiles = s.npcProfiles || [];
    if (profiles.length === 0) {
      npcList.innerHTML = `<li class="text-slate-500 text-center italic">No NPC profiles established yet.</li>`;
      return;
    }

    let html = "";
    for (const p of profiles) {
      const traitBadges = p.traits
        .map((t) => `<span class="text-[8px] px-1 rounded bg-slate-700 text-slate-300">${t}</span>`)
        .join(" ");

      const bar = (label: string, val: number, color: string) =>
        `<div class="flex items-center gap-1 mt-0.5"><span class="text-[8px] text-slate-500 w-14">${label}</span><div class="flex-1 bg-slate-700/50 rounded-full h-1"><div class="${color} h-1 rounded-full" style="width:${val}%"></div></div><span class="text-[8px] text-slate-400 w-6 text-right">${val}</span></div>`;

      html += `
        <div class="bg-slate-800 p-2 rounded border border-slate-700/60 mb-2">
          <div class="flex justify-between items-center mb-1">
            <span class="font-bold text-xs text-accent">${p.npcName}</span>
            ${p.knownLocation ? `<span class="text-[8px] text-slate-500"><i class="fa-solid fa-location-dot mr-0.5"></i>${p.knownLocation}</span>` : ""}
          </div>
          ${traitBadges ? `<div class="mb-1 flex flex-wrap gap-0.5">${traitBadges}</div>` : ""}
          ${bar("Trust", p.trust, "bg-blue-400")}
          ${bar("Affection", p.affection, "bg-pink-400")}
          ${p.loyalty != null ? bar("Loyalty", p.loyalty, "bg-emerald-400") : ""}
          ${p.desire != null ? bar("Desire", p.desire, "bg-red-400") : ""}
          ${bar("Aggro", p.aggressionThreshold, "bg-orange-400")}
          ${bar("Jealousy", p.jealousyThreshold, "bg-red-400")}
          ${p.equipment.length > 0 ? `<div class="mt-1 text-[8px] text-slate-500"><i class="fa-solid fa-gem mr-0.5"></i>${p.equipment.map((e) => e.name).join(", ")}</div>` : ""}
        </div>`;
    }
    npcList.innerHTML = html;
  },

  // ===========================================================================
  // Family: Household Panel Rendering
  // Mirrors the NPC Profiles panel but for the MC's registered family. The
  // panel is only shown when family exists (renderAllSidebars toggles it);
  // each card lists the member's name, role disposition, alive/deceased
  // status, and — when a profile exists — their Trust/Affection bars.
  // ===========================================================================

  renderHouseholdPanel(): void {
    const s = StateModule.state;
    const list = document.getElementById("ui-household-list");
    if (!list) return;

    const family = (s.memory.relations || []).filter(isFamilyRelation);
    if (family.length === 0) {
      list.innerHTML = `<li class="text-slate-500 text-center italic">No household — add family to the MC backstory.</li>`;
      return;
    }

    const bar = (label: string, val: number, color: string) =>
      `<div class="flex items-center gap-1 mt-0.5"><span class="text-[8px] text-slate-500 w-14">${label}</span><div class="flex-1 bg-slate-700/50 rounded-full h-1"><div class="${color} h-1 rounded-full" style="width:${val}%"></div></div><span class="text-[8px] text-slate-400 w-6 text-right">${val}</span></div>`;

    let html = "";
    for (const rel of family) {
      const isDead = rel.status === "Deceased";
      const profile = s.npcProfiles.find(
        (p) => p.npcName.toLowerCase() === rel.name.toLowerCase(),
      );
      const aliasStr =
        rel.aliases && rel.aliases.length > 0
          ? ` <span class="text-[8px] text-slate-500 normal-case">(aka ${this.escapeHtml(rel.aliases.join(", "))})</span>`
          : "";
      html += `
        <div class="bg-slate-800 p-2 rounded border ${isDead ? "border-red-900/60" : "border-emerald-800/50"} mb-2">
          <div class="flex justify-between items-center mb-0.5">
            <span class="font-bold text-xs ${isDead ? "text-red-400/80" : "text-emerald-300"}">${this.escapeHtml(rel.name)}${aliasStr}</span>
            <span class="text-[8px] uppercase tracking-wider ${isDead ? "text-red-400/80" : "text-emerald-400/80"}">${isDead ? "deceased" : "alive"}</span>
          </div>
          <div class="text-[9px] text-slate-400 leading-tight">${this.escapeHtml(rel.disposition || "family member")}</div>
          ${profile && !isDead ? `${bar("Trust", profile.trust, "bg-blue-400")}${bar("Affection", profile.affection, "bg-pink-400")}` : ""}
        </div>`;
    }
    list.innerHTML = html;
  },

  // ===========================================================================
  // Phase 5: Time States Panel Rendering
  // ===========================================================================

  renderTimeStatesPanel(): void {
    const s = StateModule.state;
    const tsList = document.getElementById("ui-time-state-list");
    if (!tsList) return;

    if (!s.toggles.time) {
      tsList.innerHTML = `<li class="text-slate-500 text-center italic">Time System Disabled.</li>`;
      return;
    }

    const activeStates = TimeStateModule.getAllActive();
    if (activeStates.length === 0) {
      tsList.innerHTML = `<li class="text-slate-500 text-center italic">No active time-based states.</li>`;
      return;
    }

    let html = "";
    for (const ts of activeStates) {
      const label = TimeStateModule.getSeverityLabel(ts.severity);
      const color = TimeStateModule.getSeverityColor(ts.severity);
      const mins = Math.ceil(ts.durationMinutes / 60);
      const hrs = Math.floor(mins / 60);
      const remMins = mins % 60;
      const timeStr = hrs > 0 ? `${hrs}h ${remMins}m` : `${remMins}m`;

      html += `
        <div class="bg-slate-800 p-2 rounded border border-slate-700/60 mb-2">
          <div class="flex justify-between items-center mb-1">
            <span class="font-bold text-xs text-white">${ts.name}</span>
            <span class="text-[8px] ${color} font-semibold">${label}</span>
          </div>
          <div class="text-[9px] text-slate-400 mb-1">Target: ${ts.target}</div>
          <div class="w-full bg-slate-700/50 rounded-full h-1.5 mb-1">
            <div class="${color.replace('text-', 'bg-')} h-1.5 rounded-full transition-all" style="width:${ts.severity}%"></div>
          </div>
          <div class="flex justify-between text-[8px] text-slate-500">
            <span>Severity: ${ts.severity}/100</span>
            <span>~${timeStr} remaining</span>
            <span>${ts.severityDeltaPerTick > 0 ? "⚠ worsening" : "💚 healing"}</span>
          </div>
          ${ts.description ? `<div class="text-[8px] text-slate-500 mt-1 italic">${ts.description}</div>` : ""}
        </div>`;
    }
    tsList.innerHTML = html;
  },

  // ===========================================================================
  // Phase 5: Gift Log Panel Rendering
  // ===========================================================================

  renderGiftPanel(): void {
    const s = StateModule.state;
    const giftList = document.getElementById("ui-gift-list");
    if (!giftList) return;

    if (!s.toggles.npcDepth) {
      giftList.innerHTML = `<li class="text-slate-500 text-center italic">NPC Depth Disabled.</li>`;
      return;
    }

    const gifts = GiftModule.getGiftHistory(15);
    if (gifts.length === 0) {
      giftList.innerHTML = `<li class="text-slate-500 text-center italic">No gifts exchanged yet.</li>`;
      return;
    }

    let html = "";
    for (const g of gifts) {
      const icon = g.accepted ? "fa-heart text-pink-400" : "fa-times text-red-400";
      html += `
        <div class="flex items-center gap-2 bg-slate-800/50 p-1.5 rounded border border-slate-700/30 text-[10px] mb-1">
          <i class="fa-solid ${icon} text-[8px]"></i>
          <span class="text-slate-300">${g.giver}</span>
          <span class="text-slate-500">→</span>
          <span class="text-slate-300">${g.recipient}</span>
          <span class="text-slate-500">|</span>
          <span class="text-accent">${g.itemName}</span>
          <span class="text-slate-500">|</span>
          <span class="text-emerald-400">${g.relationshipChange}</span>
        </div>`;
    }
    giftList.innerHTML = html;
  },

  // ===========================================================================
  // Phase 6: Secondary Stats Panel Rendering
  // ===========================================================================

  renderSecondaryStats(): void {
    const s = StateModule.state;
    const char = s.char;

    // Update values
    const setVal = (id: string, val: number) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(val);
    };

    setVal("ui-end", char.end);
    setVal("ui-wil", char.wil);
    setVal("ui-lck", char.lck);
    setVal("ui-per", char.per);

    // Show/hide based on genre
    const showEnd = GenreModule.shouldShowEnd();
    const showWil = GenreModule.shouldShowWil();
    const endEl = document.getElementById("ui-end-container");
    const wilEl = document.getElementById("ui-wil-container");
    if (endEl) endEl.style.display = showEnd ? "" : "none";
    if (wilEl) wilEl.style.display = showWil ? "" : "none";

    // Render genre tags in sidebar
    const genreTagsEl = document.getElementById("ui-genre-tags");
    if (genreTagsEl) {
      const active = GenreModule.getActive();
      if (active.length === 0) {
        genreTagsEl.innerHTML = '<span class="text-[9px] text-slate-600 italic">No genres selected</span>';
      } else {
        genreTagsEl.innerHTML = active.map(gid => {
          // Find genre label
          const genreMap: Record<string, { label: string; hue: string }> = {
            xianxia: { label: "Xianxia", hue: "#f59e0b" },
            wuxia: { label: "Wuxia", hue: "#d97706" },
            cultivation: { label: "Cultivation", hue: "#10b981" },
            medieval: { label: "Medieval", hue: "#f97316" },
            darkfantasy: { label: "Dark Fantasy", hue: "#8b5cf6" },
            school: { label: "School", hue: "#3b82f6" },
            urban: { label: "Urban", hue: "#06b6d4" },
            scifi: { label: "Sci-Fi", hue: "#14b8a6" },
            postapoc: { label: "Post-Apoc", hue: "#ef4444" },
            survival: { label: "Survival", hue: "#eab308" },
            isekai: { label: "Isekai", hue: "#a855f7" },
            romance: { label: "Romance", hue: "#ec4899" },
            harem: { label: "Harem", hue: "#f43f5e" },
            adult: { label: "Adult", hue: "#be185d" },
            horror: { label: "Horror", hue: "#6b7280" },
            thriller: { label: "Thriller", hue: "#475569" },
            historical: { label: "Historical", hue: "#92400e" },
          };
          const info = genreMap[gid] || { label: gid, hue: "#64748b" };
          return `<span class="text-[9px] px-1.5 py-0.5 rounded font-medium" style="color:${info.hue};background:${info.hue}25;border:1px solid ${info.hue}44">${info.label}</span>`;
        }).join("");
      }
    }
  },

  // ===========================================================================
  // Phase 6: Subskills Panel Rendering
  // ===========================================================================

  renderSubskillsPanel(): void {
    const listEl = document.getElementById("ui-subskills-list");
    if (!listEl) return;

    const available = GenreModule.getAvailableSubskills();
    if (available.length === 0) {
      listEl.innerHTML = '<li class="text-slate-500 italic text-xs">No subskills available.</li>';
      return;
    }

    // Group by tab
    const grouped = GenreModule.getSubskillsByTab();
    let html = "";
    for (const tab of TAB_ORDER) {
      const skills = grouped[tab] || [];
      if (skills.length === 0) continue;
      const meta = TAB_META[tab];
      html += `<div class="mt-2"><span class="text-[9px] font-bold uppercase tracking-wider" style="color:${meta?.color}"><i class="fa-solid ${meta?.icon} mr-0.5"></i>${meta?.label}</span>`;
      for (const sk of skills) {
        const val = GenreModule.computeSubskill(sk);
        html += `<div class="flex justify-between items-center bg-slate-800/60 px-2 py-1 rounded mt-1"><span class="text-[10px] text-slate-300">${sk.label}</span><span class="text-[10px] font-bold text-accent">${val}</span></div>`;
      }
      html += "</div>";
    }
    listEl.innerHTML = html;
  },

  renderMemoryPanel(): void {
    const s = StateModule.state;
    const factsList = document.getElementById("ui-memory-list");
    const relList = document.getElementById("ui-relation-list");
    if (!factsList || !relList) return;

    if (!s.toggles.memory) {
      factsList.innerHTML = `<li class="text-slate-500 text-center italic">Memory System Disabled.</li>`;
      relList.innerHTML = `<li class="text-slate-500 text-center italic">Memory System Disabled.</li>`;
      return;
    }

    const facts = s.memory.facts || [];
    const relations = s.memory.relations || [];

    if (facts.length === 0) {
      factsList.innerHTML = `<li class="text-slate-500 text-center italic">No facts established yet.</li>`;
    } else {
      factsList.innerHTML = facts
        .map((bundle) => {
          if (!bundle.entries || bundle.entries.length === 0) return "";
          return `
            <div class="bg-slate-800 p-2.5 rounded border border-slate-700/60 shadow-sm mb-2.5">
              <div class="font-bold text-emerald-400 text-xs flex justify-between items-center pb-1.5 border-b border-slate-700/40">
                <span><i class="fa-solid fa-folder-open mr-1.5 text-emerald-500"></i>${bundle.title || "General Facts"}</span>
                <span class="text-[9px] bg-slate-700 text-slate-300 px-1.5 rounded font-mono">${bundle.entries.length}</span>
              </div>
              <ul class="mt-2 space-y-1.5 pl-3.5 text-xs text-slate-300 border-l border-emerald-500/30">
                ${bundle.entries.map((e) => `<li>&bull; ${e}</li>`).join("")}
              </ul>
            </div>`;
        })
        .join("");
    }

    // Collect ALL unique NPC names from both sources
    const npcProfiles = s.npcProfiles || [];
    const nameSet = new Set<string>();
    relations.forEach(r => nameSet.add(r.name));
    npcProfiles.forEach(p => nameSet.add(p.npcName));

    if (nameSet.size === 0) {
      relList.innerHTML = `<li class="text-slate-500 text-center italic">No relationships established.</li>`;
    } else {
      // Build unified NPC cards from both data sources
      const allNPCs = Array.from(nameSet).map(name => {
        const rel = relations.find(r => r.name.toLowerCase() === name.toLowerCase());
        const profile = npcProfiles.find(p => p.npcName.toLowerCase() === name.toLowerCase());
        return { name, rel, profile };
      });

      // Separate living and deceased
      const living = allNPCs.filter(n => !n.rel || n.rel.status !== "Deceased");
      const deceased = allNPCs.filter(n => n.rel && n.rel.status === "Deceased");

      const livingHtml = living.map(n => {
        const r = n.rel;
        const p = n.profile;

        const modsHtml = r && r.modifiers && r.modifiers.length > 0
          ? r.modifiers.map((m: {name: string; duration: number}) =>
              `<span class="inline-block bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[9px] px-1.5 rounded font-semibold mr-1 mt-1"><i class="fa-solid fa-flask mr-1 text-[8px]"></i>${m.name} (${m.duration}t)</span>`
            ).join("")
          : "";

        // Traits
        const traitsHtml = p && p.traits && p.traits.length > 0
          ? `<div class="flex flex-wrap gap-1 mt-1">${p.traits.map((t: string) =>
              `<span class="text-[9px] px-1.5 py-0.5 rounded font-medium" style="color:#94a3b8;background:rgba(148,163,184,0.1);border:1px solid rgba(148,163,184,0.2)">${t}</span>`
            ).join("")}</div>`
          : "";

        // Affection / Trust / Loyalty / Desire bars
        const affinityHtml = (p && (p.affection != null || p.trust != null || p.loyalty != null || p.desire != null))
          ? `<div class="mt-1 space-y-0.5">
              ${p.affection != null ? `<div class="flex items-center gap-1.5"><span class="text-[9px] text-pink-400 w-16">Affection</span><div class="flex-1 bg-slate-900 rounded h-1.5"><div class="bg-pink-500 h-1.5 rounded" style="width:${p.affection}%"></div></div><span class="text-[9px] text-pink-300">${p.affection}</span></div>` : ""}
              ${p.trust != null ? `<div class="flex items-center gap-1.5"><span class="text-[9px] text-blue-400 w-16">Trust</span><div class="flex-1 bg-slate-900 rounded h-1.5"><div class="bg-blue-500 h-1.5 rounded" style="width:${p.trust}%"></div></div><span class="text-[9px] text-blue-300">${p.trust}</span></div>` : ""}
              ${p.loyalty != null ? `<div class="flex items-center gap-1.5"><span class="text-[9px] text-emerald-400 w-16">Loyalty</span><div class="flex-1 bg-slate-900 rounded h-1.5"><div class="bg-emerald-500 h-1.5 rounded" style="width:${p.loyalty}%"></div></div><span class="text-[9px] text-emerald-300">${p.loyalty}</span></div>` : ""}
              ${p.desire != null ? `<div class="flex items-center gap-1.5"><span class="text-[9px] text-red-400 w-16">Desire</span><div class="flex-1 bg-slate-900 rounded h-1.5"><div class="bg-red-500 h-1.5 rounded" style="width:${p.desire}%"></div></div><span class="text-[9px] text-red-300">${p.desire}</span></div>` : ""}
            </div>`
          : "";

        // Equipment
        const equipHtml = p && p.equipment && p.equipment.length > 0
          ? `<div class="mt-1"><span class="text-[9px] text-slate-500">Gear:</span> ${p.equipment.map((e: {name: string; rarity: string}) =>
              `<span class="text-[9px] px-1 rounded" style="color:${e.rarity === 'legendary' ? '#f59e0b' : e.rarity === 'epic' ? '#a855f7' : e.rarity === 'rare' ? '#3b82f6' : '#94a3b8'}">${e.name}</span>`
            ).join(" ")}</div>`
          : "";

        // Inter-NPC relationships
        const interRelHtml = p && p.relationships && p.relationships.length > 0
          ? `<div class="mt-1"><span class="text-[9px] text-slate-500">Relations:</span> ${p.relationships.map((rel: {targetName: string; disposition: string}) =>
              `<span class="text-[9px] text-slate-400">${rel.targetName} (${rel.disposition})</span>`
            ).join(" · ")}</div>`
          : "";

        // Location
        const locHtml = p && p.knownLocation
          ? `<div class="text-[9px] text-slate-500"><i class="fa-solid fa-location-dot mr-0.5"></i>${p.knownLocation}</div>`
          : "";

        // Schedule
        const schedHtml = p && p.schedule && p.schedule.length > 0
          ? `<div class="text-[9px] text-slate-500"><i class="fa-solid fa-clock mr-0.5"></i>${p.schedule.slice(0, 3).join(" → ")}</div>`
          : "";

        return `
            <li class="p-2.5 bg-slate-800 rounded border border-slate-700 fact-flash flex flex-col gap-1">
              <div class="flex justify-between items-start">
                <span class="font-bold text-accent text-xs flex items-center gap-1.5">
                  <i class="fa-solid fa-circle text-[8px] text-emerald-500 animate-pulse"></i> ${n.name}
                </span>
                <span class="text-[8px] text-emerald-400 bg-emerald-950/40 px-1 rounded border border-emerald-500/20 font-bold uppercase tracking-wider">Alive</span>
              </div>
              <div class="text-slate-300 text-xs leading-relaxed">${r ? r.disposition : 'No disposition recorded.'}</div>
              ${locHtml}${schedHtml}
              ${traitsHtml}
              ${affinityHtml}
              ${equipHtml}
              ${interRelHtml}
              ${modsHtml ? `<div class="mt-1 flex flex-wrap">${modsHtml}</div>` : ""}
            </li>`;
      }).join("");

      const deceasedHtml = deceased.map(n => `
            <li class="p-2 bg-slate-900/60 rounded border border-slate-800/80 text-slate-500 flex flex-col gap-1">
              <div class="flex justify-between items-start">
                <span class="font-semibold text-slate-500 text-xs line-through flex items-center gap-1.5">
                  <i class="fa-solid fa-skull text-slate-600"></i> ${n.name}
                </span>
                <span class="text-[8px] text-red-500 bg-red-950/20 px-1 rounded border border-red-500/20 font-bold uppercase tracking-wider">Deceased</span>
              </div>
            </li>`).join("");

      relList.innerHTML = `
        <div class="space-y-3">
          ${livingHtml || '<div class="text-slate-500 text-center italic text-xs">No active characters.</div>'}
          ${deceasedHtml ? `<div class="mt-4 pt-3 border-t border-slate-700/50"><h4 class="text-[10px] uppercase text-slate-500 font-bold mb-2 tracking-wider flex items-center gap-1"><i class="fa-solid fa-ghost"></i> Graveyard</h4><ul class="space-y-2">${deceasedHtml}</ul></div>` : ""}
        </div>`;
    }
  },

  renderHistory(): void {
    const container = document.getElementById("story-container");
    if (!container) return;
    container.innerHTML = "";
    StateModule.state.history.forEach((msg) => {
      let content = msg.content;
      if (msg.role === "assistant") {
        content = content
          .replace(/\[FACT\](.*?)\[\/FACT\]/gs, "")
          .replace(/\[RELATION\](.*?)\[\/RELATION\]/gs, "")
          .replace(/\[STATE_UPDATE\](.*?)\[\/STATE_UPDATE\]/gs, "")
          .replace(/\[FACT_RESET\](.*?)\[\/FACT_RESET\]/gs, "")
          .replace(/\[QUEST\](.*?)\[\/QUEST\]/gs, "")
          .replace(/\[EQUIPMENT\](.*?)\[\/EQUIPMENT\]/gs, "")
          .replace(/\[TRANSACTION\](.*?)\[\/TRANSACTION\]/gs, "")
          .replace(/\[OBJECTIVE_COMPLETE\](.*?)\[\/OBJECTIVE_COMPLETE\]/gs, "")
          .replace(/\[XP_GAIN\](.*?)\[\/XP_GAIN\]/gs, "")
          .replace(/\[SKILL_LEARNED\](.*?)\[\/SKILL_LEARNED\]/gs, "")
          .replace(/\[SKILL_UNLOCK\](.*?)\[\/SKILL_UNLOCK\]/gs, "")
          .replace(/\[CULTIVATION_CHANGE\](.*?)\[\/CULTIVATION_CHANGE\]/gs, "")
          .replace(/\[SCENE\](.*?)\[\/SCENE\]/gs, "")
          .replace(/\[SEASON_SHIFT\](.*?)\[\/SEASON_SHIFT\]/gs, "")
          .replace(/\[MEMORY_REF\](.*?)\[\/MEMORY_REF\]/gs, "")
          .trim();
      }
      const sender =
        msg.role === "user" ? "user" : msg.role === "system" ? "system" : "ai";
      this.appendChat(sender, content, true);
    });
  },

  escapeHtml(str: string): string {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },

  appendChat(sender: "user" | "ai" | "director" | "system", text: string, skipScroll = false): void {
    const container = document.getElementById("story-container");
    if (!container) return;
    const div = document.createElement("div");

    const formattedText = this.escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong class="text-white">$1</strong>')
      .replace(/\*(.*?)\*/g, '<em class="text-slate-300">$1</em>')
      .replace(/\n/g, "<br/>");

    if (sender === "user") {
      div.className = "flex justify-end mb-4";
      div.innerHTML = `<div class="max-w-[80%] bg-primary text-white p-4 rounded-2xl rounded-br-sm shadow-md">${formattedText}</div>`;
    } else if (sender === "system") {
      div.className = "flex justify-center mb-3";
      div.innerHTML = `
        <div class="max-w-[90%] border border-slate-700/60 bg-slate-800/40 text-slate-400 px-3 py-1.5 rounded-full text-xs text-center">
          <i class="fa-solid fa-arrow-right-arrow-left mr-1.5 text-slate-500"></i>${formattedText}
        </div>`;
    } else if (sender === "director") {
      div.className = "flex justify-start mb-3";
      div.innerHTML = `
        <div class="max-w-[90%] border border-dashed border-amber-500/40 bg-amber-950/20 text-amber-200/90 px-4 py-2.5 rounded-lg text-sm">
          <span class="text-[10px] uppercase tracking-wider text-amber-400/80 font-bold mr-2"><i class="fa-solid fa-clapperboard mr-1"></i>Director's Note</span>
          ${formattedText}
        </div>`;
    } else {
      div.className = "flex justify-start mb-6";
      div.innerHTML = `
        <div class="flex gap-3 max-w-[90%]">
          <div class="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center shrink-0 border border-slate-600 shadow-sm"><i class="fa-solid fa-robot text-accent text-sm"></i></div>
          <div class="bg-darkPanel border border-slate-700 text-slate-200 p-5 rounded-2xl rounded-tl-sm shadow-lg leading-relaxed text-md tracking-wide">${formattedText}</div>
        </div>`;
    }
    container.appendChild(div);
    if (!skipScroll) container.scrollTop = container.scrollHeight;
  },

  showLoading(show: boolean): void {
    document.getElementById("loading-indicator")?.classList.toggle("hidden", !show);
  },

  /**
   * Swap the loading pill's status text while a turn is in flight — e.g. the
   * coherence retry notice, so the player knows a rambling response is being
   * re-requested instead of staring at a silent spinner. No-ops when the
   * indicator or its text span is missing (e.g. in tests).
   */
  setLoadingStatus(text: string): void {
    const el = document.getElementById("loading-indicator") as HTMLElement | null;
    if (!el || typeof (el as unknown as { querySelector?: unknown }).querySelector !== "function") return;
    const span = el.querySelector("span");
    if (span) span.textContent = text;
  },

  showErrorBanner(message: string): void {
    const banner = document.getElementById("error-banner");
    const textEl = document.getElementById("error-banner-text");
    if (textEl) textEl.innerText = message;
    banner?.classList.remove("hidden");
  },

  hideErrorBanner(): void {
    document.getElementById("error-banner")?.classList.add("hidden");
  },

  _parseNoticeTimer: 0 as number | ReturnType<typeof setTimeout>,

  // ---- Local API auto-detection state ----
  _lastDetected: [] as DetectedServer[],
  _lastLanDetected: [] as DetectedServer[],
  _autoScanDone: false as boolean,
  _lanPrefillDone: false as boolean,
  _appliedServerId: "",
  /** Provider whose default was last applied to the model field, so reopening
   *  the modal doesn't clobber a saved model (e.g. a local ollama model name). */
  _lastApiProvider: "",

  // ---- Navbar live status badge ----
  _badgeServer: null as DetectedServer | null,
  _badgeTimer: 0 as number | ReturnType<typeof setInterval>,
  API_BADGE_INTERVAL_MS: 30000,

  /** Start the startup scan + periodic liveness refresh of the navbar badge. */
  initLocalApiBadge(): void {
    if (this._badgeTimer) return; // already running
    this._renderApiBadge("detecting");
    this._refreshLocalApiBadge(true);
    this._badgeTimer = setInterval(() => this._refreshLocalApiBadge(false), this.API_BADGE_INTERVAL_MS);
  },

  async _refreshLocalApiBadge(forceFullScan: boolean): Promise<void> {
    try {
      if (!forceFullScan && this._badgeServer) {
        // Connected: cheap single-endpoint liveness ping.
        const alive = await checkServerAlive(this._badgeServer);
        if (alive) {
          this._renderApiBadge("connected", this._badgeServer);
          return;
        }
        this._badgeServer = null; // went down — fall through to a full rescan
      }
      const servers = await detectLocalApis();
      this._badgeServer = servers[0] || null;
      this._renderApiBadge(this._badgeServer ? "connected" : "disconnected", this._badgeServer);
    } catch {
      this._renderApiBadge("disconnected");
    }
  },

  _renderApiBadge(state: "detecting" | "connected" | "disconnected", server: DetectedServer | null = null): void {
    const el = document.getElementById("api-badge");
    if (!el) return;
    const base =
      "whitespace-nowrap px-3 py-1.5 rounded text-sm transition border items-center gap-1.5 inline-flex ";
    if (state === "detecting") {
      el.className = base + "bg-slate-800 border-slate-700 text-slate-400";
      el.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin text-xs"></i>Detecting&hellip;';
      el.title = "Scanning for local AI servers...";
      return;
    }
    if (state === "connected" && server) {
      const port = server.baseUrl.split(":").pop() || "";
      el.className = base + "bg-emerald-950/40 border-emerald-600/40 text-emerald-300";
      el.innerHTML =
        `<i class="fa-solid fa-circle-check text-emerald-400"></i>${this.escapeHtml(server.name)}` +
        (port ? ` <span class="text-emerald-500/80 font-mono text-xs">:${this.escapeHtml(port)}</span>` : "");
      el.title = `${server.name} connected at ${server.chatUrl} — click to change API settings`;
      return;
    }
    el.className = base + "bg-slate-800 border-slate-700 text-slate-400";
    el.innerHTML = '<i class="fa-solid fa-server text-xs"></i>No local server';
    el.title = "No local AI server detected — click to open API settings";
  },

  showLevelUpNotice(newLevel: number, skillPoints: number): void {
    const notice = document.getElementById("level-up-notice");
    const textEl = document.getElementById("level-up-text");
    if (!notice || !textEl) return;
    textEl.innerText = `Level Up! Reached Level ${newLevel}${skillPoints > 0 ? ` | +${skillPoints} Skill Point(s)` : ""}`;
    notice.classList.remove("hidden");
    if (this._parseNoticeTimer) clearTimeout(this._parseNoticeTimer as ReturnType<typeof setTimeout>);
    this._parseNoticeTimer = setTimeout(() => notice.classList.add("hidden"), 5000);
  },

  showBreakthroughNotice(milestoneName: string): void {
    const notice = document.getElementById("level-up-notice");
    const textEl = document.getElementById("level-up-text");
    if (!notice || !textEl) return;
    textEl.innerText = `Breakthrough: ${milestoneName}`;
    notice.classList.remove("hidden");
    notice.classList.replace("bg-emerald-950/90", "bg-amber-950/90");
    notice.classList.replace("text-emerald-200", "text-amber-200");
    if (this._parseNoticeTimer) clearTimeout(this._parseNoticeTimer as ReturnType<typeof setTimeout>);
    this._parseNoticeTimer = setTimeout(() => {
      notice.classList.add("hidden");
      notice.classList.replace("bg-amber-950/90", "bg-emerald-950/40");
      notice.classList.replace("text-amber-200", "text-emerald-200");
    }, 5000);
  },

  showSkillLearnNotice(skillName: string): void {
    const notice = document.getElementById("level-up-notice");
    const textEl = document.getElementById("level-up-text");
    if (!notice || !textEl) return;
    textEl.innerText = `New Skill: ${skillName}`;
    notice.classList.remove("hidden");
    notice.classList.replace("bg-emerald-950/90", "bg-cyan-950/90");
    notice.classList.replace("text-emerald-200", "text-cyan-200");
    if (this._parseNoticeTimer) clearTimeout(this._parseNoticeTimer as ReturnType<typeof setTimeout>);
    this._parseNoticeTimer = setTimeout(() => {
      notice.classList.add("hidden");
      notice.classList.replace("bg-cyan-950/90", "bg-emerald-950/40");
      notice.classList.replace("text-cyan-200", "text-emerald-200");
    }, 4000);
  },

  showParseNotice(issues: Array<{ kind: string; error: string }>): void {
    const notice = document.getElementById("parse-notice");
    const textEl = document.getElementById("parse-notice-text");
    if (!notice || !textEl) return;
    const kinds = Array.from(new Set(issues.map((i) => i.kind))).join(", ");
    textEl.innerText = `Skipped ${issues.length} malformed AI update (${kinds}). Narrative kept; some state was not synced.`;
    notice.classList.remove("hidden");
    if (this._parseNoticeTimer) clearTimeout(this._parseNoticeTimer as ReturnType<typeof setTimeout>);
    this._parseNoticeTimer = setTimeout(() => notice.classList.add("hidden"), 6000);
  },

  hideParseNotice(): void {
    document.getElementById("parse-notice")?.classList.add("hidden");
  },

  showResumeBanner(): void {
    document.getElementById("resume-banner")?.classList.remove("hidden");
  },

  dismissResumeBanner(): void {
    document.getElementById("resume-banner")?.classList.add("hidden");
  },

  /** Resolver for the family-anchoring modal; set while the dialog is open. */
  _familyAnchorResolver: undefined as ((choice: boolean | null) => void) | undefined,

  /**
   * Show the in-app family-anchoring modal previewing each detected member
   * (name + role). Resolves true = keep anchoring, false = clean slate, or
   * null = the player chose "Edit backstory" (abort the start). Falls back to
   * a native confirm (or default-keep) when the modal markup is missing.
   */
  showFamilyAnchoringDialog(family: Relation[]): Promise<boolean | null> {
    const modal = document.getElementById("family-anchor-modal");
    const list = document.getElementById("family-anchor-list");
    if (!modal || !list) {
      const ask = (globalThis as { confirm?: (message?: string) => boolean }).confirm;
      const answer = typeof ask === "function" ? ask("Anchor the backstory family?") : true;
      return Promise.resolve(answer ? true : false);
    }
    list.innerHTML = family
      .map(
        (r) =>
          `<li class="flex justify-between bg-slate-800/70 p-2 rounded border border-slate-700/50 text-sm">` +
          `<span class="font-medium text-slate-200">${this.escapeHtml(r.name)}</span>` +
          `<span class="text-slate-400 italic">${this.escapeHtml(r.disposition || "family member")}</span>` +
          `</li>`,
      )
      .join("");
    modal.classList.remove("hidden");
    return new Promise((resolve) => {
      this._familyAnchorResolver = resolve;
    });
  },

  /**
   * Button handler for the family-anchoring modal: keep (true), clean slate
   * (false), or edit backstory (null → the game start aborts).
   */
  resolveFamilyAnchoring(choice: "keep" | "clean" | "edit"): void {
    const modal = document.getElementById("family-anchor-modal");
    if (modal) modal.classList.add("hidden");
    const resolver = this._familyAnchorResolver;
    this._familyAnchorResolver = undefined;
    if (!resolver) return;
    resolver(choice === "keep" ? true : choice === "clean" ? false : null);
  },

  toggleSettings(): void {
    const modal = document.getElementById("settings-modal");
    if (!modal) return;
    modal.classList.toggle("hidden");
    if (!modal.classList.contains("hidden")) {
      // Allow one fresh auto-scan per modal session.
      this._autoScanDone = false;
      this._appliedServerId = "";
      const api = StateModule.state.api;
      (document.getElementById("api-provider") as HTMLSelectElement).value = api.provider;
      (document.getElementById("api-key") as HTMLInputElement).value = api.key;
      (document.getElementById("api-url") as HTMLInputElement).value = api.url;
      (document.getElementById("api-model") as HTMLInputElement).value = api.model;
      const retryChk = document.getElementById("api-retry-rambling") as HTMLInputElement | null;
      if (retryChk) retryChk.checked = api.retryOnRambling !== false;
      // Remember which provider the saved model belongs to, so updateApiFields()
      // below doesn't reset it to the provider default on a mere modal open.
      this._lastApiProvider = api.provider;
      this.updateApiFields();
      if (!this._lanPrefillDone) {
        this._lanPrefillDone = true;
        this._prefillLanSubnet();
      }
    }
  },

  updateApiFields(): void {
    const provider = (document.getElementById("api-provider") as HTMLSelectElement).value;
    const urlCont = document.getElementById("api-url-container");
    const keyCont = document.getElementById("api-key-container");
    const modelInput = document.getElementById("api-model") as HTMLInputElement;
    const modelHint = document.getElementById("api-model-hint");

    // Show/hide URL and Key fields based on provider type
    const isLocal = provider === "local" || provider === "custom";
    const needsKey = provider !== "local"; // local doesn't need API key

    if (urlCont) {
      urlCont.classList.toggle("hidden", !isLocal);
    }
    if (keyCont) {
      keyCont.classList.toggle("hidden", !needsKey);
    }

    // Auto-detect panel: show for local/custom providers and scan once per modal session.
    const detectCont = document.getElementById("api-detect-container");
    if (detectCont) {
      detectCont.classList.toggle("hidden", !isLocal);
    }
    if (isLocal && !this._autoScanDone) {
      this._autoScanDone = true;
      this.runLocalDetection();
    }

    // Smart model defaults per provider
    const modelDefaults: Record<string, { model: string; hint: string }> = {
      gemini:   { model: "gemini-2.5-flash", hint: "Free tier: gemini-2.5-flash, gemini-2.0-flash" },
      openai:   { model: "gpt-4o", hint: "Try gpt-4o, gpt-4o-mini, or o1" },
      claude:   { model: "claude-sonnet-4-20250514", hint: "Try claude-sonnet-4-20250514, claude-opus-4-20250514" },
      deepseek: { model: "deepseek-v4-flash", hint: "Try deepseek-v4-flash (deepseek-v4-pro coming soon). Key optional in dev: the server proxy uses DEEPSEEK_API_KEY." },
      groq:     { model: "llama-3.3-70b-versatile", hint: "Try llama-3.3-70b-versatile, mixtral-8x7b-32768" },
      together: { model: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free", hint: "Try meta-llama/Llama-3.3-70B-Instruct-Turbo-Free" },
      mistral:  { model: "mistral-large-latest", hint: "Try mistral-large-latest, mistral-small-latest" },
      local:    { model: "llama3.2", hint: "Must match an ollama pull'd model name" },
      custom:   { model: "", hint: "Enter model name expected by your endpoint" },
    };

    const defaults = modelDefaults[provider];
    if (defaults) {
      // Reset the model field only when the provider actually changed (or the
      // field is empty). Reopening the modal must keep the saved model intact.
      const providerChanged = provider !== this._lastApiProvider;
      if (providerChanged || !modelInput.value.trim()) {
        modelInput.value = defaults.model;
      }
      if (modelHint) modelHint.innerText = defaults.hint;
    }
    this._lastApiProvider = provider;

    // DeepSeek with no key: report whether the dev-server proxy is available
    // so the "no key needed" flow is visible. Silent on failure (e.g. the
    // single-file build, where there is no server to ask).
    if (provider === "deepseek" && !(document.getElementById("api-key") as HTMLInputElement).value.trim()) {
      fetch("/api/deepseek/status")
        .then((r) => r.json().catch(() => null))
        .then((s: { configured?: boolean } | null) => {
          if (!modelHint) return;
          if (s && s.configured) {
            modelHint.innerText = "\u2713 Proxy ready \u2014 DEEPSEEK_API_KEY is set server-side, no key needed here.";
          } else if (s && !s.configured) {
            modelHint.innerText = "Proxy has no key \u2014 set DEEPSEEK_API_KEY when starting the dev server, or paste a key below.";
          }
        })
        .catch(() => {
          /* no server (e.g. static build) — keep the default hint */
        });
    }
  },

  // -------------------------------------------------------------------------
  // Local API auto-detection
  // -------------------------------------------------------------------------

  runLocalDetection(): void {
    const statusEl = document.getElementById("api-detect-status");
    const resultsEl = document.getElementById("api-detect-results");
    const btn = document.getElementById("api-detect-btn") as HTMLButtonElement | null;
    if (!statusEl || !resultsEl) return;

    statusEl.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Scanning localhost for running AI servers&hellip;';
    resultsEl.innerHTML = "";
    if (btn) btn.disabled = true;

    detectLocalApis()
      .then((servers) => {
        if (btn) btn.disabled = false;
        this._lastDetected = servers;
        this._appliedServerId = "";
        if (servers.length === 0) {
          statusEl.innerHTML =
            '<i class="fa-solid fa-circle-xmark text-red-400 mr-1"></i>No local AI servers detected. Start Ollama or LM Studio, then scan again.';
          this._rerenderDetectedResults();
          return;
        }
        statusEl.innerHTML =
          `<i class="fa-solid fa-circle-check text-emerald-400 mr-1"></i>Found ${servers.length} local AI server${servers.length === 1 ? "" : "s"}. Click one to apply it, or pick a model chip.`;
        this._rerenderDetectedResults();
      })
      .catch(() => {
        if (btn) btn.disabled = false;
        statusEl.innerHTML =
          '<i class="fa-solid fa-triangle-exclamation text-amber-400 mr-1"></i>Scan failed unexpectedly. Try again.';
      });
  },

  serverCardHtml(server: DetectedServer, mode: "local" | "lan" = "local"): string {
    const applyFn = mode === "lan" ? "applyLanServer" : "applyDetectedServer";
    const modelFn = mode === "lan" ? "applyLanModel" : "applyDetectedModel";
    const chips = server.models.length
      ? server.models
          .map(
            (m, i) =>
              `<button type="button" onclick="UIManager.${modelFn}('${server.id}', ${i})" class="px-2 py-0.5 bg-slate-800 hover:bg-emerald-900/50 border border-slate-600 hover:border-emerald-600 rounded text-[10px] font-mono text-slate-300 transition" title="Use this model">${this.escapeHtml(m)}</button>`,
          )
          .join("")
      : '<span class="text-[10px] text-slate-500 italic">No models listed &mdash; pull/load one first</span>';
    const applied = server.id === this._appliedServerId;
    return `
      <div class="p-3 bg-slate-800/70 border ${applied ? "border-emerald-500 bg-emerald-950/30" : "border-emerald-700/40"} rounded-lg">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="text-sm font-semibold text-emerald-300 flex items-center gap-2">
              <i class="fa-solid fa-server text-[10px]"></i>${this.escapeHtml(server.name)}
              <span class="text-[9px] bg-slate-700 text-slate-400 px-1.5 py-0.5 rounded uppercase tracking-wider">${server.kind}</span>
            </div>
            <div class="text-[10px] text-slate-400 font-mono truncate mt-0.5">${this.escapeHtml(server.chatUrl)}</div>
          </div>
          <button type="button" onclick="UIManager.${applyFn}('${server.id}')" class="shrink-0 px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 rounded text-[11px] font-bold text-white transition">${applied ? "\u2713 Applied" : "Use"}</button>
        </div>
        <div class="flex flex-wrap gap-1 mt-2">${chips}</div>
      </div>`;
  },

  _rerenderDetectedResults(): void {
    const resultsEl = document.getElementById("api-detect-results");
    if (resultsEl) {
      resultsEl.innerHTML = this._lastDetected.map((s) => this.serverCardHtml(s, "local")).join("");
    }
    const lanEl = document.getElementById("api-lan-results");
    if (lanEl) {
      lanEl.innerHTML = this._lastLanDetected.map((s) => this.serverCardHtml(s, "lan")).join("");
    }
  },

  /** Fill provider/url/model from a server, then refresh the result cards. */
  _applyServer(server: DetectedServer): void {
    const providerSelect = document.getElementById("api-provider") as HTMLSelectElement;
    const urlInput = document.getElementById("api-url") as HTMLInputElement;
    const modelInput = document.getElementById("api-model") as HTMLInputElement;
    if (!providerSelect || !urlInput || !modelInput) return;

    // callLocal() speaks both the Ollama chat format and the OpenAI-compatible
    // chat format, so every detected server maps to the "local" provider.
    providerSelect.value = "local";
    this.updateApiFields(); // reveal URL field; reset model to its default
    urlInput.value = server.chatUrl;
    if (server.models.length > 0) modelInput.value = server.models[0];

    this._appliedServerId = server.id;
    this._rerenderDetectedResults();

    // Applying a detected server instantly validates it against the endpoint.
    this.testApiConnection();
  },

  applyDetectedServer(id: string): void {
    const server = this._lastDetected.find((s) => s.id === id);
    if (server) this._applyServer(server);
  },

  applyLanServer(id: string): void {
    const server = this._lastLanDetected.find((s) => s.id === id);
    if (server) this._applyServer(server);
  },

  /** Pick a specific model without changing the URL (localhost or LAN). */
  applyDetectedModel(id: string, index: number): void {
    const server =
      this._lastDetected.find((s) => s.id === id) || this._lastLanDetected.find((s) => s.id === id);
    if (!server) return;
    const model = server.models[index];
    if (!model) return;
    const modelInput = document.getElementById("api-model") as HTMLInputElement;
    if (modelInput) modelInput.value = model;
  },

  applyLanModel(id: string, index: number): void {
    this.applyDetectedModel(id, index);
  },

  /** Prefill the subnet box from the page origin IP, else a WebRTC guess. */
  async _prefillLanSubnet(): Promise<void> {
    const input = document.getElementById("api-lan-subnet") as HTMLInputElement;
    if (!input || input.value.trim()) return;
    const host = window.location.hostname;
    if (host && host !== "localhost" && host !== "127.0.0.1" && /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      input.value = subnetFromIp(host);
      return;
    }
    const ip = await guessLocalIp();
    if (ip && input && !input.value.trim()) input.value = subnetFromIp(ip);
  },

  /** Send a tiny prompt to the provider currently configured in the form. */
  testApiConnection(): void {
    const btn = document.getElementById("api-test-btn") as HTMLButtonElement | null;
    const statusEl = document.getElementById("api-test-status");
    if (!statusEl) return;

    const config: ApiConfig = {
      provider: (document.getElementById("api-provider") as HTMLSelectElement)
        .value as ApiConfig["provider"],
      key: (document.getElementById("api-key") as HTMLInputElement).value,
      url: (document.getElementById("api-url") as HTMLInputElement).value,
      model: (document.getElementById("api-model") as HTMLInputElement).value,
    };

    // Warn instead of testing when the provider strictly requires a key and
    // none is entered — the call would only fail with "API Key missing.".
    // DeepSeek is exempt: with no key it routes through the dev-server proxy
    // (src/server/deepseek-proxy.ts), which holds DEEPSEEK_API_KEY server-side.
    if (
      providerNeedsApiKey(config.provider) &&
      !config.key.trim() &&
      config.provider !== "deepseek"
    ) {
      statusEl.innerHTML =
        `<i class="fa-solid fa-triangle-exclamation text-amber-400 mr-1"></i>${this.escapeHtml(config.provider)} requires an API key &mdash; enter it above, or pick a Local / Custom endpoint that doesn't need one.`;
      return;
    }

    if (btn) btn.disabled = true;
    statusEl.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Testing connection&hellip;';

    ApiModule.testConnection(config)
      .then((result) => {
        if (btn) btn.disabled = false;
        if (result.ok) {
          const reply = result.reply
            ? ` &mdash; replied: &ldquo;${this.escapeHtml(result.reply)}&rdquo;`
            : "";
          statusEl.innerHTML =
            `<i class="fa-solid fa-circle-check text-emerald-400 mr-1"></i>Connected in ${(result.latencyMs / 1000).toFixed(1)}s${reply}`;
        } else {
          statusEl.innerHTML =
            `<i class="fa-solid fa-circle-xmark text-red-400 mr-1"></i>Connection failed (${(result.latencyMs / 1000).toFixed(1)}s): ${this.escapeHtml(result.error || "Unknown error.")}`;
        }
      })
      .catch(() => {
        if (btn) btn.disabled = false;
        statusEl.innerHTML =
          '<i class="fa-solid fa-triangle-exclamation text-amber-400 mr-1"></i>Test failed unexpectedly.';
      });
  },

  /** Scan the local network for Ollama / LM Studio instances. */
  async runLanScan(): Promise<void> {
    const input = document.getElementById("api-lan-subnet") as HTMLInputElement;
    const statusEl = document.getElementById("api-lan-status");
    const resultsEl = document.getElementById("api-lan-results");
    const btn = document.getElementById("api-lan-btn") as HTMLButtonElement | null;
    if (!input || !statusEl || !resultsEl) return;

    if (!input.value.trim()) await this._prefillLanSubnet();
    const subnet = input.value.trim();
    const ips = expandSubnet(subnet);
    if (ips.length === 0) {
      statusEl.innerHTML =
        '<i class="fa-solid fa-circle-xmark text-red-400 mr-1"></i>Invalid subnet &mdash; try e.g. <code>192.168.1.0/24</code>, <code>192.168.1.1-50</code>, or a single IP.';
      return;
    }
    if (btn) btn.disabled = true;
    statusEl.innerHTML =
      `<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Scanning ${ips.length} host${ips.length === 1 ? "" : "s"} on ports 11434 &amp; 1234&hellip;`;
    resultsEl.innerHTML = "";
    this._appliedServerId = "";

    try {
      const servers = await scanLanForApis(subnet, (p) => {
        statusEl.innerHTML =
          `<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Scanning ${p.done} of ${p.total} hosts on ports 11434 &amp; 1234&hellip;`;
      });
      this._lastLanDetected = servers;
      if (btn) btn.disabled = false;
      if (servers.length === 0) {
        statusEl.innerHTML =
          '<i class="fa-solid fa-circle-xmark text-red-400 mr-1"></i>No Ollama / LM Studio instances found on this range. Remote Ollama must run with OLLAMA_HOST=0.0.0.0 and OLLAMA_ORIGINS set.';
        return;
      }
      statusEl.innerHTML =
        `<i class="fa-solid fa-circle-check text-emerald-400 mr-1"></i>Found ${servers.length} server${servers.length === 1 ? "" : "s"} on your network. Click one to use it.`;
      resultsEl.innerHTML = servers.map((s) => this.serverCardHtml(s, "lan")).join("");
    } catch {
      if (btn) btn.disabled = false;
      statusEl.innerHTML =
        '<i class="fa-solid fa-triangle-exclamation text-amber-400 mr-1"></i>Scan failed unexpectedly. Try again.';
    }
  },

  switchLoreTab(tab: "facts" | "relations" | "quests"): void {
    const tabFacts = document.getElementById("tab-facts");
    const tabRelations = document.getElementById("tab-relations");
    const tabQuests = document.getElementById("tab-quests");
    const listFacts = document.getElementById("ui-memory-list");
    const listRelations = document.getElementById("ui-relation-list");
    const listQuests = document.getElementById("ui-quest-list");
    const loreDesc = document.getElementById("lore-desc");
    if (!tabFacts || !tabRelations) return;

    // Reset all tabs
    const resetTab = (el: Element | null, active: boolean) => {
      if (!el) return;
      el.className = active
        ? "flex-1 py-2 text-emerald-400 border-b-2 border-emerald-400 transition"
        : "flex-1 py-2 text-slate-400 border-b-2 border-transparent hover:text-slate-200 transition";
    };
    resetTab(tabFacts, false);
    resetTab(tabRelations, false);
    resetTab(tabQuests, false);

    if (listFacts) listFacts.classList.add("hidden");
    if (listRelations) listRelations.classList.add("hidden");
    if (listQuests) listQuests.classList.add("hidden");

    if (tab === "facts") {
      resetTab(tabFacts, true);
      if (listFacts) listFacts.classList.remove("hidden");
      if (loreDesc)
        loreDesc.innerText = "Persistent facts, distances, and prices extracted by the engine.";
    } else if (tab === "relations") {
      resetTab(tabRelations, true);
      if (listRelations) listRelations.classList.remove("hidden");
      if (loreDesc)
        loreDesc.innerText =
          "Tracked allegiances, dispositions, and relationship statuses with NPCs.";
    } else if (tab === "quests" && tabQuests && listQuests) {
      resetTab(tabQuests, true);
      if (listQuests) listQuests.classList.remove("hidden");
      if (loreDesc)
        loreDesc.innerText = "Active quests, objectives, and completed missions.";
    }
  },

  showItemDetails(idx: number): void {
    const item = StateModule.state.char.inventory[idx];
    if (!item) return;

    const nameEl = document.getElementById("modal-item-name");
    if (nameEl) nameEl.innerText = item.name;
    const body = document.getElementById("modal-item-body");
    if (!body) return;

    let propsHtml: string;
    if (item.props && Object.keys(item.props).length > 0) {
      propsHtml = Object.entries(item.props)
        .map(
          ([key, val]) => `
            <div class="flex justify-between border-b border-slate-700/50 py-1 text-sm">
              <span class="text-slate-400 capitalize">${key.replace(/_/g, " ")}</span>
              <span class="text-accent font-semibold">${val}</span>
            </div>`,
        )
        .join("");
    } else {
      propsHtml = `<p class="text-slate-500 italic text-xs">No extra properties defined.</p>`;
    }

    body.innerHTML = `
      <div>
        <span class="text-xs uppercase text-slate-500 font-bold">Description</span>
        <p class="text-slate-300 text-sm mt-1">${item.desc || "No description available."}</p>
      </div>
      <div class="mt-4">
        <span class="text-xs uppercase text-slate-500 font-bold">Metadata Properties</span>
        <div class="mt-2 bg-slate-800/50 p-3 rounded-lg border border-slate-700/30">${propsHtml}</div>
      </div>
      ${item.qty ? `<div class="mt-2 text-xs text-slate-400"><strong>Quantity:</strong> ${item.qty}</div>` : ""}`;
    this.toggleDetailsModal();
  },

  toggleDetailsModal(): void {
    document.getElementById("details-modal")?.classList.toggle("hidden");
  },

  // ===========================================================================
  // Phase 2: Token Meter
  // ===========================================================================

  updateTokenMeter(estimatedTokens: number): void {
    const el = document.getElementById("token-meter-value");
    const bar = document.getElementById("token-meter-bar");
    const label = document.getElementById("token-meter-label");
    if (!el || !bar || !label) return;

    const softCap = 128_000;
    const pct = Math.min(100, (estimatedTokens / softCap) * 100);

    el.innerText = `${estimatedTokens.toLocaleString()} tokens`;

    let color = "text-emerald-400";
    if (pct > 95) color = "text-red-500";
    else if (pct > 80) color = "text-orange-400";
    else if (pct > 50) color = "text-yellow-400";

    el.className = `text-xs font-mono ${color}`;

    bar.style.width = `${pct}%`;

    bar.className = `h-1.5 rounded-full transition-all duration-500 ${
      pct > 95
        ? "bg-red-500"
        : pct > 80
          ? "bg-orange-400"
          : pct > 50
            ? "bg-yellow-400"
            : "bg-emerald-400"
    }`;

    const remaining = Math.max(0, softCap - estimatedTokens);
    label.innerText = `~${remaining.toLocaleString()} tokens remaining`;
  },
};
