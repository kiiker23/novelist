// =============================================================================
// schedules.ts — Logical schedule awareness (gentle time-of-day guidance).
//
// The AI is told about the world's default daily rhythm — who is asleep at
// 04:00, that school runs ~08:30–15:30, that shops close in the evening —
// as SOFT guidance: logical defaults the story may override. This prevents
// the classic failure where waking at 04:00 summons the whole household into
// the kitchen or the AI sends the MC to school at 05:00.
//
// The defaults are always phrased as plausibility anchors ("logically, at
// this hour..."), never as hard facts, and the module's own instruction tells
// the AI to follow established story details ([FACT], [RELATION], narrative)
// over the defaults.
// =============================================================================

import { StateModule } from "../state/state";
import { Relation } from "../state/GameState";
import { parseWorldClock } from "./director-notes";
import { isFamilyRelation } from "./family";

export type DayPhase =
  | "deep_night" // 00:00–05:00
  | "early_morning" // 05:00–06:30
  | "morning" // 06:30–08:30
  | "school_day" // 08:30–12:00
  | "midday" // 12:00–13:00
  | "work_afternoon" // 13:00–15:30
  | "after_school" // 15:30–18:00
  | "evening" // 18:00–22:00
  | "night"; // 22:00–24:00

export interface DayPhaseInfo {
  phase: DayPhase;
  label: string;
  /** What the world is doing at this hour — the soft "world pulse". */
  worldPulse: string;
}

const PHASES: Array<{ untilHour: number; info: DayPhaseInfo }> = [
  {
    untilHour: 5,
    info: {
      phase: "deep_night",
      label: "deep night",
      worldPulse:
        "The world is asleep. Households are dark and quiet, streets are empty, and shops and schools are closed. Almost no one is awake.",
    },
  },
  {
    untilHour: 6.5,
    info: {
      phase: "early_morning",
      label: "early morning",
      worldPulse:
        "The world is just stirring. Most people are still asleep; only early risers (bakers, farmers, night-shift workers coming home) are awake. Students do not leave for school until around 08:00–08:30 and workers by 09:00 — no one heads out before dawn.",
    },
  },
  {
    untilHour: 8.5,
    info: {
      phase: "morning",
      label: "morning",
      worldPulse:
        "Wake-up window. Households are having breakfast and getting ready; students and workers prepare to leave for school or work.",
    },
  },
  {
    untilHour: 12,
    info: {
      phase: "school_day",
      label: "mid-morning",
      worldPulse:
        "Mid-morning. Students are in class, workers are at their posts, and shops are open for business.",
    },
  },
  {
    untilHour: 13,
    info: {
      phase: "midday",
      label: "midday",
      worldPulse: "Lunchtime. Students and workers break for a meal.",
    },
  },
  {
    untilHour: 15.5,
    info: {
      phase: "work_afternoon",
      label: "early afternoon",
      worldPulse: "Early afternoon. School and work continue.",
    },
  },
  {
    untilHour: 18,
    info: {
      phase: "after_school",
      label: "late afternoon",
      worldPulse:
        "Late afternoon. Students are out of class; most workers remain on the job until around 17:00.",
    },
  },
  {
    untilHour: 22,
    info: {
      phase: "evening",
      label: "evening",
      worldPulse:
        "Evening. People return home for dinner and leisure; shops begin closing.",
    },
  },
  {
    untilHour: 24,
    info: {
      phase: "night",
      label: "late evening",
      worldPulse:
        "Late evening. Households wind down and most people head to bed around 22:00–23:00.",
    },
  },
];

/** Classify an hour of day (0-23, decimals allowed for half-hours). */
export function getDayPhase(hour: number): DayPhaseInfo {
  for (const { untilHour, info } of PHASES) {
    if (hour < untilHour) return info;
  }
  return PHASES[PHASES.length - 1].info;
}

export type Vocation =
  | "student"
  | "teacher"
  | "bartender"
  | "worker"
  | "elderly"
  | "household";

/**
 * Infer a person's likely daily rhythm from their relation disposition (and
 * name as a fallback). Conservative: only well-signaled keywords classify;
 * everything else defaults to the generic household routine.
 */
export function inferVocation(disposition: string, name: string): Vocation {
  const hay = `${disposition || ""} ${name || ""}`.toLowerCase();
  if (/teacher|professor|instructor|principal|tutor/.test(hay)) return "teacher";
  // Household children (sister, brother, daughter, son...) are typically
  // school-aged — a safe default for academy/school stories, softly phrased.
  if (/school|student|classmate|academy|class|kindergarten|sister|brother|daughter|son|child|kid/.test(hay)) return "student";
  if (/bartender|barkeep|tavern keeper|innkeeper|bouncer/.test(hay)) return "bartender";
  if (/grandma|grandfather|grandmother|grandpa|elderly|grandparent|retired/.test(hay)) return "elderly";
  if (
    /works? (at|in|for|the|a)|job|shift|employee|merchant|shopkeeper|smith|diner|office|hospital|guard|farm|factory|store/.test(
      hay,
    )
  ) {
    return "worker";
  }
  return "household";
}

/**
 * What a person with this vocation is logically doing at the given hour,
 * phrased softly. Returns a short "at <place>, <activity>" string.
 */
export function expectedState(vocation: Vocation, hour: number): string {
  switch (vocation) {
    case "student":
      if (hour < 6.5) return "asleep at home";
      if (hour < 8) return "waking up and having breakfast at home";
      if (hour < 8.5) return "getting ready for school at home";
      if (hour < 15.5) return "at school";
      if (hour < 18) return "home from school";
      if (hour < 22) return "at home (dinner, homework, evening activities)";
      return "asleep at home";
    case "teacher":
      if (hour < 6.5) return "asleep at home";
      if (hour < 7.5) return "waking up and getting ready at home";
      if (hour < 15.5) return "at school";
      if (hour < 18) return "at home or running errands";
      if (hour < 22) return "at home, evening";
      return "asleep at home";
    case "bartender":
      if (hour >= 18 || hour < 3) return "at work (the bar)";
      if (hour < 12) return "asleep at home (night-shift worker)";
      if (hour < 16) return "resting at home";
      return "getting ready for the evening shift";
    case "worker":
      if (hour < 6.5) return "asleep at home";
      if (hour < 8) return "waking up and getting ready at home";
      if (hour < 9) return "commuting to work";
      if (hour < 17) return "at work";
      if (hour < 19) return "commuting home or arriving home";
      if (hour < 22) return "at home, evening";
      return "asleep at home";
    case "elderly":
      if (hour < 5.5) return "asleep at home";
      if (hour < 8.5) return "awake at home, having breakfast";
      if (hour < 17) return "at home or nearby, going about the day";
      if (hour < 21) return "at home, relaxing";
      return "asleep at home";
    default:
      // household
      if (hour < 6.5) return "asleep at home";
      if (hour < 8.5) return "waking up and having breakfast at home";
      if (hour < 17) return "at home or nearby, running errands";
      if (hour < 22) return "at home, evening";
      return "asleep at home";
  }
}

/** Format an hour for display, e.g. 6.5 -> "06:30". */
export function formatHour(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Build the SCHEDULE CONTEXT block for the system prompt: the world pulse at
 * the current clock time plus per-household-member logical expectations.
 * Returns an empty string when the clock is unparseable or the toggle is off
 * (callers gate on the toggle too).
 */
export function buildScheduleContext(): string {
  const s = StateModule.state;
  const clock = parseWorldClock(s.worldState.time);
  if (!clock) return "";
  const phaseInfo = getDayPhase(clock.hour + clock.minute / 60);

  let p = `\n=== SCHEDULE CONTEXT (LOGICAL DEFAULTS — follow unless the story has established otherwise) ===\n`;
  p += `- CURRENT TIME: ${s.worldState.time} (${phaseInfo.label})\n`;
  p += `- The world at this hour: ${phaseInfo.worldPulse}\n`;
  p += `- Logical anchors: school runs roughly 08:30–15:30, typical work hours 09:00–17:00, and most people are asleep before 06:00 and after 22:00. A household member waking the MC at 04:00 or a student heading to school before 07:30 would be unusual — unless the story has set it up.\n`;

  const household = (s.memory.relations || []).filter(
    (r: Relation) => r.status !== "Deceased" && isFamilyRelation(r),
  );
  if (household.length > 0) {
    p += `- Household expectations at this hour (logical defaults, not facts):\n`;
    for (const r of household) {
      const voc = inferVocation(r.disposition, r.name);
      p += `  - ${r.name} (${(r.disposition || "family member").toLowerCase()}, ${voc}): ${expectedState(
        voc,
        clock.hour + clock.minute / 60,
      )}\n`;
    }
  }

  p += `- These are defaults for plausibility, not hard rules: if the story has established that someone is awake, elsewhere, or on a different routine (via [FACT], [RELATION], or the narrative), follow the story.\n`;
  return p;
}
