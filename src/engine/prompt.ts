// =============================================================================
// prompt.ts — Phase 2: Prompt scaling with summarization + relevance filtering.
// Phase 3: Quest/equipment/economy context injection.
// Phase 4: XP/Level/Skill/Cultivation context + stat cap enforcement.
// =============================================================================

import { StateModule } from "../state/state";
import { Subskills } from "../state/GameState";
import { getSummary } from "./summarizer";
import { filterFacts, filterRelations } from "./relevance";
import { SkillModule } from "../engine/skill";
import { VacuumSafetyModule } from "./vacuum-safety";
import { TimeStateModule } from "./time-states";
import { NPCProfileModule } from "./npc-profile";
import { GenreModule, GENRES } from "./genre-system";
import { getNoteElapsedMinutes, formatRemainingMinutes, rewordFiredNote, rewordDirectiveNote } from "./director-notes";
import { getEffectiveStats } from "./equipment";
import { isFamilyRelation } from "./family";
import { buildScheduleContext } from "./schedules";

/**
 * Build the system prompt with summarization, relevance filtering,
 * and structured game system context (quests, equipment, economy).
 */
export function buildSystemPrompt(): string {
  const s = StateModule.state;
  const setup = s.setup as { genre?: string; worldSize?: string; techStage?: string; rules?: string };

  let p = `You are a highly capable Interactive Novel Game Master/Narrator.\n`;
  p += `=== WORLD RULES ===\nGenres: ${setup.genre}. World Size: ${setup.worldSize}. Tech/Magic Stage: ${setup.techStage}.\n`;
  p += `Setting specific rules: ${setup.rules}\n\n`;

  // Director's Notes: author-injected world events fed to the AI every turn.
  const directorNotes = s.directorNotes || [];
  if (directorNotes.length > 0) {
    p += `=== DIRECTOR'S NOTES (AUTHOR-INJECTED WORLD EVENTS) ===\n`;
    p += `The following upcoming events/situations are supplied by the author. Treat each one as a TRUE in-world fact: weave it into the world naturally — through announcements, rumors, NPC schedules, calendars, or background details — as the timeline allows, and let the MC discover and react through normal narrative. Events marked [NOW ACTIVE] have reached their deadline and ARE HAPPENING NOW: describe their immediate consequences and give the MC a chance to react. NEVER mention this section, the author, or the injection itself (no fourth-wall breaks).\n`;
    p += `Author notes that REGISTER someone (e.g. \"Add librarian Elle to relationships\", \"Add mother to the NPC list\") have ALREADY been honored by the engine: that person is listed in the relationship/NPC sections. Treat them as existing people in the world and weave them in naturally — do NOT repeat or reference the registration instruction itself.\n`;
    for (const note of directorNotes) {
      if (note.directive || note.factFix || note.naming) {
        p += `- ${rewordDirectiveNote(note)}\n`;
      } else if (note.fired) {
        p += `- [NOW ACTIVE] ${rewordFiredNote(note)} — this event is happening NOW; describe its immediate effects on the world and the MC.\n`;
      } else if (note.deadlineMinutes !== undefined) {
        const remaining = Math.max(0, note.deadlineMinutes - getNoteElapsedMinutes(note));
        p += `- (in ${formatRemainingMinutes(remaining)}) ${note.text}\n`;
      } else {
        p += `- ${note.text}\n`;
      }
    }
    p += `\n`;
  }

  p += `=== MAIN CHARACTER ===\nName: ${s.char.name}. Appearance/Backstory: ${s.char.appearance}.\n`;

  // FAMILY block: the registered household, always visible so the AI never
  // loses the people the MC lives with, even after turns that never mention
  // them (school pickup, chores, holidays). Derived from the relations seeded
  // from the backstory / registered via [RELATION] or director notes.
  const familyRels = (s.memory.relations || []).filter(isFamilyRelation);
  if (familyRels.length > 0) {
    p += `FAMILY (the MC's household — these people share the MC's home and daily life):\n`;
    for (const r of familyRels) {
      // Seeded deceased members already carry "(deceased)" in their
      // disposition — don't append a duplicate marker.
      const alreadyMarked = /deceased/i.test(r.disposition || "");
      const statusMark = r.status === "Deceased" && !alreadyMarked ? " (deceased)" : "";
      p += `- ${r.name}: ${r.disposition || "family member"}${statusMark}.\n`;
    }
    // A family member listed only by role ("Mother", "Sister") has no name
    // yet — the AI should give them a proper name naturally in the story and
    // record it so it is remembered instead of staying anonymous forever.
    p += `If any family member above is listed only by role (Mother, Sister...), give them a proper name naturally as the story unfolds and record it as [RELATION]{"name":"<Name>","aliases":["<Role>"]} — the engine renames them and keeps the role as an alias.\n`;
  }

  if (s.toggles.mcInfo) {
    p += `Inventory Array: ${JSON.stringify(s.char.inventory || [])}\n`;
    p += `Active Modifiers/State Modulations: ${JSON.stringify(s.modifiers || {})}\n`;

    const tier = s.char.cultivation;
    const eff = getEffectiveStats();

    p += `Stats - Base STR: ${s.char.str} (Effective: ${eff.str}), Base AGI: ${s.char.agi} (Effective: ${eff.agi}), Base INT: ${s.char.int} (Effective: ${eff.int}), Base CHA: ${s.char.cha} (Effective: ${eff.cha}).\n`;
    p += `Cultivation Tier: ${tier}. (Mechanic: Base stats are increased by 20% per cultivation tier to yield actual effective stats. Scale physical effects accordingly. At higher cultivation levels, the MC is highly resistant to fatigue).\n`;
  }

  if (s.toggles.subskills) {
    const ss = s.subskills as Subskills;
    p += `Derived Skills - Seduction: ${ss.seduction}, Sneaking: ${ss.sneaking}, Negotiation: ${ss.negotiation}, Intimidation: ${ss.intimidation}.\n`;
  }

  p += `\n=== TIME, PRESENCE & WORLD LOGIC (STRICT ENFORCEMENT) ===\n`;
  p += `- MEASUREMENT SYSTEM: ${s.worldState.measurement}. You MUST exclusively use this system for all distances, weights, heights, speeds, etc.\n`;
  p += `- TIME PROGRESSION: Logically advance time based on actions. Speaking takes seconds. Eating a snack takes 5 minutes. Walking across town takes proportional time based on distance. You MUST calculate elapsed time and provide the updated clock time in the JSON state. Use a 24-hour clock with the full calendar date — format: \"Monday, March 17, 07:00\" — and advance the month/day as days pass so seasons and long periods (school terms, winter, etc.) stay trackable.\n`;
  p += `- PRESENCE LIMITATION: The MC is strictly bound to their Current Location. NPCs and items NOT physically present CANNOT be interacted with directly. Do NOT magically spawn NPCs. To interact with remote entities, the MC must physically travel (costing time) or use communication tools (if available in inventory).\n`;
  p += `- NPC SCHEDULES: NPCs follow logical daily routines based on the time. A student is in class at 10:00. A bartender works at night. If the MC seeks an NPC, place them where they logically belong at this specific time. Track known schedules via [FACT] memory tags.\n`;

  // Descriptive Scenes module: vivid, concrete environmental descriptions,
  // remembered per location via [SCENE] and re-fed when the MC returns so
  // the room's physical reality stays consistent across turns.
  if (s.toggles.descriptiveScenes) {
    p += `\n=== DESCRIPTIVE SCENES (ACTIVE) ===\n`;
    p += `- When the MC enters a location, returns after a notable absence, or the scene materially changes, OPEN the scene with a vivid concrete description: the layout, furniture, objects, lighting, sounds, smells, and what each NPC present is doing at this exact moment (e.g. \"the teacher is busy with pre-class preparation\", \"Uncle Joe is dozing after his third cup of vodka\"). Ground every scene in physical, actionable detail the MC could actually interact with so the player can direct actions meaningfully.\n`;
    const sceneKey = (s.worldState.location || "").trim().toLowerCase();
    const currentScene = s.sceneLog && s.sceneLog[sceneKey];
    if (currentScene) {
      p += `- CURRENT SCENE (last known description of the MC's current location — keep it consistent, update it only when details genuinely change): ${currentScene.description}\n`;
      const ambient: string[] = [];
      if (currentScene.weather) ambient.push(`weather: ${currentScene.weather}`);
      if (currentScene.lighting) ambient.push(`lighting: ${currentScene.lighting}`);
      if (currentScene.season) ambient.push(`season: ${currentScene.season}`);
      if (ambient.length > 0) {
        p += `- AMBIENT CONDITIONS (part of the scene — keep them consistent): ${ambient.join(", ")}\n`;
      }
      if (currentScene.seasonNote) {
        p += `- SCENE NOTE (consistency): ${currentScene.seasonNote}\n`;
      }
    }
    p += `- Record the first description of a location, and material changes to it, as [SCENE]{"location":"<Location>","description":"<2-4 sentence environmental description>","weather":"<current weather>","lighting":"<current lighting>","season":"<current season>"}[/SCENE] — the weather/lighting/season fields are OPTIONAL, include them when they matter (rain, darkness, winter chill, a storm rolling in...).\n`;
    p += `- When the STORY deliberately changes the season (a time skip, a cursed realm, an eternal winter, a spell gone wrong), record it ONCE as [SEASON_SHIFT]{"season":"<Season>"}[/SEASON_SHIFT] — the engine treats it as canon, shows it as the CURRENT SEASON, and stops flagging calendar mismatches until the next shift.\n`;
  }

  // Schedule awareness: soft time-of-day guidance so the AI doesn't summon
  // the whole household at 04:00 or send the MC to school at 05:00. Logical
  // defaults the story may override — never hard facts.
  if (s.toggles.schedules) {
    p += buildScheduleContext();
  }

  p += `\n=== ENGINE MECHANICS (STRICT COMPLIANCE REQUIRED) ===\n`;

  if (s.toggles.statChecks) {
    p += `- STAT CHECKS ACTIVE: Compare the MC's EFFECTIVE stats against the challenge. A character with high base stats can defeat a higher cultivation tier rival if the raw math matches up. Do not auto-win challenges.\n`;
    p += `- RELATIONSHIPS INFLUENCE ACTIONS: Hostile NPCs increase difficulty. Persuasion is easier on friendly, dependent, submissive, or drunk targets. NPC disposition governs interaction limits.\n`;
    p += `- CHECK OUTCOME FRAMEWORK: when a meaningful challenge resolves, declare it via [CHECK] (see OUTPUT FORMAT SPEC #18). The ENGINE rolls a d20 and computes the outcome against the challenge's difficulty target: score = d20 + effective stat (+ LCK modifier) vs target, spanning seven tiers — critical failure, major failure, minor failure, neutral, minor success, major success, critical success. The engine shows the math as a short system line after the narration. A turn may chain SEVERAL checks: when one attempt can fail and the MC recovers a different way (talk your way out, then dodge; get caught stealing, then convince them to let it go), emit the primary check first and the recovery as a second check with \"fallback\":true — the engine resolves them in order and treats a fallback after a failed check as slightly harder (+2 target; a fallback onto a DIFFERENT stat also inherits half the failed primary's momentum penalty, so the dodge after a blown talk carries the same mounting pressure instead of rolling fresh), so escaping a blown plan costs more than a planned attempt. Consecutive attempts on the SAME stat carry momentum: a critical failure makes retrying that line HARDER (up to +6 target), a critical success makes it EASIER (down to -6 target), and a success resets a failure streak. A failed check against a NAMED hostile NPC also ARMS that NPC: the scene escalates (they draw a weapon; +2 target per prior failure when retrying them, up to +6), so a second failed talk against the same hostile NPC never repeats the identical check — write the raised stakes in fiction. A success defuses the scene; a retry declared on the NEXT turn after a failure still inherits half the blown check's momentum. Enforce this in the fiction: after a failure the MC must adjust tactics or find a new angle — the same brute attempt gets steadily tougher; after a critical success the MC rides the momentum. If you OMIT the difficulty, the engine infers it from the story — hostile or aggressive NPCs default to hard (brutal when truly dangerous), friendly targets ease the check, adverse weather raises physical and perception checks, and cover (rain/darkness) eases Sneaking.\n`;
  }
  if (s.toggles.memory) {
    p += `- ACTION MEMORY ACTIVE: The payload carries a RECENT ACTION MEMORY block listing what the MC actually did (with whom, when, how it went, intensity, and for economic actions the amounts). This log survives restarts and is the GROUND TRUTH for continuity. When the player references a past action (\"we sparred\", \"we already kissed\", \"I traded crypto before\", \"last time this was easy\"), CHECK the log, acknowledge the event, and COMPARE the current action against it (partner, intensity, outcome, amounts) — never dismiss the reference as speculation or claim you don't remember, and never claim an economic action (trade, purchase, gamble) is happening for the first time when the log shows it already happened. The evidence is in the log. Also record notable new moments with [MEMORY] (see OUTPUT FORMAT SPEC #19).\n`;
    p += `- REACTION RECENCY ACTIVE: The payload carries a RECENT REACTIONS block naming NPCs who reacted warmly or coldly within the last turn or two. Those NPCs do NOT reset to neutral — carry the lingering warmth (softer tone, remembered kindness) or the lingering tension (continued wariness, resentment) into this turn's narration instead of starting their emotional state fresh. A warmth the MC earned last turn colors how she greets them today.\n`;
  }
  if (s.toggles.health) {
    p += `- HEALTH/FATIGUE ACTIVE: Track physical wear and injuries. High cultivation tier reduces exhaustion rates.\n`;
  }
  if (s.toggles.time) {
    p += `- TIME/DISTANCE ACTIVE: Travel times must remain consistent. Establish logical passage of time.\n`;
  }

  // Phase 3: Quest context.
  if (s.toggles.quests) {
    p += `\n=== ACTIVE QUESTS ===\n`;
    const activeQuests = (s.quests || []).filter((q) => q.status === "active");
    if (activeQuests.length > 0) {
      for (const q of activeQuests) {
        p += `- [${q.type.toUpperCase()}] ${q.title}: ${q.description}\n`;
        for (const obj of q.objectives) {
          p += `  ${obj.completed ? "[x]" : "[ ]"} ${obj.description}\n`;
        }
        p += `  Reward: ${q.reward}${q.assignedBy ? ` (assigned by ${q.assignedBy})` : ""}\n\n`;
      }
    } else {
      p += `(No active quests.)\n\n`;
    }
  }

  // Phase 3: Equipment context.
  if (s.toggles.equipment) {
    p += `\n=== EQUIPPED ITEMS ===\n`;
    const equipped = s.equipped || [];
    const equippedItems = equipped.filter((e) => e.equipped);
    if (equippedItems.length > 0) {
      for (const item of equippedItems) {
        const statsStr = Object.entries(item.stats)
          .filter(([, v]) => v !== undefined && v !== 0)
          .map(([k, v]) => `${k}+${v}`)
          .join(", ") || "None";
        p += `- [${item.slot}] ${item.name} (${item.rarity}): ${statsStr}\n`;
      }
    } else {
      p += `(Nothing equipped.)\n\n`;
    }
  }

  // Phase 3: Economy context.
  if (s.toggles.economy) {
    p += `\n=== ECONOMY ===\n`;
    const currencies = s.currencies || [];
    if (currencies.length > 0) {
      for (const c of currencies) {
        p += `- ${c.name}: ${c.amount}${c.props && Object.keys(c.props).length > 0 ? ` [${JSON.stringify(c.props)}]` : ""}\n`;
      }
    } else {
      p += `(No currencies tracked.)\n\n`;
    }
  }

  // Phase 4: XP/Level context.
  if (s.toggles.xp) {
    const char = s.char;
    p += `\n=== PROGRESSION (XP/LEVEL/SKILLS/CULTIVATION) ===\n`;
    p += `Level: ${char.level} | XP: ${char.xp} | Skill Points: ${char.skillPoints}\n`;
    p += `Cultivation Tier: ${char.cultivation.toFixed(1)}\n`;

    // Show learned skills
    if (char.learnedSkills && char.learnedSkills.length > 0) {
      p += `Learned Skills:\n`;
      for (const sk of char.learnedSkills) {
        p += `  - [${sk.active ? "ACTIVE" : "inactive"}] ${sk.name} (Lv.${sk.level}, ${sk.rarity}, ${sk.category})\n`;
      }
    } else {
      p += `Learned Skills: (None yet)\n`;
    }

    // Show breakthroughs
    if (char.breakthroughs && char.breakthroughs.length > 0) {
      p += `Breakthroughs Achieved:\n`;
      for (const bt of char.breakthroughs) {
        p += `  - [x] ${bt.name}\n`;
      }
    } else {
      p += `Breakthroughs: (None yet)\n`;
    }

    // Show available skill tree
    const availableSkills = SkillModule.getSkillTree();
    if (availableSkills.length > 0 && availableSkills.length <= 10) {
      p += `Available Skills to Learn:\n`;
      for (const sk of availableSkills.slice(0, 10)) {
        p += `  - ${sk.name} (${sk.rarity}, ${sk.category})\n`;
      }
    }
  }

  if (s.toggles.memory) {
    p += `\n=== STORY CONTEXT & ESTABLISHED FACTS ===\n`;

    // Phase 2: Use rolling summary if available.
    const summary = getSummary();
    if (summary) {
      p += `STORY SO FAR:\n${summary}\n\n`;
    }

    // Phase 2: Relevance-filtered facts and relations.
    const activeNpcsForRelevance = (s.memory.relations || [])
      .filter((r) => r.status !== "Deceased")
      .map((r) => ({ name: r.name, aliases: r.aliases || [] }));

    const relevanceCtx = {
      location: s.worldState.location,
      time: s.worldState.time,
      activeNpcs: activeNpcsForRelevance,
      minScore: 1,
    };

    const filteredFacts = filterFacts(s.memory.facts || [], relevanceCtx);
    const filteredRels = filterRelations(s.memory.relations || [], relevanceCtx);

    p += `ESTABLISHED FACTS (relevant to current context):\n`;
    if (filteredFacts.length > 0) {
      for (const bundle of filteredFacts) {
        p += `Group: [${bundle.title || "General Facts"}]\n`;
        for (const entry of bundle.entries || []) {
          p += `  - ${entry}\n`;
        }
      }
    } else {
      p += `(No facts yet.)\n`;
    }

    p += `\nESTABLISHED RELATIONSHIPS:\n`;
    p += `* ACTIVE ALIVE CHARACTERS (MC can interact with them):\n`;
    if (filteredRels.active.length > 0) {
      for (const r of filteredRels.active) {
        const mods =
          r.modifiers && r.modifiers.length > 0
            ? ` Modifiers: ` +
              r.modifiers.map((m) => `${m.name || "Mod"}(${m.duration || 1} turns)`).join(",")
            : "";
        p += `  - ${r.name}: ${r.disposition}.${mods}\n`;
      }
    } else {
      p += `  - None\n`;
    }

    p += `* DECEASED CHARACTERS (They are dead. Do NOT revive them or reference them as alive!):\n`;
    if (filteredRels.deceased.length > 0) {
      for (const r of filteredRels.deceased) {
        p += `  - ${r.name}: Dead. Previous background: ${r.disposition}\n`;
      }
    } else {
      p += `  - None\n`;
    }
  }

  // All output-format instructions are consolidated at the END of the prompt
  // (see the OUTPUT FORMAT SPEC section just before the style instruction) so
  // models see them last and follow them.

    // Phase 5: NPC Profiles & Vacuum Safety (NPC Depth toggle)
    if (s.toggles.npcDepth) {
      const livingProfiles = NPCProfileModule.getLivingProfiles();
      if (livingProfiles.length > 0) {
        p += `\n=== NPC PROFILES (PHASE 5 - STRICT ENFORCEMENT) ===\n`;
        for (const profile of livingProfiles) {
          const traitStr = profile.traits.length > 0 ? ` [${profile.traits.join(", ")}]` : "";
          const locStr = profile.knownLocation ? ` @ ${profile.knownLocation}` : "";
          const schedStr = profile.schedule.length > 0 ? ` Schedule: ${profile.schedule.join("; ")}` : "";
          p += `- ${profile.npcName}${traitStr}${locStr}${schedStr}\n`;
          p += `  Aggression: ${profile.aggressionThreshold}/100 | Jealousy: ${profile.jealousyThreshold}/100 | Trust: ${profile.trust}/100 | Affection: ${profile.affection}/100\n`;

          // Inter-NPC relationships
          if (profile.relationships.length > 0) {
            p += `  Relationships:\n`;
            for (const rel of profile.relationships) {
              p += `    - ${rel.targetName}: ${rel.disposition} (strength: ${rel.strength}/100)\n`;
            }
          }

          // NPC equipment
          if (profile.equipment.length > 0) {
            p += `  Equipment:\n`;
            for (const eq of profile.equipment) {
              p += `    - [${eq.slot}] ${eq.name} (${eq.rarity})${eq.giftedBy ? ` (gifted by ${eq.giftedBy})` : ""}\n`;
            }
          }
        }
      }

      // Vacuum safety note
      const vacuumNote = VacuumSafetyModule.generateVacuumNote("");
      if (!VacuumSafetyModule.isPrivateLocation()) {
        p += `\n${vacuumNote}\n`;
        p += `CRITICAL: You MUST acknowledge NPCs present in the current location. Do NOT write scenes as if the MC is alone when NPCs are nearby. Factor in their traits, thresholds, and current states when determining their reactions.\n`;
      }

      // Vacuum safety instructions
      p += `\n=== VACUUM SAFETY RULES (STRICT ENFORCEMENT) ===\n`;
      p += `- BEFORE narrating any action by the MC, check if any NPCs are in the same location.\n`;
      p += `- If NPCs are present, you MUST describe their reaction based on their traits and thresholds.\n`;
      p += `- An aggressive NPC (aggressionThreshold > 60) will escalate violent or threatening actions.\n`;
      p += `- A jealous NPC (affection > jealousyThreshold) will react negatively to romantic attention toward others.\n`;
      p += `- A timid NPC will retreat or call for help when threatened.\n`;
      p += `- If the MC performs a private action (undressing, meditating, using an item) and NPCs are present, describe their reaction.\n`;
      p += `- If no NPCs are present, narrate freely as a private moment.\n`;

    }

    // Phase 5: Time-based states (Time toggle)
    if (s.toggles.time) {
      const allActiveStates = TimeStateModule.getAllActive();
      if (allActiveStates.length > 0) {
        p += `\n=== ACTIVE TIME-BASED STATES ===\n`;
        for (const ts of allActiveStates) {
          const label = TimeStateModule.getSeverityLabel(ts.severity);
          const mins = Math.ceil(ts.durationMinutes / 60);
          p += `- ${ts.name} on ${ts.target}: Severity ${ts.severity} (${label}), ${mins}h remaining, tick every ${ts.tickIntervalMinutes}min (${ts.severityDeltaPerTick > 0 ? "worsening" : "healing"})\n`;
        }
      }

      // Time-state instructions
      p += `\n=== TIME-BASED STATE RULES ===\n`;
      p += `- Time-based states (poison, drunk, pregnancy, etc.) have real-time durations in minutes, not turn-counts.\n`;
      p += `- Each state has a severity (0-100) that changes on tick intervals.\n`;
      p += `- When narrating, factor in the current severity: mild states have minor effects, critical states have major effects.\n`;
      p += `- Example: A poisoned NPC with severity 80 is visibly suffering; one with severity 20 shows mild symptoms.\n`;
      p += `- States expire when durationMinutes reaches 0. Remove them from the narrative.\n`;

    }

    // Phase 6: Genre context & secondary stats (always active)
    {
      const activeGenres = GenreModule.getActive();
      if (activeGenres.length > 0) {
        p += `\n=== GENRE CONTEXT (PHASE 6) ===\n`;
        const genreLabels = activeGenres.map(gid => {
          // Find genre label from GENRES
          const found = GENRES.find(x => x.id === gid);
          return found ? found.label : gid;
        });
        p += `Active Genres: ${genreLabels.join(" + ")}\n`;

        // Conflict warnings
        const conflicts = GenreModule.getConflicts();
        if (conflicts.length > 0) {
          p += `⚠ CONFLICTING GENRES DETECTED: ${conflicts.map(c => `${c.a} + ${c.b}`).join(", ")} — AI should prioritize whichever fits the current scene.\n`;
        }

        // Unlocked mechanics
        const unlocked = GenreModule.getUnlockedMechanics();
        if (unlocked.length > 0) {
          p += `Unlocked Mechanics: ${unlocked.join(", ")}\n`;
        }

        // Genre-specific narration rules
        p += `\nGENRE-SPECIFIC NARRATION RULES:\n`;
        if (activeGenres.includes("cultivation") || activeGenres.includes("xianxia") || activeGenres.includes("wuxia")) {
          p += `- Cultivation/Xianxia/Wuxia: Track cultivation tiers, breakthroughs, qi/spiritual energy. Secondary stats WILL (willpower/qi control), PER (spiritual sense) are active.\n`;
        }
        if (activeGenres.includes("medieval") || activeGenres.includes("darkfantasy") || activeGenres.includes("survival") || activeGenres.includes("postapoc")) {
          p += `- Survival/Medieval/Dark Fantasy: Track stamina and hunger. Secondary stat END (endurance) is active. Resource scarcity and physical toll are real.\n`;
        }
        if (activeGenres.includes("darkfantasy") || activeGenres.includes("horror")) {
          p += `- Corruption mechanic is active. Characters may gain corruption from dark deeds, horror encounters, or prolonged exposure to malevolent forces.\n`;
        }
        if (activeGenres.includes("scifi") || activeGenres.includes("urban")) {
          p += `- Modern/Sci-Fi: Technology, gadgets, and contemporary society shape interactions. No cultivation or magical systems unless explicitly stated.\n`;
        }
      }

      // Phase 6: Secondary stats in prompt
      p += `\n=== SECONDARY STATS (PHASE 6) ===\n`;
      p += `The MC has four secondary stats in addition to STR/AGI/INT/CHA:\n`;
      p += `- END (Endurance): Physical stamina, resistance to fatigue, pain tolerance. Affects hit points, recovery speed, and physical feats.\n`;
      p += `- WIL (Willpower): Mental fortitude, resistance to fear/charm/corruption, spiritual/qi control. Critical in cultivation and horror settings.\n`;
      p += `- LCK (Luck): Probability manipulation, critical hits, fortunate encounters. Affects dice rolls, treasure drops, and serendipity.\n`;
      p += `- PER (Perception): Awareness, spotting hidden things, sensing danger, reading people. Affects initiative and information gathering.\n`;
      p += `- System Points: Available in LitRPG/system scenarios. Distinct from cultivation — these are points the MC can spend on abilities, stat boosts, or skills. Do NOT confuse with cultivation gains.\n`;
      p += `MC Stats: STR=${s.char.str} AGI=${s.char.agi} INT=${s.char.int} CHA=${s.char.cha} END=${s.char.end} WIL=${s.char.wil} LCK=${s.char.lck} PER=${s.char.per} Cultivation=${s.char.cultivation} SystemPoints=${s.char.systemPoints}\n`;
    }

    // =========================================================================
    // OUTPUT FORMAT SPEC — consolidated at the very end of the prompt so
    // models see it last (recency bias) and follow it. MUST-language with
    // concrete triggers and one worked example per tag.
    // =========================================================================
    p += `\n=== OUTPUT FORMAT SPEC (MUST FOLLOW — APPEND AFTER THE NARRATIVE) ===\n`;
    p += `After the narrative, you MUST append every block below whose trigger occurred this turn. Do NOT omit any, do NOT wrap them in markdown (no ** or \`\`\` code fences), and do NOT put anything else after them. Always use YOUR current state numbers — never copy example values.\n`;

    if (s.toggles.memory) {
      p += `1. [FACT] — NEW KNOWLEDGE. MUST emit when the MC learns any persistent fact: a price, a travel route, an NPC schedule, a location detail, a rumor. Format: [FACT]Group Title: the fact[/FACT]\n`;
      p += `   Trigger example — MC asks the herbalist the price, so you MUST emit:\n`;
      p += `   [FACT]Oakhaven Market: Dried herbs cost 3 copper per bundle.[/FACT]\n`;
      p += `   Trigger example — the calendar crosses into a new season (Mar-May Spring, Jun-Aug Summer, Sep-Nov Autumn, Dec-Feb Winter), so you MUST emit:\n`;
      p += `   [FACT_RESET]Season[/FACT_RESET]\n`;
      p += `   [FACT]Season: Summer has arrived — long warm days and the academy's summer break begins.[/FACT]\n`;
      p += `2. [FACT_RESET] — OUTDATED FACTS. MUST emit before replacing a fact group whose state changed (debt paid, location cleared, price changed).\n`;
      p += `   Trigger example — the household debt is paid, so you MUST emit:\n`;
      p += `   [FACT_RESET]Household[/FACT_RESET]\n`;
      p += `   [FACT]Household: Debt cleared. The family is stable and happy.[/FACT]\n`;
      p += `3. [RELATION] — RELATIONSHIPS. MUST emit for EVERY new NPC the MC meets or interacts with, and whenever an existing relationship changes. One block per character; valid JSON only; only "name" is required. Schema: {"name": string, "disposition"?: string, "status"?: "Alive"|"Deceased", "aliases"?: string[], "modifiers"?: [{"name": string, "duration": number}]}\n`;
      p += `   Trigger example — MC meets the herbalist, so you MUST emit:\n`;
      p += `   [RELATION]{"name": "Mara", "disposition": "Friendly merchant", "status": "Alive", "aliases": ["Oakhaven Herbalist"]}[/RELATION]\n`;
      p += `   Modifier durations tick down by 1 each turn and are removed at 0.\n`;
    }

    if (s.toggles.mcInfo || s.toggles.health) {
      p += `4. [STATE_UPDATE] — DYNAMIC STATE. MUST emit every turn in which health, fatigue, core stats, cultivation, system points, inventory, modifiers, time, or location changes. Provide the COMPLETE updated JSON, always with the full inventory list.\n`;
      p += `   Trigger example — MC buys herbs, so you MUST emit (with YOUR current values):\n`;
      p += `   [STATE_UPDATE]{"health": 100, "fatigue": 5, "str": 10, "agi": 10, "int": 10, "cha": 10, "cultivation": 0.0, "systemPoints": 0, "xp": 0, "level": 1, "skillPoints": 0, "time": "Monday, March 17, 07:10", "location": "Oakhaven Market", "inventory": [{"name": "Simple Clothes", "desc": "Basic everyday attire suitable for the setting", "qty": 1, "props": {"category": "Clothing", "type": "Basic"}}, {"name": "Dried Herbs", "desc": "Bundle of medicinal herbs", "qty": 1, "props": {}}], "modifiers": {}}[/STATE_UPDATE]\n`;
      p += `   * CRITICAL Inventory Rules: Always provide the COMPLETE inventory list in the update. Never alter numerical values inside item names (e.g. keep currency exact). Do not implicitly change properties without showing them in the 'props' object.\n`;
      p += `   * CRITICAL Modifier Rules: Record modifications (like passive income, artifact charge, special protection buffs) inside the 'modifiers' object. If a modification is drained or cancelled, update its value or remove it from the object.\n`;
    }

    if (s.toggles.quests) {
      p += `5. [QUEST] — QUEST CHANGES. MUST emit when a new quest is given, objectives complete, or quest status changes.\n`;
      p += `   Format: [QUEST]{"id": "unique-id", "title": "Quest Title", "description": "Brief description", "type": "main|side|daily|hidden", "status": "active|completed|failed", "objectives": [{"description": "Step description", "completed": false}], "reward": "Reward description", "assignedBy": "NPC Name"}[/QUEST]\n`;
      p += `   Trigger example — the elder offers the MC a task, so you MUST emit:\n`;
      p += `   [QUEST]{"id": "quest-jade-pendant", "title": "Retrieve the Jade Pendant", "description": "The village elder's jade pendant was stolen by bandits on the mountain road.", "type": "side", "status": "active", "objectives": [{"description": "Find the bandits' camp on the mountain road", "completed": false}], "reward": "Elder Li's gratitude and 10 copper", "assignedBy": "Elder Li"}[/QUEST]\n`;
      p += `   To mark an objective complete: [OBJECTIVE_COMPLETE]quest-id: Objective description[/OBJECTIVE_COMPLETE]\n`;
    }

    if (s.toggles.equipment) {
      p += `6. [EQUIPMENT] — GEAR CHANGES. MUST emit when the MC equips, finds, or modifies gear.\n`;
      p += `   Format: [EQUIPMENT]{"itemId": "item-name", "name": "Display Name", "slot": "weapon|chest|head|...", "rarity": "common|uncommon|rare|epic|legendary", "stats": {"str": 5, "agi": 3}, "desc": "Item description", "equipped": true}[/EQUIPMENT]\n`;
      p += `   CRITICAL: The itemId MUST exactly match an item currently in the MC's inventory list. Never invent new item names.\n`;
    }

    if (s.toggles.economy) {
      p += `7. [TRANSACTION] — ECONOMY. MUST emit when the MC buys, sells, receives rewards, or pays fines.\n`;
      p += `   Format: [TRANSACTION]{"id": "tx-unique-id", "type": "buy|sell|reward|fine", "itemName": "Item name", "amount": 100, "currency": "USD", "timestamp": "Monday, March 17, 07:10", "partner": "Shop Name"}[/TRANSACTION]\n`;
    }

    if (s.toggles.xp) {
      p += `8. [XP_GAIN] — EXPERIENCE. MUST emit when the MC earns XP from combat, training, or achievements: [XP_GAIN]<number>[/XP_GAIN]\n`;
      p += `9. [SKILL_UNLOCK] — NEW SKILLS. MUST emit when the MC learns a skill: [SKILL_UNLOCK]skillId:Skill Name:category:rarity:Description[/SKILL_UNLOCK] (categories: combat|cultivation|social|crafting|stealth|knowledge; rarities: common|uncommon|rare|epic|legendary)\n`;
      p += `10. [SKILL_USE] — SKILL ACTIVATION. MUST emit when the MC USES a learned skill (Charm Aura, Artifact Refinement, Shadow Step...): [SKILL_USE]{"skill":"charm_aura","effect":"+20% CHA vs attracted targets","duration":5}[/SKILL_USE] — the engine records the effect into Active Modifiers / Artifact State. Only use skills the MC has learned (listed in Learned Skills). The effect lasts the given number of turns (each turn ≈ 10 in-game minutes) and expires on its own; pick a duration that fits the scene. A numeric stat bonus in the effect text ('+3 CHA', '+20% CHA', '+2 STR, +1 AGI') overrides the skill's level-scaled default; omit numbers to keep the level-scaled bonus.\n`;
      p += `11. [SKILL_TRAIN] — SKILL TRAINING. MUST emit when the MC practices a learned skill to improve it: [SKILL_TRAIN]{"skill":"charm_aura","xp":15}[/SKILL_TRAIN] — XP accumulates toward the next level (50 x current level); ranking up makes the skill's bonuses stronger (e.g. a higher-level aura grants more CHA). Only train skills the MC has learned (listed in Learned Skills).\n`;
      p += `12. [CULTIVATION_CHANGE] — MUST emit when cultivation changes: [CULTIVATION_CHANGE]+0.5[/CULTIVATION_CHANGE] or [CULTIVATION_CHANGE]-0.2[/CULTIVATION_CHANGE]\n`;
      p += `13. STAT CAP ENFORCEMENT: Base mortal stats (STR/AGI/INT/CHA) MUST NOT exceed 20 without cultivation or system aid. Stats above 20 require explicit cultivation tier advancement or special circumstances.\n`;
      p += `14. HUMAN PEAK RULE: A normal human without cultivation has stats between 1-20. Peak athletic humans reach 18-20. Stats above 20 indicate supernatural enhancement from cultivation, system intervention, or extraordinary circumstances.\n`;
    }

    if (s.toggles.time) {
      p += `13. [TIME_STATE] — MUST emit when a time-based state (poison, drunk, pregnancy, etc.) is applied: [TIME_STATE]{"id":"poison","name":"Poisoned","target":"npc_name","severity":30,"durationMinutes":120,"tickIntervalMinutes":10,"severityDeltaPerTick":-5,"showInUI":true,"description":"Slow-acting venom"}[/TIME_STATE]\n`;
      p += `14. [TIME_STATE_REMOVE] — MUST emit when a time-based state expires: [TIME_STATE_REMOVE]poison[/TIME_STATE_REMOVE]\n`;
    }

    if (s.toggles.npcDepth) {
      p += `15. [NPC_PROFILE] — MUST emit when new traits, thresholds, schedules, or inter-NPC relationships are established: [NPC_PROFILE]{"npcName":"...","traits":[...],"aggressionThreshold":70,"jealousyThreshold":50,"trust":60,"affection":70,"schedule":["08:00 Breakfast","10:00 Training"],"knownLocation":"Main Hall","relationships":[{"targetName":"...","disposition":"friendly","strength":70}],"equipment":[]}[/NPC_PROFILE]\n`;
      p += `16. [GIFT] — MUST emit when the MC gives a gift to an NPC: [GIFT]{"giver":"MC","recipient":"npc_name","itemName":"Rose Bouquet","relationshipChange":"+20 affection","accepted":true}[/GIFT]\n`;
      p += `17. [NPC_GIFT] — MUST emit when an item is permanently given to an NPC: [NPC_GIFT]{"npcName":"...","item":{"name":"...","slot":"trinket","rarity":"rare","stats":{"cha":5}}}[/NPC_GIFT]\n`;
    }

    if (s.toggles.statChecks) {
      p += `18. [CHECK] — STAT CHECK RESOLUTION. MUST emit when a meaningful challenge resolves and the MC's stats decide the outcome (a contested action, a risky attempt, a social gambit): [CHECK]{"stat":"CHA","difficulty":"hard","context":"convincing the guard"}[/CHECK] — "stat" is the tested stat (STR/AGI/INT/CHA/END/WIL/LCK/PER or a subskill: Sneaking/Seduction/Negotiation/Intimidation), "difficulty" is OPTIONAL (trivial|easy|moderate|hard|brutal; omit it when unsure — the engine infers it from the NPCs and scene: hostile/aggressive targets default to hard or brutal, friendly targets ease it, weather/darkness affect physical/perception checks, cover eases Sneaking), "context" is optional. A single turn may carry SEVERAL [CHECK] tags in order — e.g. the MC talks their way out, and if that fails, dodges: emit the first check, then a recovery check with \"fallback\":true ([CHECK]{"stat":"AGI","fallback":true,"context":"dodging after the talk fails"}[/CHECK]). The engine resolves each in order and shows a line per check; a fallback declared after a failed check is slightly harder (+2 target, flagged in the line, and +half the failed primary's momentum penalty when it lands on a different stat — a critical failure's +4 carries +2 into the dodge), and same-stat attempts still carry momentum. A failed check against a NAMED hostile NPC also ARMS the scene: the NPC draws a weapon, retrying them is +2 target per prior failure (up to +6), and a success (or walking away) defuses it — so never repeat the identical check against the same armed NPC; write the escalation in fiction. The ENGINE rolls the d20, applies the effective stat + LCK, and computes the seven-tier outcome; it shows a system line and carries momentum (consecutive attempts on the same stat get harder after failures, easier after successes). NEVER invent roll numbers — the engine does the math.\n`;
    }

    if (s.toggles.memory) {
      p += `19. [MEMORY] — EPISODIC ACTION MEMORY. OPTIONAL but recommended for notable moments (a sparring session, a first kiss, a heist, a breakthrough): [MEMORY]{"summary":"Sparred with Rook at the dojo","npc":"Rook","category":"combat","intensity":70,"outcome":"won the bout (major success)","reward":"+180 system points","detail":"He favored his left side after the third exchange"}[/MEMORY] — \"summary\" is required; \"category\" is one of combat|social|intimacy|school|family|cultivation|craft|adventure|other; \"intensity\" is 0-100 so future actions can be compared (a hand-hold is ~10, a kiss ~45, a night together ~90); \"outcome\" and \"reward\" capture how it went and what the system gave. The engine ALSO remembers every resolved [CHECK], relationship reaction, and gift automatically — this tag is for the moments the mechanics don't capture. When the player later compares a new action to this one, treat this entry as canon and let it shape your response.\n`;
      p += `20. [MEMORY_REF] — CITING A PAST ACTION. When this turn BUILDS on a specific remembered moment (a rematch with the same partner, continuing a trade, revisiting a conversation), cite it explicitly with its id from the RECENT ACTION MEMORY block instead of paraphrasing: [MEMORY_REF]am_1a2b3c[/MEMORY_REF] (the id appears as \"· id am_…\" on each entry's line). The engine verifies the id against the log and shows a \"🔗 builds on\" line in the chat; a wrong id gets a warning so it cannot quietly pass as grounded. Use the id when the log lists the entry; otherwise reference the past action naturally in prose.\n`;
    }

  p += `\nFINAL SELF-CHECK BEFORE FINISHING (MUST DO): Re-read the narrative you just wrote and emit any block you missed.\n`;
  p += `- Introduced or met an NPC? -> [RELATION] for that NPC.\n`;
  p += `- The MC learned a price, route, schedule, rumor, or location detail? -> [FACT].\n`;
  p += `- The MC was given a task, quest, errand, or favor? -> [QUEST].\n`;
  p += `- Health, fatigue, inventory, money, time, or location changed? -> [STATE_UPDATE].\n`;
  p += `- The MC bought, sold, or was paid? -> [TRANSACTION].\n`;
  p += `\nFORMAT SELF-CHECK (MUST DO — these formatting mistakes break the engine, so never do them):\n`;
  p += `- Never wrap any block payload in markdown: no ** emphasis, no \`\`\` code fences, no * around JSON. Raw payload only, directly between the tags.\n`;
  p += `- Never split one array across two brackets: "inventory": [{...}],[{...}] is INVALID. Write ONE complete array: "inventory": [{...},{...}]. Same rule for objectives and every other list.\n`;
  p += `- Never add stray characters after a closing tag: close with [/STATE_UPDATE], not }/[STATE_UPDATE].\n`;

  p += `\nSTYLE INSTRUCTION: Write in an immersive literary style. Always end by leaving the next action open for the player.`;

  return p;
}
