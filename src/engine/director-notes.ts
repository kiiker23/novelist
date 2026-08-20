// =============================================================================
// director-notes.ts — Timed Director's Notes.
//
// Director's Notes are author-injected world events. Notes can carry a
// relative deadline parsed from their text (\"in 2 days\", \"tomorrow\", \"in 3
// hours\"); the deadline counts down against in-game time every turn. When it
// reaches zero the event \"fires\": it is marked `fired`, its stale deadline
// phrasing is reworded to \"NOW\", and the prompt shows it as happening NOW.
// Fired events are auto-resolved (dropped) after a few turns.
//
// In-game clock: each turn advances ~10 minutes (matching TimeStateModule's
// assumption). Deadlines are evaluated against the game's post-turn clock —
// the `worldState.time` the AI reports after a turn completes — with the turn
// counter as a fallback when the time string can't be parsed. Clock readings
// are tracked as an unwrapped minute count so cumulative elapsed stays
// accurate across narrative fast-forwards (\"three months pass\") and cycle
// wraps (week wrap for weekday-only clocks, year wrap for calendar dates);
// the larger elapsed estimate wins.
// =============================================================================

import { StateModule } from "../state/state";
import { DirectorNote } from "../state/GameState";

export const MINUTES_PER_TURN = 10;
export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
export const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
export const MINUTES_PER_YEAR = 365 * MINUTES_PER_DAY;

/** Turns a fired event stays in the prompt as \"NOW ACTIVE\" before auto-resolving. */
export const FIRED_RETENTION_TURNS = 3;

const WEEKDAYS: Record<string, number> = {
  mon: 0, monday: 0,
  tue: 1, tues: 1, tuesday: 1,
  wed: 2, wednesday: 2,
  thu: 3, thur: 3, thurs: 3, thursday: 3,
  fri: 4, friday: 4,
  sat: 5, saturday: 5,
  sun: 6, sunday: 6,
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * Matches the relative-deadline phrasings parseDeadline understands
 * (\"in 2 days\", \"in about three hours\", \"tomorrow\", \"tonight\", \"next week\").
 * Used to reword fired notes so they read as active instead of upcoming.
 */
const DEADLINE_PHRASE_RE =
  /\bin\s+(?:about\s+|approximately\s+)?(?:[a-z]+|\d+)\s+(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\b|\b(?:next week|tomorrow|tonight)\b/gi;

/** Parse a relative deadline like \"in 2 days\" / \"tomorrow\" into in-game minutes. */
export function parseDeadline(text: string): number | undefined {
  const t = text.toLowerCase().trim();

  if (/\bnext week\b/.test(t)) return MINUTES_PER_WEEK;
  if (/\btomorrow\b/.test(t)) return MINUTES_PER_DAY;
  if (/\btonight\b/.test(t)) return 12 * MINUTES_PER_HOUR;

  const m = /in\s+(?:about\s+|approximately\s+)?([a-z]+|\d+)\s+(minutes?|mins?|hours?|hrs?|days?|weeks?|months?)/.exec(t);
  if (m) {
    const qty = NUMBER_WORDS[m[1]] ?? parseInt(m[1], 10);
    if (!Number.isFinite(qty) || qty <= 0) return undefined;
    const unit = m[2];
    if (unit.startsWith("min")) return Math.max(1, Math.round(qty));
    if (unit.startsWith("hour") || unit.startsWith("hr")) return qty * MINUTES_PER_HOUR;
    if (unit.startsWith("day")) return qty * MINUTES_PER_DAY;
    if (unit.startsWith("week")) return qty * MINUTES_PER_WEEK;
    if (unit.startsWith("month")) return qty * 30 * MINUTES_PER_DAY;
  }
  return undefined;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/** Days per month (non-leap); used for calendar-date day-of-year math. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * A parsed in-game clock reading.
 *
 * `minutes` is the reading expressed as in-game minutes since the start of
 * the current cycle. `cycleMinutes` is that cycle's length: readings wrap
 * back to 0 after it, so cumulative-elapsed tracking must carry a full cycle
 * forward when a later reading lands before the last one (week wrap for
 * weekday-only / "Day N" clocks, year wrap for calendar dates). Calendar
 * dates WITH a year are absolute (cycleMinutes = Infinity) and never wrap.
 */
export interface ParsedClock {
  minutes: number;
  cycleMinutes: number;
  /** Hour of day 0-23 (used by the schedule-awareness module). */
  hour: number;
  /** Minute within the hour 0-59. */
  minute: number;
}

/**
 * Parse a worldState.time string into a cycle-relative in-game minute count.
 * Understands:
 *   \"Monday, March 17, 07:00\"  (24h clock + calendar date — canonical)
 *   \"Monday, March 17, 1263, 07:00\" (same, with a year for multi-year stories)
 *   \"Monday, 07:00 AM\"        (weekday + 12/24h clock, legacy)
 *   \"Day 3, 14:30\"            (day counter, legacy)
 * Returns undefined when the string has no parseable time/date.
 */
export function parseWorldClock(timeStr: string): ParsedClock | undefined {
  const t = (timeStr || "").trim();
  if (!t) return undefined;

  const timeMatch = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(t);
  if (!timeMatch) return undefined;
  let hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);
  const meridiem = timeMatch[3]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const minutesOfDay = hour * MINUTES_PER_HOUR + minute;

  // Calendar date: \"Monday, March 17, 07:00\" / \"March 17, 1263, 07:00\".
  const dateMatch = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/i.exec(t);
  if (dateMatch) {
    const monthIndex = MONTHS[dateMatch[1].toLowerCase()];
    const day = parseInt(dateMatch[2], 10);
    if (monthIndex === undefined || day < 1 || day > MONTH_DAYS[monthIndex]) return undefined;
    let dayOfYear = 0;
    for (let m = 0; m < monthIndex; m++) dayOfYear += MONTH_DAYS[m];
    dayOfYear += day - 1;

    // Optional 4-digit year directly after the day: \"March 17, 1263, 07:00\".
    const after = t.slice(dateMatch.index + dateMatch[0].length);
    const yearMatch = /^\s*,?\s*(\d{4})\b/.exec(after);
    if (yearMatch) {
      const year = parseInt(yearMatch[1], 10);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const doy = leap && monthIndex > 1 ? dayOfYear + 1 : dayOfYear;
      return {
        minutes: year * MINUTES_PER_YEAR + doy * MINUTES_PER_DAY + minutesOfDay,
        cycleMinutes: Infinity,
        hour,
        minute,
      };
    }
    return { minutes: dayOfYear * MINUTES_PER_DAY + minutesOfDay, cycleMinutes: MINUTES_PER_YEAR, hour, minute };
  }

  const weekdayMatch = /^([A-Za-z]+day)\b/i.exec(t);
  if (weekdayMatch) {
    const day = WEEKDAYS[weekdayMatch[1].toLowerCase()];
    if (day === undefined) return undefined;
    return { minutes: day * MINUTES_PER_DAY + minutesOfDay, cycleMinutes: MINUTES_PER_WEEK, hour, minute };
  }

  const dayNumMatch = /^day\s+(\d+)[,\s]/i.exec(t);
  if (dayNumMatch) {
    return {
      minutes: (parseInt(dayNumMatch[1], 10) - 1) * MINUTES_PER_DAY + minutesOfDay,
      cycleMinutes: MINUTES_PER_WEEK,
      hour,
      minute,
    };
  }

  return undefined;
}

/**
 * Back-compat alias returning only the cycle-relative minute count
 * (parseWorldClock(...).minutes). Kept exported for legacy callers; new code
 * should use parseWorldClock to also get the cycle for elapsed tracking.
 */
export function parseWeekdayTime(timeStr: string): number | undefined {
  return parseWorldClock(timeStr)?.minutes;
}

/** Build a new DirectorNote from text, capturing the current turn + clock. */
export function createDirectorNote(text: string): DirectorNote {
  const s = StateModule.state;
  const parsedNow = parseWorldClock(s.worldState.time);
  return {
    id: `dn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    text: text.trim(),
    deadlineMinutes: parseDeadline(text),
    createdAtTurn: s.turnCount,
    createdTimeMinutes: parsedNow?.minutes,
    lastSeenTimeMinutes: parsedNow?.minutes,
    fired: false,
  };
}

/**
 * In-game minutes elapsed since a note was created (best available clock).
 *
 * The AI reports `worldState.time` as the clock AFTER a turn's events, so a
 * parsed reading is the game's post-turn time. We track it as an unwrapped
 * minute count (carrying a full week when the weekday clock wraps) so the
 * parsed elapsed is CUMULATIVE since creation — this is what lets deadlines
 * fire from the in-game clock when the narrative fast-forwards time.
 */
export function getNoteElapsedMinutes(note: DirectorNote): number {
  const s = StateModule.state;
  const turnElapsed = (s.turnCount - note.createdAtTurn) * MINUTES_PER_TURN;

  const parsedNow = parseWorldClock(s.worldState.time);
  let parsedElapsed = 0;
  if (parsedNow !== undefined && note.createdTimeMinutes !== undefined) {
    if (note.lastSeenTimeMinutes === undefined) {
      note.lastSeenTimeMinutes = parsedNow.minutes;
    } else if (Number.isFinite(parsedNow.cycleMinutes)) {
      // Rebuild an unwrapped absolute reading: current cycle index from the
      // last reading, plus today's cycle-relative clock. A reading that lands
      // before the last one means the cycle wrapped (week wrap for weekday
      // clocks, year wrap for calendar dates without a year).
      const cycle = parsedNow.cycleMinutes;
      const cycleIndex = Math.floor(note.lastSeenTimeMinutes / cycle);
      let candidate = cycleIndex * cycle + parsedNow.minutes;
      if (candidate < note.lastSeenTimeMinutes) candidate += cycle;
      note.lastSeenTimeMinutes = candidate;
    } else {
      // Absolute reading (calendar date WITH a year): never wraps, but keep
      // the clock monotonic in case the AI rewords the clock backwards.
      note.lastSeenTimeMinutes = Math.max(note.lastSeenTimeMinutes, parsedNow.minutes);
    }
    parsedElapsed = Math.max(0, note.lastSeenTimeMinutes - note.createdTimeMinutes);
  }

  return Math.max(turnElapsed, parsedElapsed);
}

/**
 * Reword a directive note for display. The raw instruction (\"Add librarian
 * Elle to relationship and NPC list\") was already honored mechanically by
 * the engine, so the prompt must NOT carry the meta-instruction — it renders
 * as a neutral in-world mention instead (\"Elle, the librarian.\").
 */
export function rewordDirectiveNote(note: DirectorNote): string {
  const d = note.directive;
  if (d) {
    const role = (d.disposition || "").trim();
    return role ? `${d.name}, the ${role}.` : `${d.name}.`;
  }
  // A fact-correction note was already applied to the lore mechanically —
  // render the corrected attribution, never the raw instruction.
  if (note.factFix) {
    return `Correction: the earlier fact mentioning ${note.factFix.oldPhrase} actually concerns ${note.factFix.newName}.`;
  }
  // A naming note was applied mechanically (the role-titled entry was
  // renamed) — render the name as a natural in-world mention.
  if (note.naming) {
    return `The MC's ${note.naming.role.toLowerCase()} is called ${note.naming.name}.`;
  }
  return note.text;
}

/**
 * Reword a fired note for display: replace its stale relative-deadline
 * phrasing (\"in 2 days\", \"tomorrow\", \"in 3 hours\"...) with \"NOW\" so the
 * note reads as active instead of as an upcoming countdown. Returns the text
 * unchanged when the note hasn't fired or has nothing to reword.
 */
export function rewordFiredNote(note: DirectorNote): string {
  if (!note.fired) return note.text;
  return note.text.replace(DEADLINE_PHRASE_RE, "NOW");
}

/** Format a remaining-duration in a compact \"2d\" / \"3h\" / \"45m\" form. */
export function formatRemainingMinutes(mins: number): string {
  const m = Math.max(0, Math.ceil(mins));
  if (m < MINUTES_PER_HOUR) return `${m}m`;
  if (m < MINUTES_PER_DAY) return `${Math.ceil(m / MINUTES_PER_HOUR)}h`;
  return `${Math.ceil(m / MINUTES_PER_DAY)}d`;
}

/**
 * Advance timed notes for the current turn: fire notes whose deadline has
 * passed and auto-resolve (drop) fired notes after FIRED_RETENTION_TURNS.
 * Returns the notes that fired this turn so the caller can surface them.
 */
export function advanceDirectorNotes(): DirectorNote[] {
  const s = StateModule.state;
  const notes = s.directorNotes;
  const newlyFired: DirectorNote[] = [];

  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i];

    if (note.deadlineMinutes !== undefined && !note.fired) {
      const elapsed = getNoteElapsedMinutes(note);
      if (elapsed >= note.deadlineMinutes) {
        note.fired = true;
        note.firedAtTurn = s.turnCount;
        newlyFired.push(note);
      }
    }

    if (note.fired && s.turnCount - (note.firedAtTurn ?? s.turnCount) >= FIRED_RETENTION_TURNS) {
      notes.splice(i, 1);
    }
  }

  return newlyFired;
}
