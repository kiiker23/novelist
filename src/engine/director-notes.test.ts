// =============================================================================
// director-notes.test.ts — Director's Note (author event injection) pipeline.
//
// Covers: deadline parsing, weekday-time clock, state add/remove, firing logic,
// prompt injection (countdown / NOW ACTIVE), auto-resolve, and per-turn
// delivery to the AI via the mocked API call.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Minimal document + localStorage stubs for UIManager / StorageModule.
// getElementById consults a per-test element registry so tests can capture
// rendered output (e.g. the Director's Note chips) while every other id
// still resolves to null exactly as before.
interface TestElement {
  innerHTML: string;
  appendChild?: (child: { innerHTML: string }) => void;
}
const testElements = new Map<string, TestElement>();
(globalThis as any).document = {
  getElementById: (id: string) => testElements.get(id) ?? null,
  createElement: () => ({
    setAttribute() {},
    click() {},
    remove() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
  }),
  addEventListener: () => {},
  body: { appendChild() {} },
};
(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  key: () => null,
  length: 0,
};

const { mockGenerateResponse } = vi.hoisted(() => ({
  mockGenerateResponse: vi.fn(),
}));
vi.mock("../api/providers", () => ({
  ApiModule: { generateResponse: mockGenerateResponse, testConnection: vi.fn() },
}));

import { StateModule } from "../state/state";
import { DirectorNote } from "../state/GameState";
import { buildSystemPrompt } from "./prompt";
import { GameEngine } from "./turn";
import {
  parseDeadline,
  parseWeekdayTime,
  parseWorldClock,
  formatRemainingMinutes,
  getNoteElapsedMinutes,
  rewordFiredNote,
  rewordDirectiveNote,
  advanceDirectorNotes,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  MINUTES_PER_TURN,
  MINUTES_PER_WEEK,
  MINUTES_PER_YEAR,
  FIRED_RETENTION_TURNS,
} from "./director-notes";

function resetState(): void {
  const s = StateModule.state;
  s.directorNotes = [];
  s.turnCount = 0;
  s.history = [];
  s.setup = {};
  s.worldState = { time: "Monday, March 17, 07:00", location: "Starting Location", measurement: "Metric" };
  mockGenerateResponse.mockReset();
}

// ===========================================================================
// Pure helpers
// ===========================================================================

describe("parseDeadline", () => {
  it('parses "in 2 days"', () => expect(parseDeadline("in 2 days")).toBe(2 * MINUTES_PER_DAY));
  it('parses "in three days"', () => expect(parseDeadline("in three days")).toBe(3 * MINUTES_PER_DAY));
  it('parses "in 2 hours"', () => expect(parseDeadline("in 2 hours")).toBe(2 * MINUTES_PER_HOUR));
  it('parses "in 30 minutes"', () => expect(parseDeadline("in 30 minutes")).toBe(30));
  it('parses "in an hour"', () => expect(parseDeadline("in an hour")).toBe(1 * MINUTES_PER_HOUR));
  it('parses "in a week"', () => expect(parseDeadline("in a week")).toBe(7 * MINUTES_PER_DAY));
  it('parses "in 2 weeks"', () => expect(parseDeadline("in 2 weeks")).toBe(14 * MINUTES_PER_DAY));
  it('parses "in a month"', () => expect(parseDeadline("in a month")).toBe(30 * MINUTES_PER_DAY));
  it('parses "tomorrow"', () => expect(parseDeadline("tomorrow")).toBe(1 * MINUTES_PER_DAY));
  it('parses "tonight"', () => expect(parseDeadline("tonight")).toBe(12 * MINUTES_PER_HOUR));
  it('parses "next week"', () => expect(parseDeadline("next week")).toBe(7 * MINUTES_PER_DAY));
  it('parses "in about 2 hours"', () => expect(parseDeadline("in about 2 hours")).toBe(2 * MINUTES_PER_HOUR));
  it('parses "in approximately 3 days"', () => expect(parseDeadline("in approximately 3 days")).toBe(3 * MINUTES_PER_DAY));
  it("returns undefined for text with no deadline", () => {
    expect(parseDeadline("The secret realm opens at midnight")).toBeUndefined();
    expect(parseDeadline("NPC x's birthday")).toBeUndefined();
  });
  it("returns undefined for empty/whitespace", () => {
    expect(parseDeadline("")).toBeUndefined();
    expect(parseDeadline("   ")).toBeUndefined();
  });
  it("parses inline deadline inside longer text", () => {
    // The secret realm opens in 2 days → parse finds "in 2 days"
    expect(parseDeadline("The secret realm opens in 2 days")).toBe(2 * MINUTES_PER_DAY);
  });
});

describe("parseWeekdayTime", () => {
  it('parses "Monday, 07:00 AM"', () => expect(parseWeekdayTime("Monday, 07:00 AM")).toBe(7 * MINUTES_PER_HOUR));
  it('parses "Wednesday, 14:30"', () => {
    const expected = 2 * MINUTES_PER_DAY + 14 * MINUTES_PER_HOUR + 30;
    expect(parseWeekdayTime("Wednesday, 14:30")).toBe(expected);
  });
  it('parses "Day 3, 08:00 AM"', () => {
    const expected = 2 * MINUTES_PER_DAY + 8 * MINUTES_PER_HOUR;
    expect(parseWeekdayTime("Day 3, 08:00 AM")).toBe(expected);
  });
  it('parses "Sunday, 11:59 PM"', () => {
    const expected = 6 * MINUTES_PER_DAY + 23 * MINUTES_PER_HOUR + 59;
    expect(parseWeekdayTime("Sunday, 11:59 PM")).toBe(expected);
  });
  it('parses "Monday, March 17, 07:00" (24h clock + calendar date)', () => {
    const expected = (31 + 28 + 17 - 1) * MINUTES_PER_DAY + 7 * MINUTES_PER_HOUR;
    expect(parseWeekdayTime("Monday, March 17, 07:00")).toBe(expected);
  });
  it("parses a 24h evening clock (no AM/PM)", () => {
    const expected = (31 + 28 + 19 - 1) * MINUTES_PER_DAY + 19 * MINUTES_PER_HOUR;
    expect(parseWeekdayTime("Wednesday, March 19, 19:00")).toBe(expected);
  });
  it("parses a calendar date without a weekday", () => {
    const expected = (31 + 28 + 17 - 1) * MINUTES_PER_DAY + 7 * MINUTES_PER_HOUR;
    expect(parseWeekdayTime("March 17, 07:00")).toBe(expected);
  });
  it("parses a full date with a year as absolute minutes", () => {
    expect(parseWeekdayTime("Monday, March 17, 1263, 07:00")).toBe(
      1263 * MINUTES_PER_YEAR + (31 + 28 + 17 - 1) * MINUTES_PER_DAY + 7 * MINUTES_PER_HOUR,
    );
  });
  it("returns undefined for unparseable strings", () => {
    expect(parseWeekdayTime("")).toBeUndefined();
    expect(parseWeekdayTime("somewhere far away")).toBeUndefined();
  });
});

describe("parseWorldClock cycles", () => {
  it("calendar dates without a year cycle yearly", () => {
    expect(parseWorldClock("Monday, March 17, 07:00")?.cycleMinutes).toBe(MINUTES_PER_YEAR);
  });
  it("dates with a year never wrap", () => {
    expect(parseWorldClock("Monday, March 17, 1263, 07:00")?.cycleMinutes).toBe(Infinity);
  });
  it("weekday-only and Day-N clocks cycle weekly", () => {
    expect(parseWorldClock("Monday, 07:00 AM")?.cycleMinutes).toBe(MINUTES_PER_WEEK);
    expect(parseWorldClock("Day 3, 08:00")?.cycleMinutes).toBe(MINUTES_PER_WEEK);
  });
  it("rejects impossible calendar dates", () => {
    expect(parseWorldClock("Monday, February 30, 07:00")).toBeUndefined();
    expect(parseWorldClock("Monday, March 32, 07:00")).toBeUndefined();
  });
});

describe("formatRemainingMinutes", () => {
  it("formats minutes", () => expect(formatRemainingMinutes(45)).toBe("45m"));
  it("formats hours", () => expect(formatRemainingMinutes(120)).toBe("2h"));
  it("formats days", () => expect(formatRemainingMinutes(MINUTES_PER_DAY * 3)).toBe("3d"));
  it("rounds up", () => expect(formatRemainingMinutes(1)).toBe("1m"));
  it("never negative", () => expect(formatRemainingMinutes(-5)).toBe("0m"));
  it("partial hour rounds up", () => expect(formatRemainingMinutes(MINUTES_PER_HOUR + 1)).toBe("2h"));
});

// ===========================================================================
// Fired-note rewording (stale deadline text -> NOW)
// ===========================================================================

describe("rewordFiredNote", () => {
  const fired = (text: string) => ({ id: "x", text, fired: true } as DirectorNote);

  it('rewords "in 2 days" phrasing to NOW', () => {
    expect(rewordFiredNote(fired("The realm opens in 2 days."))).toBe("The realm opens NOW.");
  });
  it('rewords word-numbered and approximate deadlines', () => {
    expect(rewordFiredNote(fired("The council convenes in three hours."))).toBe("The council convenes NOW.");
    expect(rewordFiredNote(fired("The hunt starts in about 2 days."))).toBe("The hunt starts NOW.");
  });
  it('rewords tomorrow / tonight / next week', () => {
    expect(rewordFiredNote(fired("The festival begins tomorrow."))).toBe("The festival begins NOW.");
    expect(rewordFiredNote(fired("The duel happens tonight."))).toBe("The duel happens NOW.");
    expect(rewordFiredNote(fired("The council convenes next week."))).toBe("The council convenes NOW.");
  });
  it("leaves notes without deadline phrasing unchanged", () => {
    expect(rewordFiredNote(fired("The Azura Song concert is happening."))).toBe("The Azura Song concert is happening.");
  });
  it("keeps unfired notes unchanged", () => {
    expect(rewordFiredNote({ id: "x", text: "The realm opens in 2 days.", fired: false } as DirectorNote)).toBe(
      "The realm opens in 2 days.",
    );
  });
});

// ===========================================================================
// State management
// ===========================================================================

describe("GameEngine.addDirectorNote", () => {
  beforeEach(resetState);

  it("creates a DirectorNote from text with deadline parsed", () => {
    GameEngine.addDirectorNote("The secret realm opens in 2 days.");
    const notes = StateModule.state.directorNotes as DirectorNote[];
    expect(notes.length).toBe(1);
    const n = notes[0];
    expect(n.text).toBe("The secret realm opens in 2 days.");
    expect(n.deadlineMinutes).toBe(2 * MINUTES_PER_DAY);
    expect(n.createdAtTurn).toBe(StateModule.state.turnCount);
    expect(n.fired).toBe(false);
    expect(n.id).toMatch(/^dn_/);
  });

  it("creates an open-ended note when no deadline is parsed", () => {
    GameEngine.addDirectorNote("A famous pop band is giving a concert.");
    const n = (StateModule.state.directorNotes as DirectorNote[])[0];
    expect(n.deadlineMinutes).toBeUndefined();
  });

  it("rejects empty input", () => {
    expect(GameEngine.addDirectorNote("")).toBe(false);
    expect(GameEngine.addDirectorNote("   ")).toBe(false);
    expect(StateModule.state.directorNotes.length).toBe(0);
  });

  it("appends multiple notes in order", () => {
    GameEngine.addDirectorNote("Event one.");
    GameEngine.addDirectorNote("Event two.");
    expect(StateModule.state.directorNotes.length).toBe(2);
  });
});

describe("GameEngine.removeDirectorNote", () => {
  beforeEach(resetState);

  it("removes a note by index", () => {
    GameEngine.addDirectorNote("First.");
    GameEngine.addDirectorNote("Second.");
    GameEngine.removeDirectorNote(0);
    expect((StateModule.state.directorNotes as DirectorNote[]).map((n) => n.text)).toEqual(["Second."]);
  });

  it("ignores out-of-range indices", () => {
    GameEngine.addDirectorNote("Only.");
    GameEngine.removeDirectorNote(5);
    GameEngine.removeDirectorNote(-1);
    expect(StateModule.state.directorNotes.length).toBe(1);
  });
});

// ===========================================================================
// Firing logic
// ===========================================================================

describe("advanceDirectorNotes", () => {
  beforeEach(resetState);

  it("fires a note when its deadline is passed", () => {
    // Create a note with a deadline of 1 turn worth of minutes.
    const note: DirectorNote = {
      id: "test",
      text: "The realm opens.",
      deadlineMinutes: MINUTES_PER_TURN, // 10 min
      createdAtTurn: 0,
      fired: false,
    };
    StateModule.state.directorNotes.push(note);
    // Advance 1 turn: turnCount becomes 1, elapsed = (1-0)*10 = 10 ≥ 10 → fired.
    StateModule.state.turnCount = 1;
    const fired = advanceDirectorNotes();
    expect(fired.length).toBe(1);
    expect(fired[0].text).toBe("The realm opens.");
    expect(note.fired).toBe(true);
    expect(note.firedAtTurn).toBe(1);
  });

  it("does not fire a note whose deadline has not been reached", () => {
    const note: DirectorNote = {
      id: "test2",
      text: "Pop band concert.",
      deadlineMinutes: 2 * MINUTES_PER_TURN, // 20 min
      createdAtTurn: 0,
      fired: false,
    };
    StateModule.state.directorNotes.push(note);
    StateModule.state.turnCount = 1; // only 10 min elapsed
    const fired = advanceDirectorNotes();
    expect(fired.length).toBe(0);
    expect(note.fired).toBe(false);
  });

  it("fires immediately when deadlineMinutes is 0 (already due)", () => {
    const note: DirectorNote = {
      id: "test3",
      text: "Concert is right now.",
      deadlineMinutes: 0,
      createdAtTurn: 0,
      fired: false,
    };
    StateModule.state.directorNotes.push(note);
    StateModule.state.turnCount = 1;
    const fired = advanceDirectorNotes();
    expect(fired.length).toBe(1);
  });

  it("auto-resolves fired notes after FIRED_RETENTION_TURNS", () => {
    const note: DirectorNote = {
      id: "test4",
      text: "Short event.",
      deadlineMinutes: 0,
      createdAtTurn: 0,
      fired: true,
      firedAtTurn: 0,
    };
    StateModule.state.directorNotes.push(note);
    // After FIRED_RETENTION_TURNS turns have passed since firing.
    StateModule.state.turnCount = FIRED_RETENTION_TURNS;
    advanceDirectorNotes();
    expect(StateModule.state.directorNotes.length).toBe(0);
  });

  it("keeps fired notes that haven't aged out yet", () => {
    const note: DirectorNote = {
      id: "test5",
      text: "Still active.",
      deadlineMinutes: 0,
      createdAtTurn: 0,
      fired: true,
      firedAtTurn: 0,
    };
    StateModule.state.directorNotes.push(note);
    StateModule.state.turnCount = FIRED_RETENTION_TURNS - 1; // not yet expired
    advanceDirectorNotes();
    expect(StateModule.state.directorNotes.length).toBe(1);
  });

  it("does not fire open-ended notes (no deadline)", () => {
    const note: DirectorNote = {
      id: "test6",
      text: "Just a note.",
      createdAtTurn: 0,
      fired: false,
    };
    StateModule.state.directorNotes.push(note);
    StateModule.state.turnCount = 100;
    const fired = advanceDirectorNotes();
    expect(fired.length).toBe(0);
    expect(note.fired).toBe(false);
  });

  it("fires from the post-turn game clock even when few turns have passed", () => {
    // "in 2 days" deadline; the AI's post-turn clock fast-forwards two days.
    const note: DirectorNote = {
      id: "clock1",
      text: "The festival begins in 2 days.",
      deadlineMinutes: 2 * MINUTES_PER_DAY,
      createdAtTurn: 0,
      createdTimeMinutes: parseWeekdayTime("Monday, March 17, 07:00"),
      lastSeenTimeMinutes: parseWeekdayTime("Monday, March 17, 07:00"),
      fired: false,
    };
    StateModule.state.directorNotes.push(note);
    StateModule.state.turnCount = 3; // only 30 in-game minutes by the turn counter
    StateModule.state.worldState.time = "Wednesday, March 19, 07:00";
    const fired = advanceDirectorNotes();
    expect(fired.length).toBe(1);
    expect(note.fired).toBe(true);
  });

  it("does not fire until the post-turn clock reaches the deadline", () => {
    const note: DirectorNote = {
      id: "clock2",
      text: "The trial begins in 1 day.",
      deadlineMinutes: MINUTES_PER_DAY,
      createdAtTurn: 0,
      createdTimeMinutes: parseWeekdayTime("Monday, March 17, 07:00"),
      lastSeenTimeMinutes: parseWeekdayTime("Monday, March 17, 07:00"),
      fired: false,
    };
    StateModule.state.directorNotes.push(note);
    StateModule.state.turnCount = 3; // 30 min by turns, well under 1 day
    StateModule.state.worldState.time = "Monday, March 17, 07:30";
    const fired = advanceDirectorNotes();
    expect(fired.length).toBe(0);
    expect(note.fired).toBe(false);
  });

  it("accumulates clock elapsed across turns instead of resetting to the last delta", () => {
    const note: DirectorNote = {
      id: "clock3",
      text: "In 3 days.",
      deadlineMinutes: 3 * MINUTES_PER_DAY,
      createdAtTurn: 0,
      createdTimeMinutes: parseWeekdayTime("Monday, March 17, 07:00"),
      lastSeenTimeMinutes: parseWeekdayTime("Monday, March 17, 07:00"),
      fired: false,
    };
    StateModule.state.directorNotes.push(note);
    StateModule.state.turnCount = 1;
    StateModule.state.worldState.time = "Monday, March 17, 07:30";
    advanceDirectorNotes(); // clock 07:30
    StateModule.state.worldState.time = "Monday, March 17, 08:00";
    advanceDirectorNotes(); // clock 08:00 — cumulative elapsed should be 60
    expect(getNoteElapsedMinutes(note)).toBe(60);
  });

  it("counts elapsed across months from the calendar date", () => {
    const note: DirectorNote = {
      id: "clock5",
      text: "In 40 days.",
      deadlineMinutes: 40 * MINUTES_PER_DAY,
      createdAtTurn: 0,
      createdTimeMinutes: parseWeekdayTime("Monday, March 17, 07:00"),
      lastSeenTimeMinutes: parseWeekdayTime("Monday, March 17, 07:00"),
      fired: false,
    };
    StateModule.state.directorNotes.push(note);
    StateModule.state.turnCount = 1;
    // A month of story passes: March 17 -> April 21 is 35 days.
    StateModule.state.worldState.time = "Monday, April 21, 07:00";
    advanceDirectorNotes();
    expect(getNoteElapsedMinutes(note)).toBe(35 * MINUTES_PER_DAY);
    // Not yet 40 days — the deadline has not fired.
    expect(note.fired).toBe(false);
  });

  it("keeps counting across a year wrap (December -> January)", () => {
    const note: DirectorNote = {
      id: "clock6",
      text: "In 5 days.",
      deadlineMinutes: 5 * MINUTES_PER_DAY,
      createdAtTurn: 0,
      createdTimeMinutes: parseWeekdayTime("Monday, December 29, 07:00"),
      lastSeenTimeMinutes: parseWeekdayTime("Monday, December 29, 07:00"),
      fired: false,
    };
    StateModule.state.directorNotes.push(note);
    StateModule.state.turnCount = 1;
    // The new year begins: Dec 29 -> Jan 2 is 4 days (year cycle wraps).
    StateModule.state.worldState.time = "Friday, January 2, 07:00";
    advanceDirectorNotes();
    expect(getNoteElapsedMinutes(note)).toBe(4 * MINUTES_PER_DAY);
    expect(note.fired).toBe(false);
  });

  it("keeps counting past a weekday-clock wrap (Sunday -> Monday)", () => {
    const note: DirectorNote = {
      id: "clock4",
      text: "In 8 days.",
      deadlineMinutes: 8 * MINUTES_PER_DAY,
      createdAtTurn: 0,
      createdTimeMinutes: parseWeekdayTime("Monday, 07:00 AM"),
      lastSeenTimeMinutes: parseWeekdayTime("Monday, 07:00 AM"),
      fired: false,
    };
    StateModule.state.directorNotes.push(note);
    StateModule.state.turnCount = 1;
    StateModule.state.worldState.time = "Sunday, 07:00 AM";
    advanceDirectorNotes(); // 6 days in
    StateModule.state.worldState.time = "Monday, 07:00 AM"; // wrapped into next week
    advanceDirectorNotes();
    expect(getNoteElapsedMinutes(note)).toBe(7 * MINUTES_PER_DAY);
  });
});

// ===========================================================================
// Prompt injection
// ===========================================================================

describe("buildSystemPrompt injection", () => {
  beforeEach(resetState);

  it("shows a countdown for upcoming timed notes", () => {
    GameEngine.addDirectorNote("The realm opens in 2 days.");
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("(in 2d)");
    expect(prompt).toContain("The realm opens in 2 days.");
  });

  it("shows [NOW ACTIVE] for a fired event", () => {
    const note: DirectorNote = {
      id: "test",
      text: "The Azura Song concert is happening.",
      deadlineMinutes: 0, // already due
      createdAtTurn: 0,
      fired: true,
      firedAtTurn: 1,
    };
    StateModule.state.directorNotes.push(note);
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("[NOW ACTIVE]");
    expect(prompt).toContain("The Azura Song concert is happening.");
    expect(prompt).toContain("happening NOW");
  });

  it("rewords a fired note's stale deadline text to NOW in the prompt", () => {
    const note: DirectorNote = {
      id: "test",
      text: "The realm opens in 2 days.",
      deadlineMinutes: 2 * MINUTES_PER_DAY,
      createdAtTurn: 0,
      fired: true,
      firedAtTurn: 1,
    };
    StateModule.state.directorNotes.push(note);
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("[NOW ACTIVE] The realm opens NOW.");
    expect(prompt).not.toContain("The realm opens in 2 days.");
  });

  it("shows plain text for open-ended notes", () => {
    GameEngine.addDirectorNote("A noble declares a tournament.");
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("- A noble declares a tournament.");
    expect(prompt).not.toContain("(in ");
    expect(prompt).not.toContain("- [NOW ACTIVE]");
  });

  it("includes the immersive instruction text", () => {
    GameEngine.addDirectorNote("An event.");
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("TRUE in-world fact");
    expect(prompt).toContain("no fourth-wall breaks");
  });

  it("omits the section entirely when no notes exist", () => {
    expect(buildSystemPrompt()).not.toContain("DIRECTOR'S NOTES");
  });
});

// ===========================================================================
// Per-turn delivery to the AI
// ===========================================================================

describe("per-turn delivery to the AI", () => {
  beforeEach(resetState);

  it("sends notes inside the system prompt on every interaction", async () => {
    GameEngine.addDirectorNote("The realm opens in 2 days.");
    mockGenerateResponse.mockResolvedValue("Thunder rolls.");

    await GameEngine.executeTurn("I look up.", false);

    expect(mockGenerateResponse).toHaveBeenCalledTimes(1);
    const [sysPrompt] = mockGenerateResponse.mock.calls[0];
    expect(sysPrompt).toContain("DIRECTOR'S NOTES");
    expect(sysPrompt).toContain("The realm opens in 2 days.");
  });

  it("removed notes no longer reach the AI", async () => {
    GameEngine.addDirectorNote("Will be removed.");
    GameEngine.removeDirectorNote(0);
    mockGenerateResponse.mockResolvedValue("Silence.");

    await GameEngine.executeTurn("I wait.", false);

    const [sysPrompt] = mockGenerateResponse.mock.calls[0];
    expect(sysPrompt).not.toContain("Will be removed.");
  });

  it("fires a due note during the turn and surfaces it in the prompt", async () => {
    // Create a note already due (deadline 0).
    const note: DirectorNote = {
      id: "test_fire_turn",
      text: "The band is playing now!",
      deadlineMinutes: 0,
      createdAtTurn: 0,
      fired: false,
    };
    StateModule.state.directorNotes.push(note);
    // Be careful: executeTurn will increment turnCount (0→1) and call
    // advanceDirectorNotes, which fires the note if deadlineMinutes(0) is met.
    mockGenerateResponse.mockResolvedValue("The crowd roars.");
    await GameEngine.executeTurn("I listen.", false);

    const [sysPrompt] = mockGenerateResponse.mock.calls[0];
    expect(sysPrompt).toContain("[NOW ACTIVE]");
    expect(sysPrompt).toContain("The band is playing now!");
  });

  it("fires a note exactly when the AI's post-turn clock crosses its deadline across multiple turns", async () => {
    // Author injects a 2-day deadline while the world clock reads
    // Monday, March 17, 07:00 (24h calendar format).
    GameEngine.addDirectorNote("The festival begins in 2 days.");
    const notes = StateModule.state.directorNotes as DirectorNote[];
    expect(notes.length).toBe(1);
    expect(notes[0].deadlineMinutes).toBe(2 * MINUTES_PER_DAY);
    expect(StateModule.state.worldState.time).toBe("Monday, March 17, 07:00");

    // The AI fast-forwards the game clock by 12 hours per turn through its
    // [STATE_UPDATE] blocks. The 4th turn lands exactly ON the deadline
    // (Wednesday, March 19, 07:00 = 2 in-game days after creation).
    const clock = [
      "Monday, March 17, 19:00",
      "Tuesday, March 18, 07:00",
      "Tuesday, March 18, 19:00",
      "Wednesday, March 19, 07:00",
      "Wednesday, March 19, 19:00",
    ];
    const narrative = (time: string) =>
      `The road stretches ahead. [STATE_UPDATE]{"time": "${time}"}[/STATE_UPDATE]`;
    mockGenerateResponse.mockImplementation(() =>
      Promise.resolve(narrative(clock.shift() as string)),
    );

    // Turns 1-4: the deadline has not been crossed yet, so the note stays
    // unfired and the AI only sees a shrinking countdown.
    for (let i = 1; i <= 4; i++) {
      await GameEngine.executeTurn(`Turn ${i}.`, false);
      expect(notes[0].fired, `note must not fire on turn ${i}`).toBe(false);
      expect(StateModule.state.turnCount).toBe(i);
    }
    // Turn 4's response moved the post-turn clock to exactly the deadline.
    expect(StateModule.state.worldState.time).toBe("Wednesday, March 19, 07:00");
    expect(mockGenerateResponse.mock.calls[0][0]).toContain("(in 2d)");
    expect(mockGenerateResponse.mock.calls[3][0]).toContain("(in 12h)");
    expect(mockGenerateResponse.mock.calls[3][0]).toContain("The festival begins in 2 days.");
    // Note: the section header always mentions "[NOW ACTIVE]" as an example,
    // so assert on the fired-note bullet specifically.
    expect(mockGenerateResponse.mock.calls[3][0]).not.toContain("- [NOW ACTIVE]");

    // Turn 5: the first firing check after the post-turn clock crossed the
    // deadline — the note fires at the START of the turn and the AI is told
    // it is NOW ACTIVE, with the stale "in 2 days" phrasing reworded.
    await GameEngine.executeTurn("Turn 5.", false);
    expect(notes[0].fired).toBe(true);
    expect(notes[0].firedAtTurn).toBe(5);
    const turn5Prompt = mockGenerateResponse.mock.calls[4][0] as string;
    expect(turn5Prompt).toContain("[NOW ACTIVE] The festival begins NOW.");
    expect(turn5Prompt).not.toContain("The festival begins in 2 days.");
    expect(turn5Prompt).not.toContain("(in 2d)");
  });
});

// ===========================================================================
// UI countdown chips (rendered above the input, re-rendered by the engine
// every turn through LoreModule.extract -> UIManager.renderAllSidebars)
// ===========================================================================

describe("UI countdown chips through a multi-turn run", () => {
  beforeEach(() => {
    resetState();
    testElements.set("director-notes-list", { innerHTML: "" });
  });
  afterEach(() => {
    testElements.delete("director-notes-list");
  });

  it("shows a shrinking countdown, then switches to the reworded NOW state", async () => {
    const list = testElements.get("director-notes-list") as { innerHTML: string };
    GameEngine.addDirectorNote("The festival begins in 2 days.");
    expect(list.innerHTML).toContain("· 2d"); // created with 2 days on the clock

    // The AI fast-forwards the game clock by 12 hours per turn through its
    // [STATE_UPDATE] blocks, exactly like the prompt-level E2E test. Each
    // turn the engine re-renders the chips, so we only READ the DOM — the
    // countdown must shrink on its own.
    const clock = [
      "Monday, March 17, 19:00",
      "Tuesday, March 18, 07:00",
      "Tuesday, March 18, 19:00",
      "Wednesday, March 19, 07:00",
      "Wednesday, March 19, 19:00",
    ];
    const narrative = (time: string) =>
      `The road stretches ahead. [STATE_UPDATE]{"time": "${time}"}[/STATE_UPDATE]`;
    mockGenerateResponse.mockImplementation(() =>
      Promise.resolve(narrative(clock.shift() as string)),
    );

    // Turns 1-4: still counting down — the chip's remaining-time suffix
    // shrinks each turn while the note text stays unfired (amber styling).
    await GameEngine.executeTurn("Turn 1.", false);
    expect(list.innerHTML).toContain("The festival begins in 2 days.");
    expect(list.innerHTML).toContain("· 2d");
    expect(list.innerHTML).toContain("bg-amber-950/40");

    await GameEngine.executeTurn("Turn 2.", false);
    expect(list.innerHTML).toContain("· 1d");

    await GameEngine.executeTurn("Turn 3.", false);
    expect(list.innerHTML).toContain("· 12h");

    await GameEngine.executeTurn("Turn 4.", false);
    // The post-turn clock landed exactly on the deadline, but firing is only
    // checked at the start of a turn, so the chip still shows a 0m countdown.
    expect(list.innerHTML).toContain("· 0m");
    expect(list.innerHTML).not.toContain("bg-emerald-950/40");

    // Turn 5: the first firing check after the clock crossed the deadline —
    // the chip flips to the fired state: emerald styling, stale "in 2 days"
    // phrasing reworded to "NOW", and no countdown suffix.
    await GameEngine.executeTurn("Turn 5.", false);
    expect(list.innerHTML).toContain("The festival begins NOW.");
    expect(list.innerHTML).not.toContain("The festival begins in 2 days.");
    expect(list.innerHTML).not.toContain("· ");
    expect(list.innerHTML).toContain("bg-emerald-950/40");
    expect(list.innerHTML).not.toContain("bg-amber-950/40");
    // The "NOW" badge span only appears when there is nothing to reword;
    // here the phrasing was rewritten, so the badge must stay hidden.
    expect(list.innerHTML).not.toContain(">NOW</span>");
  });
});

// ===========================================================================
// Fired-note chat log entry — "⏰ EVENT NOW" lands in the chat stream on the
// exact turn the note fires (turn.ts appends it as a director bubble).
// ===========================================================================

describe("fired-note chat log entry", () => {
  let chatMessages: string[];

  beforeEach(() => {
    resetState();
    chatMessages = [];
    // Register the chat container so UIManager.appendChat runs for real and
    // we can capture every bubble appended to the stream.
    testElements.set("story-container", {
      innerHTML: "",
      appendChild: (child: { innerHTML: string }) => {
        chatMessages.push(child.innerHTML);
      },
    });
  });
  afterEach(() => {
    testElements.delete("story-container");
  });

  const eventNowEntries = () => chatMessages.filter((m) => m.includes("⏰ EVENT NOW"));

  it("appears in the chat stream on the exact turn the note fires", async () => {
    GameEngine.addDirectorNote("The festival begins in 2 days.");

    // Same fast-forward clock as the prompt/chip E2E tests: +12h per turn.
    const clock = [
      "Monday, March 17, 19:00",
      "Tuesday, March 18, 07:00",
      "Tuesday, March 18, 19:00",
      "Wednesday, March 19, 07:00",
      "Wednesday, March 19, 19:00",
      "Thursday, March 20, 07:00",
    ];
    const narrative = (time: string) =>
      `The road stretches ahead. [STATE_UPDATE]{"time": "${time}"}[/STATE_UPDATE]`;
    mockGenerateResponse.mockImplementation(() =>
      Promise.resolve(narrative(clock.shift() as string)),
    );

    // Turns 1-4: the deadline has not been crossed — the stream must stay
    // free of EVENT NOW entries (the note bubble from addDirectorNote has no
    // such prefix).
    for (let i = 1; i <= 4; i++) {
      await GameEngine.executeTurn(`Turn ${i}.`, false);
      expect(eventNowEntries().length, `no EVENT NOW on turn ${i}`).toBe(0);
    }

    // Turn 5: first firing check after the post-turn clock crossed the
    // deadline — exactly one reworded EVENT NOW bubble is appended.
    await GameEngine.executeTurn("Turn 5.", false);
    const notes = StateModule.state.directorNotes as DirectorNote[];
    expect(notes[0].fired).toBe(true);
    expect(notes[0].firedAtTurn).toBe(5);
    expect(eventNowEntries().length).toBe(1);
    expect(eventNowEntries()[0]).toContain("⏰ EVENT NOW: The festival begins NOW.");
    expect(eventNowEntries()[0]).not.toContain("in 2 days");

    // Turn 6: already fired — the log entry must not repeat.
    await GameEngine.executeTurn("Turn 6.", false);
    expect(eventNowEntries().length).toBe(1);
  });
});
describe("rewordDirectiveNote", () => {
  it("rewords a registration directive into a neutral in-world mention", () => {
    const note: DirectorNote = {
      id: "dn_1",
      text: "Add librarian Elle to relationship and NPC list",
      createdAtTurn: 0,
      fired: false,
      directive: { name: "Elle", disposition: "librarian" },
    };
    expect(rewordDirectiveNote(note)).toBe("Elle, the librarian.");
  });

  it("falls back to the name alone when there is no role", () => {
    const note: DirectorNote = {
      id: "dn_2",
      text: "Add mother in list",
      createdAtTurn: 0,
      fired: false,
      directive: { name: "Mother" },
    };
    expect(rewordDirectiveNote(note)).toBe("Mother.");
  });

  it("rewords a fact-correction directive into the corrected attribution", () => {
    const note: DirectorNote = {
      id: "dn_fix",
      text: "that fact was about my Dad, not the neighbor",
      createdAtTurn: 0,
      fired: false,
      factFix: { oldPhrase: "the neighbor", newName: "Father" },
    };
    expect(rewordDirectiveNote(note)).toBe(
      "Correction: the earlier fact mentioning the neighbor actually concerns Father.",
    );
  });

  it("rewords a naming directive into a natural in-world mention", () => {
    const note: DirectorNote = {
      id: "dn_name",
      text: "the mother's name is Diane",
      createdAtTurn: 0,
      fired: false,
      naming: { name: "Diane", role: "Mother" },
    };
    expect(rewordDirectiveNote(note)).toBe("The MC's mother is called Diane.");
  });

  it("returns the original text when the note is not a directive", () => {
    const note: DirectorNote = {
      id: "dn_3",
      text: "The town festival starts in 2 days.",
      createdAtTurn: 0,
      fired: false,
    };
    expect(rewordDirectiveNote(note)).toBe("The town festival starts in 2 days.");
  });
});
