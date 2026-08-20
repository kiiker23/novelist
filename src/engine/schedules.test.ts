// =============================================================================
// schedules.test.ts — Logical schedule awareness module tests.
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";

// Minimal document + localStorage stubs (UIManager / StorageModule no-ops).
(globalThis as any).document = {
  getElementById: () => null,
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

import { StateModule } from "../state/state";
import {
  getDayPhase,
  inferVocation,
  expectedState,
  buildScheduleContext,
} from "./schedules";
import { seedFamilyRelations, clearFamilyAnchoringChoices } from "./family";

function resetState(): void {
  clearFamilyAnchoringChoices();
  const s = StateModule.state;
  s.worldState.time = "Monday, March 17, 07:00";
  s.worldState.location = "Starting Location";
  s.memory = { facts: [], relations: [] };
  s.npcProfiles = [];
  s.history = [];
}

describe("getDayPhase", () => {
  it("classifies hours into the right phases", () => {
    expect(getDayPhase(0).phase).toBe("deep_night");
    expect(getDayPhase(4).phase).toBe("deep_night");
    expect(getDayPhase(5).phase).toBe("early_morning");
    expect(getDayPhase(6).phase).toBe("early_morning");
    expect(getDayPhase(7).phase).toBe("morning");
    expect(getDayPhase(9).phase).toBe("school_day");
    expect(getDayPhase(12.5).phase).toBe("midday");
    expect(getDayPhase(14).phase).toBe("work_afternoon");
    expect(getDayPhase(16).phase).toBe("after_school");
    expect(getDayPhase(19).phase).toBe("evening");
    expect(getDayPhase(23).phase).toBe("night");
  });

  it("the deep-night pulse says the world is asleep", () => {
    expect(getDayPhase(4).worldPulse).toMatch(/asleep/i);
  });

  it("the early-morning pulse anchors school/work start times", () => {
    const pulse = getDayPhase(5.5).worldPulse;
    expect(pulse).toContain("08:00–08:30");
    expect(pulse).toContain("09:00");
  });
});

describe("inferVocation", () => {
  it("recognizes students, teachers, workers, bartenders, and elderly", () => {
    expect(inferVocation("MC's younger sister", "Lin Mei")).toBe("student");
    expect(inferVocation("goes to school", "")).toBe("student");
    expect(inferVocation("MC's mother (works at the diner)", "")).toBe("worker");
    expect(inferVocation("night-shift worker", "")).toBe("worker");
    expect(inferVocation("", "Teacher Mara")).toBe("teacher");
    expect(inferVocation("bartender at the Silver Fox", "")).toBe("bartender");
    expect(inferVocation("MC's grandmother", "")).toBe("elderly");
    expect(inferVocation("MC's mother", "")).toBe("household");
  });
});

describe("expectedState", () => {
  it("the whole household is asleep at 04:00 — no matter the vocation", () => {
    for (const v of ["student", "worker", "teacher", "elderly", "household"] as const) {
      expect(expectedState(v, 4)).toContain("asleep");
    }
  });

  it("a student is at school during the school day, not before dawn", () => {
    expect(expectedState("student", 5)).toContain("asleep");
    expect(expectedState("student", 9)).toBe("at school");
    expect(expectedState("student", 16)).toBe("home from school");
  });

  it("a working parent is at work 09:00–17:00 and asleep at 04:00", () => {
    expect(expectedState("worker", 4)).toContain("asleep");
    expect(expectedState("worker", 12)).toBe("at work");
    expect(expectedState("worker", 23)).toContain("asleep");
  });

  it("a bartender works the night, not the day", () => {
    expect(expectedState("bartender", 22)).toBe("at work (the bar)");
    expect(expectedState("bartender", 9)).toContain("asleep");
  });
});

describe("buildScheduleContext", () => {
  beforeEach(resetState);

  it("returns empty when the clock is unparseable", () => {
    StateModule.state.worldState.time = "somewhere";
    expect(buildScheduleContext()).toBe("");
  });

  it("says the household is asleep at 04:00, with the world pulse", () => {
    StateModule.state.worldState.time = "Monday, March 17, 04:00";
    seedFamilyRelations(
      "The MC lives with his mother and younger sister in a small apartment.",
    );
    const block = buildScheduleContext();
    expect(block).toContain("SCHEDULE CONTEXT");
    expect(block).toContain("deep night");
    expect(block).toContain("The world is asleep");
    expect(block).toContain("asleep at home");
    // Gently — defaults, not facts.
    expect(block).toContain("logical defaults, not facts");
    expect(block).toContain("follow the story");
  });

  it("places a student at school and a working mother at work at 09:00", () => {
    StateModule.state.worldState.time = "Monday, March 17, 09:00";
    // The work detail lives in the relation disposition (as the AI records it
    // via [RELATION]); the schedule inference reads it from there.
    StateModule.state.memory.relations = [
      {
        name: "Mother",
        aliases: ["Mom"],
        disposition: "MC's mother, works at the diner",
        status: "Alive",
        modifiers: [],
      },
      {
        name: "Younger Sister",
        aliases: ["Sis"],
        disposition: "MC's younger sister",
        status: "Alive",
        modifiers: [],
      },
    ];
    const block = buildScheduleContext();
    expect(block).toContain("at school");
    expect(block).toContain("at work");
    expect(block).toContain("school runs roughly 08:30–15:30");
  });

  it("works without any registered household (world pulse only)", () => {
    StateModule.state.worldState.time = "Monday, March 17, 04:00";
    const block = buildScheduleContext();
    expect(block).toContain("The world is asleep");
    expect(block).not.toContain("Household expectations");
  });
});
