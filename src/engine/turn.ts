// =============================================================================
// turn.ts — Phase 2: Integrated rolling summarization + token meter.
// Phase 3: Quest/equipment/economy parser integration.
// =============================================================================

import { ApiConfig } from "../state/GameState";
import { StateModule } from "../state/state";
import { StorageModule } from "../storage/save";
import { LoreModule, cleanHistoryTags, stripThinkBlocks } from "./lore";
import { buildSystemPrompt } from "./prompt";
import { ApiModule, formatRetryStatus } from "../api/providers";
import { UIManager } from "../ui/UIManager";
import { initSummarizer, getCompressedHistory, prepareContext } from "./summarizer";
import { estimatePromptSize } from "./token-estimator";
import { TimeStateModule } from "./time-states";
import { tickSkillEffects } from "./skill-effects";
import { createDirectorNote, advanceDirectorNotes, rewordFiredNote } from "./director-notes";
import {
  seedFamilyRelations,
  getRememberedFamilyAnchoring,
  getDetectedFamily,
  rememberFamilyAnchoring,
  detectRelationDirective,
  detectFactReassignmentDirective,
  applyFactReassignment,
  detectNamingDirective,
} from "./family";
import { getEffectiveStats } from "./equipment";
import { getCanonicalSeason } from "./seasons";
import { runStructuredFallback } from "./structured-fallback";
import { analyzeCoherence, retryWithSimplePrompt } from "./coherence";
import { NPCProfileModule } from "./npc-profile";
import { VacuumSafetyModule } from "./vacuum-safety";
import { CheckModule, getMomentumReminder, getEscalationReminder } from "./stat-checks";
import { ActionMemoryModule } from "./action-memory";

const INIT_PROMPT =
  "Start the novel. Introduce the world based on the settings, and place the main character in their starting situation. Introduce the current scene and options. End with a prompt asking the user what they do.";

export const GameEngine = {
  /**
   * "Start Fresh" — a genuinely new beginning. Drops any old autosave (whose
   * NPCs/relations would otherwise resurrect on the next page reload via the
   * Resume banner) and hides the banner; the setup form stays for the player.
   */
  startFresh(): void {
    StorageModule.clearAutosave();
    UIManager.dismissResumeBanner();
  },

  async startGenerator(): Promise<void> {
    StateModule.buildFromUI();
    // Starting a new game invalidates any old autosave immediately — otherwise
    // a reload before the first turn completes would resurrect the previous
    // game (with its NPC profiles) through the Resume banner.
    StorageModule.clearAutosave();
    const backstory = StateModule.state.char.appearance;
    // Family anchoring is opt-in per game: when the backstory mentions family,
    // the in-app modal previews the detected members (name + role) and offers
    // Keep family / Clean slate / Edit backstory. A remembered answer for the
    // same backstory is honored without asking.
    let keep = getRememberedFamilyAnchoring(backstory);
    if (keep === null) {
      keep = await UIManager.showFamilyAnchoringDialog(getDetectedFamily(backstory));
      if (keep === null) {
        // "Edit backstory": abort the start; focus the field so the player can
        // rework it and click Start again (which re-evaluates the new text).
        document.getElementById("setup-mc-appearance")?.focus();
        return;
      }
      rememberFamilyAnchoring(backstory, keep);
    }
    if (keep) {
      // Anchor family members named in the backstory as real relationships so
      // the AI never "forgets" the mother/sister it was told about at setup.
      if (seedFamilyRelations(backstory) > 0) {
        UIManager.renderMemoryPanel();
        StorageModule.autosave();
      }
    }
    UIManager.transitionToGame();
    UIManager.renderAllSidebars();

    // Phase 2: Initialize the summarizer.
    initSummarizer();

    const container = document.getElementById("story-container");
    if (container) container.innerHTML = "";
    StateModule.state.history = [];

    void this.executeTurn(INIT_PROMPT, true);
  },

  resumeAutosave(): void {
    const saved = StorageModule.loadAutosave();
    if (!saved) {
      UIManager.dismissResumeBanner();
      return;
    }
    StateModule.replaceState(saved);
    // Anchor backstory family (idempotent — also covers saves made before
    // family seeding existed, so an ongoing game gains its household now).
    if (seedFamilyRelations(StateModule.state.char.appearance) > 0) {
      UIManager.renderMemoryPanel();
      StorageModule.autosave();
    }
    // Clean leaked engine tags out of turns stored before the tag normalizer
    // existed, and persist the cleanup so reloads stay clean.
    const cleaned = cleanHistoryTags(StateModule.state.history);
    if (cleaned > 0) {
      console.info(`Cleaned leaked engine tags from ${cleaned} stored history message(s)`);
      StorageModule.autosave();
    }
    UIManager.transitionToGame();
    UIManager.renderAllSidebars();
    UIManager.renderHistory();

    // Phase 2: Re-initialize summarizer with existing history.
    initSummarizer();
  },

  submitAction(e: Event): void {
    e.preventDefault();
    const inputEl = document.getElementById("user-input") as HTMLInputElement | null;
    if (!inputEl) return;
    const text = inputEl.value.trim();
    if (!text) return;

    inputEl.value = "";
    UIManager.appendChat("user", text);
    void this.executeTurn(text, false);
  },

  /**
   * Inject a Director's Note — an author-supplied world event/situation that
   * is fed to the AI every turn (via the system prompt) without pretending
   * the MC said it. Returns false when the text is empty.
   */
  addDirectorNote(text: string): boolean {
    if (!text.trim()) return false;
    // Notes phrased as registration directives ("Add librarian Elle to
    // relationship and NPC list") are honored mechanically — the engine
    // registers the person instead of hoping the AI acts on an instruction
    // it is told to treat as an in-world event.
    const directive = detectRelationDirective(text);
    const factFix = detectFactReassignmentDirective(text);
    const naming = detectNamingDirective(text);
    const note = createDirectorNote(text);
    if (directive) {
      note.directive = { name: directive.name, disposition: directive.disposition };
      LoreModule.applyRelationUpdate(directive);
      UIManager.renderMemoryPanel();
      UIManager.renderAllSidebars();
    }
    if (naming) {
      // "the mother's name is Diane" — rename the role-titled entry (old
      // title kept as an alias) so the name replaces "Mother" everywhere.
      LoreModule.applyRelationUpdate(naming.update);
      note.naming = { name: naming.update.name, role: naming.role };
      UIManager.renderMemoryPanel();
      UIManager.renderAllSidebars();
    }
    if (factFix) {
      // "that fact was about my Dad, not the neighbor" — rewrite the stored
      // fact's person mechanically (resolved to the canonical relation name),
      // then keep the note so the prompt renders the corrected attribution.
      const applied = applyFactReassignment(factFix);
      note.factFix = { oldPhrase: factFix.oldPhrase, newName: applied.newName };
      UIManager.renderMemoryPanel();
    }
    StateModule.state.directorNotes.push(note);
    UIManager.appendChat("director", note.text);
    UIManager.renderDirectorNotes();
    StorageModule.autosave();
    return true;
  },

  /** Remove a Director's Note by index. */
  removeDirectorNote(index: number): void {
    const notes = StateModule.state.directorNotes;
    if (index >= 0 && index < notes.length) {
      notes.splice(index, 1);
      UIManager.renderDirectorNotes();
      StorageModule.autosave();
    }
  },

  submitDirectorNote(e: Event): void {
    e.preventDefault();
    const inputEl = document.getElementById("director-input") as HTMLInputElement | null;
    if (!inputEl) return;
    const text = inputEl.value;
    inputEl.value = "";
    this.addDirectorNote(text);
  },

  async executeTurn(userText: string, isInitial: boolean): Promise<void> {
    UIManager.showLoading(true);
    const inputEl = document.getElementById("user-input") as HTMLInputElement | null;
    if (inputEl) inputEl.disabled = true;

    // Advance the global turn counter (used by director-note deadlines).
    StateModule.state.turnCount += 1;

    // Tick down temporary NPC status modifiers.
    if (!isInitial) {
      (StateModule.state.memory.relations || []).forEach(function(char: { modifiers?: Array<{ name: string; duration: number }> }) {
        if (char.modifiers && char.modifiers.length > 0) {
          char.modifiers = char.modifiers
            .map(function(m: { name: string; duration: number }) { return { ...m, duration: m.duration - 1 }; })
            .filter(function(m: { name: string; duration: number }) { return m.duration > 0; });
        }
      });

      // Phase 5: Tick time-based states forward by ~10 minutes per turn
      TimeStateModule.tick(10);

      // Phase 5b: Active skill effects (Charm Aura, Shadow Step, ...) tick
      // down the same ~10 in-game minutes per turn and are removed from
      // Active Modifiers when their remaining time hits zero — so the bonus
      // genuinely fades and witnesses/stat warmth return when it expires.
      tickSkillEffects();
    }

    // Advance timed director notes and surface newly-fired events as log entries.
    const firedNotes = advanceDirectorNotes();
    // Persisted into history as "system" entries (in live chat order: right
    // after the user's action, before any reaction lines) so fired events
    // survive reloads instead of vanishing with the DOM.
    const firedNoteLines: string[] = [];
    for (const note of firedNotes) {
      const line = `⏰ EVENT NOW: ${rewordFiredNote(note)}`;
      firedNoteLines.push(line);
      UIManager.appendChat("director", line);
    }

    const sysPrompt = buildSystemPrompt();

    // Phase 2: Compress history via summarizer.
    prepareContext();
    const compressedHistory = getCompressedHistory();

    let payloadText = userText;

    const s = StateModule.state;
    const eff = getEffectiveStats();

    // Coordination bonus: when the action explicitly works WITH a companion
    // (by name/alias), teaming up eases social/leadership checks — each
    // coordinated companion grants +2 effective CHA for this turn's checks,
    // capped so a whole crew can't stack infinitely. The AI judges stat
    // checks against the numbers below, so the bonus must appear here. The
    // display names the actual crew ("while working with Rook") rather than a
    // generic count, so the bonus reads as teamwork.
    const crew = VacuumSafetyModule.coordinatedCompanionNames(userText);
    const chaBonus = crew.length > 0 ? Math.min(5, crew.length * 2) : 0;
    const crewPhrase = crew.join(" and ");

    let stateReminder = `\n\n[SYSTEM REMINDER - STRICT CURRENT STATE:\n`;
    stateReminder += `Effective Stats: STR ${eff.str}, AGI ${eff.agi}, INT ${eff.int}, CHA ${eff.cha}${chaBonus > 0 ? ` (+${chaBonus} while working with ${crewPhrase})` : ""}.\n`;
    if (s.toggles.subskills) {
      const ss = s.subskills as { seduction: number; sneaking: number; negotiation: number; intimidation: number };
      stateReminder += `Subskills: Seduction ${ss.seduction}, Sneaking ${ss.sneaking}, Negotiation ${ss.negotiation}, Intimidation ${ss.intimidation}.\n`;
    }
    if (s.toggles.mcInfo) {
      stateReminder += `Active Inventory Schema: ${JSON.stringify(s.char.inventory || [])}\n`;
      stateReminder += `Active Persistent Modifiers Schema: ${JSON.stringify(s.modifiers || {})}\n`;
    }
    stateReminder += `CURRENT TIME: ${s.worldState.time}\n`;
    const season = getCanonicalSeason(s.worldState.time, s.seasonOverride);
    if (season) stateReminder += `CURRENT SEASON: ${season}\n`;
    stateReminder += `CURRENT LOCATION: ${s.worldState.location}\n`;
    // Stat-check momentum: the previous check's outcome on this line colors
    // this turn's target (failures make retries harder, successes ease them).
    // The AI sees it here so it can write the fallout in fiction instead of
    // the math contradicting the story.
    if (!isInitial && s.toggles.statChecks) {
      const checkMomentum = getMomentumReminder();
      if (checkMomentum) stateReminder += checkMomentum + "\n";
      // Scene escalation: an NPC who drew a weapon after a failed attempt is
      // still armed — retrying them is harder and the AI must write the
      // armed threat into the fiction instead of repeating the same scene.
      const escalation = getEscalationReminder();
      if (escalation) stateReminder += escalation + "\n";
      // Episodic action memory: what the MC did before, with whom, and how it
      // went — the grounding for comparisons. When the player references a
      // past action ("we sparred", "we already kissed"), the AI must check
      // this log and acknowledge it instead of dismissing it as speculation.
      const actionMemory = ActionMemoryModule.getReminder();
      if (actionMemory) stateReminder += actionMemory + "\n";
    }
    // First-time claim guard: when the PLAYER's action text claims a
    // first-time / never-done action ("I've never traded crypto before") but
    // the memory log proves it already happened, inject a hard mechanical
    // correction so even a model that skims the memory block cannot narrate
    // the MC as a newcomer. Live-verified against the 48B: it accepted a
    // false "never traded before" claim despite the prompt rule — this line
    // is the backstop that cannot be missed.
    if (!isInitial && s.toggles.memory) {
      const firstTimeGuard = ActionMemoryModule.firstTimeGuard(userText);
      if (firstTimeGuard) stateReminder += firstTimeGuard + "\n";
    }
    // Reaction recency: an NPC who reacted warmly/coldly within the last turn
    // or two does NOT reset to neutral — the AI must narrate the lingering
    // warmth or tension instead of starting their emotional state fresh.
    if (!isInitial && s.toggles.memory) {
      const reactionRecency = ActionMemoryModule.getReactionRecency();
      if (reactionRecency) stateReminder += reactionRecency + "\n";
    }
    stateReminder += `CRITICAL PROTECTION RULE: You MUST use these exact numbers and items for narrative progress. DO NOT make up different money values or change item description values implicitly. When removing, draining, adding, or mutating any property, you MUST output a fully reconstructed [STATE_UPDATE] containing all elements.]`;

    payloadText += stateReminder;

    if (!isInitial && s.toggles.statChecks) {
      payloadText += `\n[SYSTEM INSTRUCTION FOR THIS ACTION: Evaluate success/failure based on MC effective stats vs challenge difficulty. Cultivation tier (Tier ${s.char.cultivation}) multiplies base stats by +${Math.round(s.char.cultivation * 20)}% under the hood. Challenge checks MUST evaluate base mortal attributes multiplied by cultivation tier, not just tier levels directly. Higher level cultivators (Tiers above 1.0) accrue fatigue significantly slower and do not require sleep every day.${chaBonus > 0 ? ` Coordination bonus in effect: the CHA shown above includes +${chaBonus} because the MC is explicitly working with ${crewPhrase} — apply it to CHA-based checks and Leadership/social subskill checks this turn.` : ""}]`;
    }

    try {
      // Phase 2: Pass compressed history to the API.
      // Send payloadText (action + per-turn state reminder) so the AI is
      // re-anchored on the current state and tag format every turn.
      let aiResponseRaw = await ApiModule.generateResponse(
        sysPrompt,
        payloadText,
        compressedHistory,
        (info) => UIManager.setLoadingStatus(formatRetryStatus(info)),
      );

      // Strip model reasoning blocks (<think>...</think>) so internal
      // monologue — including malformed [STATE_UPDATE] drafts — never reaches
      // the coherence check, tag parsers, chat log, history, or the
      // structured-fallback heuristics.
      aiResponseRaw = stripThinkBlocks(aiResponseRaw);

      // Coherence guard: small local models sometimes degenerate into
      // analysis-mode rambling (no narrative, dozens of unclosed tag
      // openings, self-reasoning). Detect it and retry ONCE with a short,
      // simple "just write the story" prompt before showing anything.
      const verdict = analyzeCoherence(aiResponseRaw);
      if (!verdict.coherent && s.api.retryOnRambling !== false) {
        console.warn(
          `[coherence] turn response deemed incoherent (${verdict.reasons.join("; ")}); retrying with a simpler prompt.`,
        );
        // Tell the player what's happening — the retry can take as long as
        // the original call on slow local models, and a silent spinner looks
        // like a frozen app.
        UIManager.setLoadingStatus("The model rambled — retrying with a simpler prompt…");
        const retried = await retryWithSimplePrompt(
          userText,
          isInitial,
          (info) => UIManager.setLoadingStatus(formatRetryStatus(info)),
        );
        if (retried) {
          aiResponseRaw = stripThinkBlocks(retried);
          console.info("[coherence] retry produced a response; using it.");
        }
        UIManager.setLoadingStatus("AI is writing...");
      }

      // Phase 3: LoreModule.extract now delegates to Quest/Equipment/Economy modules.
      // Snapshot the logs first so this turn's NEW checks/gifts can be
      // harvested into the episodic action memory (what survives restarts).
      const checkLogStart = s.checkLog.length;
      const giftLogStart = s.giftLog.length;
      const transactionLogStart = s.transactionLog.length;
      // Snapshot the economy state BEFORE the tags are extracted so the
      // [STATE_UPDATE] blocks' systemPoints/inventory movement can be diffed
      // into action memory (a trade that only moves the balance, with no trade
      // verb in prose and no [TRANSACTION] tag, is still remembered).
      const economyBefore = ActionMemoryModule.snapshotEconomy();
      const cleanResponse = LoreModule.extract(aiResponseRaw);
      const economyDelta = ActionMemoryModule.computeDelta(economyBefore);

      // Stat-check framework: the AI declared [CHECK] tags (stat + difficulty);
      // the engine rolls, derives the seven-tier outcome, records momentum for
      // consecutive attempts on the same line, and returns the compact system
      // lines shown after the narration so the player sees WHY it passed or
      // failed. Runs on the raw response (the tag is stripped from display by
      // LoreModule.stripTags).
      const checkLines: string[] = [];
      if (!isInitial && s.toggles.statChecks) {
        // The player's action text rides along so an omitted difficulty can
        // be inferred from who the action names ("convincing the guard").
        for (const line of CheckModule.extract(aiResponseRaw, userText)) {
          checkLines.push(line);
          UIManager.appendChat("system", line);
        }
        // The Recent Checks sidebar panel reflects the newly resolved checks
        // immediately (it also renders on resume via renderAllSidebars).
        UIManager.renderChecksPanel();
      }

      // Phase 5: NPC reactions — user interactions genuinely influence Trust
      // and Affection for NPCs present at the MC's location. Aggressive NPCs
      // witness violent actions, jealous NPCs react to romantic attention,
      // generous/flirtatious NPCs warm up to gifts and gestures; each reaction
      // moves the witness's profile stats (visible in the NPC/Household bars)
      // and a compact system line explains the change in the chat log.
      // Reaction system lines are persisted into history (as "system" entries
      // between the user action and the assistant reply) so they survive
      // reloads — the player sees why stats moved even after a page refresh.
      const reactionLines: string[] = [];
      let reactionDetails: Array<{
        npcName: string;
        label: string;
        trustDelta: number;
        affectionDelta: number;
      }> = [];
      if (!isInitial && s.toggles.npcDepth) {
        // NPC location shifts: when the story says an NPC left for a place
        // ("mother left for her double shift at the diner"), move their
        // profile there BEFORE witnesses are computed, so the reaction
        // pipeline follows the story instead of keeping them at home.
        NPCProfileModule.applyLocationShifts(userText, cleanResponse);
        const reaction = VacuumSafetyModule.triggerReaction(userText);
        reactionDetails = reaction.details;
        for (const detail of reaction.details) {
          const line = VacuumSafetyModule.formatReactionLine(detail);
          if (line) {
            reactionLines.push(line);
            UIManager.appendChat("system", line);
          }
        }
        // Narrative refinement: the AI's OWN prose can move stats mildly even
        // when the action text was neutral ("She glares at you coldly."). Uses
        // the tag-stripped prose (never tag payloads like [GIFT] fields), and
        // NPCs that already reacted with nonzero deltas this turn are excluded
        // so one event is never double-counted.
        const reacted = new Set(
          reaction.details
            .filter((d) => d.trustDelta !== 0 || d.affectionDelta !== 0)
            .map((d) => d.npcName.toLowerCase()),
        );
        NPCProfileModule.applyNarrativeNudges(cleanResponse, reacted);
        UIManager.renderAllSidebars();
      }

      // Episodic action memory: harvest this turn's resolved checks, NPC
      // reactions, and gifts into the durable log (persisted in the save, so
      // the AI still knows "we sparred" / "we already kissed" after a
      // restart). The [MEMORY] tags the AI emitted ride along via aiText.
      // [MEMORY_REF] citations resolve here: the AI pins a past action by its
      // stable id (shown in the RECENT ACTION MEMORY block), the engine verifies
      // it against the log, and a compact system line lands in the chat + history
      // so the player sees what is being built on — and a dangling id gets a
      // gentle notice instead of silently passing.
      const memoryRefLines: string[] = [];
      if (!isInitial && s.toggles.memory) {
        ActionMemoryModule.harvest({
          aiText: aiResponseRaw,
          // The tag-stripped prose: intimacy milestones (kisses, hand-holding)
          // live in the narration, never inside tag payloads.
          narration: cleanResponse,
          actionText: userText,
          newChecks: s.checkLog.slice(checkLogStart),
          newGifts: s.giftLog.slice(giftLogStart),
          newTransactions: s.transactionLog.slice(transactionLogStart),
          reactions: reactionDetails,
          stateDelta: economyDelta,
        });
        UIManager.renderActionMemoryPanel();
        for (const ref of ActionMemoryModule.parseRefs(aiResponseRaw)) {
          const entry = ActionMemoryModule.resolveRef(ref);
          if (entry) {
            const line = `🔗 builds on: “${entry.summary}” (${entry.time || ""} · turn ${entry.turn})`;
            memoryRefLines.push(line);
            UIManager.appendChat("system", line);
          } else {
            const line = `⚠️ [MEMORY_REF] “${ref}” doesn't match any remembered action — check the RECENT ACTION MEMORY ids.`;
            memoryRefLines.push(line);
            UIManager.appendChat("system", line);
          }
        }
      }

      if (!isInitial) {
        s.history.push({ role: "user", content: userText });
      }
      // Fired director-note events land right after the user's action (matching
      // the live chat order), then the reaction lines, then the AI's reply.
      for (const line of firedNoteLines) {
        s.history.push({ role: "system", content: line });
      }
      for (const line of reactionLines) {
        s.history.push({ role: "system", content: line });
      }
      for (const line of memoryRefLines) {
        s.history.push({ role: "system", content: line });
      }

      // Save the think-stripped assistant response so the model keeps seeing
      // its own tag usage (what stops format erosion after many turns) without
      // the reasoning noise.
      s.history.push({ role: "assistant", content: aiResponseRaw });

      // The check-resolution lines land right after the narration they
      // adjudicate (a mechanical footnote, never a replacement for the story),
      // and persist into history so they survive reloads.
      for (const line of checkLines) {
        s.history.push({ role: "system", content: line });
      }

      UIManager.appendChat("ai", cleanResponse);

      // Phase 2: Update the token meter in the UI.
      const sysPromptAfter = buildSystemPrompt();
      const estimatedTokens = estimatePromptSize(sysPromptAfter, s.history, payloadText);
      UIManager.updateTokenMeter(estimatedTokens);

      StorageModule.autosave();

      // Structured-update fallback: small local models often narrate changes
      // (bought item, met NPC, health loss) without emitting engine tags.
      // Recover the missed blocks with one short follow-up call so the
      // Knowledge/Economy/state panels stay in sync. Skips the world-building
      // initial turn, whose prose is full of price/coin words that would
      // false-positive the change heuristic. Never throws.
      if (!isInitial) {
        await runStructuredFallback(
          aiResponseRaw,
          (info) => UIManager.setLoadingStatus(formatRetryStatus(info)),
        );
        // The fallback may have recovered [TRANSACTION] blocks the main
        // response omitted — reconcile them into action memory now so a trade
        // the engine just recorded is never left unremembered until a later
        // turn. No-op when the log is unchanged.
        if (s.toggles.memory) {
          const added = ActionMemoryModule.reconcileTransactions();
          if (added > 0) UIManager.renderActionMemoryPanel();
        }
      }
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Something went wrong reaching the AI engine.";
      UIManager.showErrorBanner(msg);
      if (!isInitial && inputEl) inputEl.value = userText;
    } finally {
      UIManager.showLoading(false);
      if (inputEl) {
        inputEl.disabled = false;
        inputEl.focus();
      }
    }
  },

  saveApiSettings(): void {
    const provider = (document.getElementById("api-provider") as HTMLSelectElement).value as ApiConfig["provider"];
    const retryChk = document.getElementById("api-retry-rambling") as HTMLInputElement | null;
    StateModule.state.api = {
      provider,
      key: (document.getElementById("api-key") as HTMLInputElement).value,
      url: (document.getElementById("api-url") as HTMLInputElement).value,
      model: (document.getElementById("api-model") as HTMLInputElement).value,
      // Missing checkbox (e.g. tests) means "leave the default on".
      retryOnRambling: retryChk ? retryChk.checked : undefined,
    };
    UIManager.toggleSettings();
  },

  /** Return to the setup page without refreshing — resets play screen, keeps state. */
  returnToSetup(): void {
    UIManager.toggleSettings();
    document.getElementById("play-screen")?.classList.add("hidden");
    document.getElementById("setup-screen")?.classList.remove("hidden");
  },
};
