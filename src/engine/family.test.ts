import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateModule } from "../state/state";
import {
  detectFamilyFromBackstory,
  seedFamilyRelations,
  detectRelationDirective,
  detectFactReassignmentDirective,
  applyFactReassignment,
  detectNamingDirective,
  isFamilyRelation,
  deceasedFamilyFacts,
  getRememberedFamilyAnchoring,
  rememberFamilyAnchoring,
  getDetectedFamily,
  clearFamilyAnchoringChoices,
} from "./family";
import { LoreModule } from "./lore";

/** Minimal state reset mirroring pipelines.test.ts conventions. */
function resetState(): void {
  const s = StateModule.state;
  s.initialized = false;
  s.char.appearance = "";
  s.char.name = "Unnamed Protagonist";
  s.toggles = {
    mcInfo: true,
    statChecks: true,
    health: true,
    subskills: true,
    time: true,
    memory: true,
    quests: true,
    equipment: true,
    economy: true,
    xp: true,
    npcDepth: true,
    descriptiveScenes: true,
    schedules: true,
  };
  s.memory = { facts: [], relations: [] };
  s.npcProfiles = [];
  s.history = [];
  s.directorNotes = [];
  s.worldState = { time: "Monday, March 17, 07:00", location: "Starting Location", measurement: "Metric" };
}

describe("detectFamilyFromBackstory", () => {
  beforeEach(() => {
    resetState();
  });

  it("registers a mother and younger sister from a plain backstory", () => {
    const rels = detectFamilyFromBackstory(
      "Lin Hao lives in a small apartment with his mother, who works double shifts at the diner, and his younger sister.",
    );
    const names = rels.map((r) => r.name).sort();
    expect(names).toEqual(["Mother", "Younger Sister"]);
    expect(rels.find((r) => r.name === "Mother")?.status).toBe("Alive");
    expect(rels.find((r) => r.name === "Younger Sister")?.disposition).toContain("younger sister");
  });

  it("marks a family member Deceased when the backstory says they died", () => {
    const rels = detectFamilyFromBackstory(
      "His mother died when he was young, so his father raised him alone.",
    );
    const mother = rels.find((r) => r.name === "Mother");
    expect(mother?.status).toBe("Deceased");
    expect(mother?.disposition).toContain("deceased");
    expect(rels.find((r) => r.name === "Father")?.status).toBe("Alive");
  });

  it("does NOT fabricate family the backstory excludes (absent father)", () => {
    const rels = detectFamilyFromBackstory("He grew up without a father, raised by his grandmother.");
    expect(rels.map((r) => r.name)).not.toContain("Father");
    expect(rels.map((r) => r.name)).toContain("Grandmother");
  });

  it("skips parental roles for orphans but keeps siblings", () => {
    const rels = detectFamilyFromBackstory(
      "Orphaned at birth, he was raised in an orphanage alongside his younger sister.",
    );
    const names = rels.map((r) => r.name);
    expect(names).not.toContain("Mother");
    expect(names).not.toContain("Father");
    expect(names).toContain("Younger Sister");
  });

  it("dedupes repeated mentions and prefers the specific role", () => {
    const rels = detectFamilyFromBackstory(
      "His younger sister is in middle school. His sister loves basketball. His younger sister is loud.",
    );
    const names = rels.map((r) => r.name);
    expect(names.filter((n) => n === "Younger Sister")).toHaveLength(1);
    expect(names).not.toContain("Sister"); // covered by the more specific span
  });

  it("returns nothing for empty or family-free text", () => {
    expect(detectFamilyFromBackstory("")).toEqual([]);
    expect(detectFamilyFromBackstory("A quiet cultivator seeking enlightenment.")).toEqual([]);
  });

  it("captures a proper name right after the role ('his mother Diane')", () => {
    const rels = detectFamilyFromBackstory("Lin Hao lives with his mother Diane and his younger sister Lily.");
    const mother = rels.find((r) => r.name === "Diane");
    expect(mother?.disposition).toBe("MC's mother");
    expect(mother?.aliases).toEqual(["Mother", "Mom", "Mum", "Mama"]);
    const sister = rels.find((r) => r.name === "Lily");
    expect(sister?.disposition).toBe("MC's younger sister");
    expect(sister?.aliases).toEqual(["Younger Sister", "Sis"]);
  });

  it("seeds casual synonym aliases alongside each role so casual AI updates merge", () => {
    const rels = detectFamilyFromBackstory(
      "Lin Hao lives with his mother, father, grandmother and younger sister.",
    );
    const byName = (n: string) => rels.find((r) => r.name === n);
    // Role-titled entries get the everyday aliases (no self-alias).
    expect(byName("Mother")?.aliases).toEqual(["Mom", "Mum", "Mama"]);
    expect(byName("Father")?.aliases).toEqual(["Dad", "Papa"]);
    expect(byName("Grandmother")?.aliases).toEqual(["Grandma", "Granny", "Nana"]);
    expect(byName("Younger Sister")?.aliases).toEqual(["Sis"]);
    // A captured name keeps the role title AND the synonyms.
    const rels2 = detectFamilyFromBackstory(
      "Lin Hao lives with his mother Diane and his younger sister Lily.",
    );
    expect(rels2.find((r) => r.name === "Diane")?.aliases).toEqual([
      "Mother",
      "Mom",
      "Mum",
      "Mama",
    ]);
  });

  it("adds casual synonyms to older saves on re-seed without duplicating or clobbering", () => {
    // Simulate an older save: a role-titled entry with NO aliases.
    StateModule.state.memory.relations.push({
      name: "Mother",
      aliases: [],
      disposition: "Diner waitress, works double shifts",
      status: "Alive",
      modifiers: [],
    });
    const added = seedFamilyRelations("He lives with his mother in a cramped apartment.");
    expect(added).toBe(0); // nothing new registered
    const mother = StateModule.state.memory.relations[0];
    expect(mother.aliases).toEqual(["Mom", "Mum", "Mama"]);
    expect(mother.disposition).toBe("Diner waitress, works double shifts"); // untouched
    // Re-seeding again is fully idempotent — no duplicates.
    seedFamilyRelations("He lives with his mother in a cramped apartment.");
    expect(mother.aliases).toEqual(["Mom", "Mum", "Mama"]);
  });

  it("captures names after commas, parens, and 'named' connectors", () => {
    expect(
      detectFamilyFromBackstory("His mother, Mary, was a nurse.")[0].name,
    ).toBe("Mary");
    expect(
      detectFamilyFromBackstory("His mother (Sarah) works at the diner.")[0].name,
    ).toBe("Sarah");
    expect(
      detectFamilyFromBackstory("His mother named June is a seamstress.")[0].name,
    ).toBe("June");
  });

  it("does NOT capture capitalized non-names after the role", () => {
    // "Diner" / "May" / "Spoke" are capitalized but are not names — a
    // lowercase word between the role and the capital blocks the capture.
    expect(
      detectFamilyFromBackstory("His mother worked at the Diner every day.")[0].name,
    ).toBe("Mother");
    expect(
      detectFamilyFromBackstory("His mother was born in May.")[0].name,
    ).toBe("Mother");
    expect(
      detectFamilyFromBackstory("His mother spoke softly.")[0].name,
    ).toBe("Mother");
  });

  it("infers a Deceased Father from 'widowed mother'", () => {
    const rels = detectFamilyFromBackstory(
      "Lives with his widowed mother and younger sister in a small town.",
    );
    const father = rels.find((r) => r.name === "Father");
    expect(father?.status).toBe("Deceased");
    expect(father?.disposition).toContain("deceased");
    // The mother herself is alive — she's the widow.
    expect(rels.find((r) => r.name === "Mother")?.status).toBe("Alive");
  });

  it("infers a Deceased Father from 'mother is a widow' phrasings", () => {
    for (const text of [
      "His mother is a widow.",
      "His mother is widowed.",
      "His mother, a widow, works double shifts at the diner.",
    ]) {
      const father = detectFamilyFromBackstory(text).find((r) => r.name === "Father");
      expect(father?.status, text).toBe("Deceased");
    }
  });

  it("infers a Deceased Mother from a widowed father / widower", () => {
    const rels = detectFamilyFromBackstory("His widowed father raised him alone.");
    expect(rels.find((r) => r.name === "Mother")?.status).toBe("Deceased");
    expect(rels.find((r) => r.name === "Father")?.status).toBe("Alive");
    expect(
      detectFamilyFromBackstory("His father is a widower.").find((r) => r.name === "Mother")?.status,
    ).toBe("Deceased");
  });

  it("does NOT infer a dead parent when the widow belongs to someone else", () => {
    // The aunt is the widow — the MC's father is untouched.
    const rels = detectFamilyFromBackstory("His mother lives with her widowed aunt.");
    expect(rels.map((r) => r.name)).not.toContain("Father");
  });

  it("does NOT override an explicitly-mentioned father", () => {
    const rels = detectFamilyFromBackstory(
      "His mother is a widow, but his father is alive and serves in the army.",
    );
    expect(rels.find((r) => r.name === "Father")?.status).toBe("Alive");
  });
});

describe("seedFamilyRelations", () => {
  beforeEach(() => {
    resetState();
  });

  it("seeds relations AND NPC profiles when NPC depth is on", () => {
    const added = seedFamilyRelations(
      "He lives with his mother and his younger sister in a cramped apartment.",
    );
    expect(added).toBe(2);
    const names = StateModule.state.memory.relations.map((r) => r.name).sort();
    expect(names).toEqual(["Mother", "Younger Sister"]);
    const profileNames = StateModule.state.npcProfiles.map((p) => p.npcName).sort();
    expect(profileNames).toEqual(["Mother", "Younger Sister"]);
  });

  it("is idempotent — a second call adds nothing and never duplicates", () => {
    seedFamilyRelations("He lives with his mother and his younger sister.");
    const again = seedFamilyRelations("He lives with his mother and his younger sister.");
    expect(again).toBe(0);
    expect(StateModule.state.memory.relations).toHaveLength(2);
    expect(StateModule.state.npcProfiles).toHaveLength(2);
  });

  it("never clobbers richer data the AI already recorded", () => {
    StateModule.state.memory.relations.push({
      name: "Mother",
      aliases: [],
      disposition: "Diner waitress, works double shifts",
      status: "Alive",
      modifiers: [],
    });
    const added = seedFamilyRelations("He lives with his mother in a cramped apartment.");
    expect(added).toBe(0);
    expect(StateModule.state.memory.relations[0].disposition).toBe(
      "Diner waitress, works double shifts",
    );
  });

  it("does not seed profiles when NPC depth is off (relations still seed)", () => {
    StateModule.state.toggles.npcDepth = false;
    const added = seedFamilyRelations("He lives with his mother and his younger sister.");
    expect(added).toBe(2);
    expect(StateModule.state.memory.relations).toHaveLength(2);
    expect(StateModule.state.npcProfiles).toHaveLength(0);
  });

  it("anchors Alive family profiles to the MC's home (setup starting location)", () => {
    StateModule.state.setup = {
      genre: "",
      worldSize: "",
      techStage: "",
      rules: "",
      activeGenres: [],
      measurement: "Metric",
      time: "Monday, March 17, 07:00",
      location: "MC Bedroom",
      mcCultivation: 0,
      statEnd: 10,
      statWil: 10,
      statLck: 10,
      statPer: 10,
    };
    seedFamilyRelations(
      "He lives with his mother and his younger sister in a cramped apartment.",
    );
    const profs = StateModule.state.npcProfiles;
    expect(profs.find((p) => p.npcName === "Mother")?.knownLocation).toBe(
      "MC Bedroom",
    );
    expect(profs.find((p) => p.npcName === "Younger Sister")?.knownLocation).toBe(
      "MC Bedroom",
    );
  });

  it("repairs family locations on resume — setup home wins even when the MC is elsewhere", () => {
    // Old save: family profiles exist without knownLocation and the MC has
    // already left home (seedFamilyRelations runs again on resume).
    StateModule.state.setup = {
      genre: "",
      worldSize: "",
      techStage: "",
      rules: "",
      activeGenres: [],
      measurement: "Metric",
      time: "Monday, March 17, 07:00",
      location: "MC Bedroom",
      mcCultivation: 0,
      statEnd: 10,
      statWil: 10,
      statLck: 10,
      statPer: 10,
    };
    StateModule.state.worldState = {
      time: "Monday, March 17, 08:15",
      location: "High School",
      measurement: "Metric",
    };
    StateModule.state.memory.relations.push({
      name: "Mother",
      aliases: ["Mom"],
      disposition: "MC's mother",
      status: "Alive",
      modifiers: [],
    });
    StateModule.state.npcProfiles.push({
      npcName: "Mother",
      traits: [],
      aggressionThreshold: 50,
      jealousyThreshold: 50,
      trust: 50,
      affection: 50,
      schedule: [],
      relationships: [],
      equipment: [],
      autoGenerated: true,
    });
    seedFamilyRelations("He lives with his mother.");
    expect(
      StateModule.state.npcProfiles.find((p) => p.npcName === "Mother")
        ?.knownLocation,
    ).toBe("MC Bedroom");
  });

  it("resume seeding merges onto AI-renamed entries instead of duplicating", () => {
    // A prior turn's [RELATION] renamed the seeded entries (Mother -> Lin Wei)
    // and, in this save, the role title alias was LOST (Lin Wei has no
    // "Mother" alias). Re-seeding on resume must merge onto the canonical
    // entries via the disposition fallback, repair the alias, and never
    // create duplicate "Mother"/"Younger Sister".
    StateModule.state.memory.relations.push(
      {
        name: "Lin Wei",
        aliases: ["Mom", "Mum", "Mama"],
        disposition: "MC's mother",
        status: "Alive",
        modifiers: [],
      },
      {
        name: "Lin Mei",
        aliases: ["Sis"],
        disposition: "MC's younger sister",
        status: "Alive",
        modifiers: [],
      },
    );
    StateModule.state.npcProfiles.push(
      {
        npcName: "Lin Wei",
        traits: [],
        aggressionThreshold: 50,
        jealousyThreshold: 50,
        trust: 52,
        affection: 54,
        schedule: [],
        relationships: [],
        equipment: [],
        autoGenerated: true,
      },
      {
        npcName: "Lin Mei",
        traits: [],
        aggressionThreshold: 50,
        jealousyThreshold: 50,
        trust: 51,
        affection: 53,
        schedule: [],
        relationships: [],
        equipment: [],
        autoGenerated: true,
      },
    );
    const added = seedFamilyRelations(
      "He lives with his mother and his younger sister.",
    );
    expect(added).toBe(0);
    expect(StateModule.state.memory.relations.map((r) => r.name).sort()).toEqual(
      ["Lin Mei", "Lin Wei"],
    );
    expect(StateModule.state.npcProfiles.map((p) => p.npcName).sort()).toEqual(
      ["Lin Mei", "Lin Wei"],
    );
    // The lost role-title aliases are repaired so alias resolution works.
    const wei = StateModule.state.memory.relations.find((r) => r.name === "Lin Wei");
    expect(wei?.aliases.map((a) => a.toLowerCase())).toContain("mother");
    const mei = StateModule.state.memory.relations.find((r) => r.name === "Lin Mei");
    expect(mei?.aliases.map((a) => a.toLowerCase())).toContain("younger sister");
    // The AI's richer stats are never clobbered.
    expect(
      StateModule.state.npcProfiles.find((p) => p.npcName === "Lin Wei")
        ?.affection,
    ).toBe(54);
  });

  it("never anchors a Deceased family member as a home witness", () => {
    StateModule.state.setup = {
      genre: "",
      worldSize: "",
      techStage: "",
      rules: "",
      activeGenres: [],
      measurement: "Metric",
      time: "Monday, March 17, 07:00",
      location: "MC Bedroom",
      mcCultivation: 0,
      statEnd: 10,
      statWil: 10,
      statLck: 10,
      statPer: 10,
    };
    // Widowed mother → Father inferred Deceased.
    seedFamilyRelations(
      "He lives with his widowed mother and his younger sister.",
    );
    const father = StateModule.state.npcProfiles.find(
      (p) => p.npcName === "Father",
    );
    expect(father?.knownLocation).toBeUndefined();
  });

  it("registers a named family member under her real name with the role as alias", () => {
    const added = seedFamilyRelations("He lives with his mother Diane and his younger sister Lily.");
    expect(added).toBe(2);
    const diane = StateModule.state.memory.relations.find((r) => r.name === "Diane");
    expect(diane?.aliases).toEqual(["Mother", "Mom", "Mum", "Mama"]);
    expect(diane?.disposition).toBe("MC's mother");
    const lily = StateModule.state.memory.relations.find((r) => r.name === "Lily");
    expect(lily?.aliases).toEqual(["Younger Sister", "Sis"]);
    expect(StateModule.state.npcProfiles.map((p) => p.npcName).sort()).toEqual([
      "Diane",
      "Lily",
    ]);
  });

  it("upgrades an existing role-titled entry to the captured name instead of duplicating", () => {
    // Simulate an older save: family seeded before name capture existed.
    seedFamilyRelations("He lives with his mother and his younger sister.");
    expect(StateModule.state.memory.relations.map((r) => r.name).sort()).toEqual([
      "Mother",
      "Younger Sister",
    ]);
    expect(StateModule.state.npcProfiles.map((p) => p.npcName).sort()).toEqual([
      "Mother",
      "Younger Sister",
    ]);

    // The backstory gains names (user edited it) — re-seed upgrades in place.
    const changed = seedFamilyRelations("He lives with his mother Diane and his younger sister Lily.");
    expect(changed).toBe(2);
    expect(StateModule.state.memory.relations.map((r) => r.name).sort()).toEqual([
      "Diane",
      "Lily",
    ]);
    expect(
      StateModule.state.memory.relations.find((r) => r.name === "Diane")?.aliases,
    ).toEqual(["Mom", "Mum", "Mama", "Mother"]);
    expect(StateModule.state.npcProfiles.map((p) => p.npcName).sort()).toEqual([
      "Diane",
      "Lily",
    ]);
  });

  it("seeds a Deceased Father profile when the mother is widowed", () => {
    const added = seedFamilyRelations("Lives with his widowed mother in a small town.");
    expect(added).toBe(2); // Mother (alive) + Father (inferred deceased)
    const father = StateModule.state.memory.relations.find((r) => r.name === "Father");
    expect(father?.status).toBe("Deceased");
    expect(StateModule.state.npcProfiles.map((p) => p.npcName).sort()).toEqual([
      "Father",
      "Mother",
    ]);
    // The passing is also recorded as a Family fact for narrative context.
    const family = StateModule.state.memory.facts.find((b) => b.title === "Family");
    expect(family?.entries).toContain("Father passed away years ago.");
  });

  it("records the deceased fact idempotently — re-seeding never duplicates it", () => {
    seedFamilyRelations("Lives with his widowed mother.");
    seedFamilyRelations("Lives with his widowed mother.");
    const family = StateModule.state.memory.facts.find((b) => b.title === "Family");
    expect(family?.entries).toEqual(["Father passed away years ago."]);
  });

  it("adds no Family fact bundle when nobody is deceased", () => {
    seedFamilyRelations("He lives with his mother and younger sister.");
    expect(StateModule.state.memory.facts.some((b) => b.title === "Family")).toBe(false);
  });

  it("never clobbers richer data during a role-title upgrade", () => {
    StateModule.state.memory.relations.push({
      name: "Mother",
      aliases: [],
      disposition: "Diner waitress, works double shifts",
      status: "Alive",
      modifiers: [],
    });
    seedFamilyRelations("He lives with his mother Diane.");
    const diane = StateModule.state.memory.relations.find((r) => r.name === "Diane");
    expect(diane?.disposition).toBe("Diner waitress, works double shifts");
    // The role title and casual synonyms are aliased; the richer disposition
    // the AI recorded survives untouched.
    expect(diane?.aliases).toEqual(["Mother", "Mom", "Mum", "Mama"]);
  });
});

describe("detectRelationDirective", () => {
  beforeEach(() => {
    resetState();
  });

  it("parses 'Add X to relationship and NPC list' notes", () => {
    expect(detectRelationDirective("Add librarian Elle to relationship and NPC list")).toEqual({
      name: "Elle",
      disposition: "librarian",
    });
  });

  it("parses 'Add mother in list'", () => {
    expect(detectRelationDirective("Add mother in list")).toEqual({ name: "Mother" });
  });

  it("resolves a casual family term onto the seeded role-titled entry ('Add my Mom to the NPC list')", () => {
    seedFamilyRelations("He lives with his mother and his younger sister.");
    expect(detectRelationDirective("Add my Mom to the NPC list")).toEqual({
      name: "Mother",
    });
  });

  it("resolves a casual family term onto the seeded named entry ('Add my Mom to the NPC list')", () => {
    seedFamilyRelations("He lives with his mother Diane and his younger sister Lily.");
    expect(detectRelationDirective("Add my Mom to the NPC list")).toEqual({
      name: "Diane",
    });
  });

  it("resolves 'Add my Dad to the NPC list' onto the deceased seeded father", () => {
    seedFamilyRelations("Lives with his widowed mother in a small town.");
    const directive = detectRelationDirective("Add my Dad to the NPC list");
    expect(directive?.name).toBe("Father");
  });

  it("strips possessive noise from a disposition without losing the real role", () => {
    expect(detectRelationDirective("Add my librarian Elle to the NPC list")).toEqual({
      name: "Elle",
      disposition: "librarian",
    });
  });

  it("parses 'Create NPC Sarah, a blacksmith'", () => {
    const u = detectRelationDirective("Create NPC Sarah, a blacksmith");
    expect(u?.name).toBe("Sarah");
  });

  it("parses 'relationship: Name - disposition'", () => {
    expect(detectRelationDirective("relationship: Bob - friendly guard")).toEqual({
      name: "Bob",
      disposition: "friendly guard",
    });
  });

  it("parses an explicit [RELATION] JSON block", () => {
    expect(
      detectRelationDirective('[RELATION]{"name":"Elle","disposition":"librarian"}[/RELATION]'),
    ).toEqual({ name: "Elle", disposition: "librarian" });
  });

  it("keeps hyphenated names intact", () => {
    const u = detectRelationDirective("relationship: Ann-Marie - doctor");
    expect(u?.name).toBe("Ann-Marie");
  });

  it("returns null for ordinary in-world event notes", () => {
    expect(detectRelationDirective("The town festival starts in 2 days.")).toBeNull();
    expect(detectRelationDirective("A secret realm opens at midnight.")).toBeNull();
    expect(detectRelationDirective("Add a festival to the calendar next month")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(detectRelationDirective("")).toBeNull();
    expect(detectRelationDirective("   ")).toBeNull();
  });
});

describe("deceasedFamilyFacts", () => {
  it("produces a neutral fact for a widow-inferred father", () => {
    expect(deceasedFamilyFacts("Lives with his widowed mother and younger sister.")).toEqual([
      { name: "Father", text: "Father passed away years ago." },
    ]);
  });

  it("uses the backstory's own wording for an explicit death", () => {
    expect(
      deceasedFamilyFacts("His mother died when he was young, so his father raised him alone."),
    ).toEqual([{ name: "Mother", text: "His mother died when he was young." }]);
  });

  it("returns nothing when nobody in the family is deceased", () => {
    expect(deceasedFamilyFacts("He lives with his mother and younger sister.")).toEqual([]);
    expect(deceasedFamilyFacts("")).toEqual([]);
  });

  it("skips parental facts for orphans", () => {
    expect(
      deceasedFamilyFacts("Orphaned at birth, he was raised in an orphanage."),
    ).toEqual([]);
  });
});

describe("isFamilyRelation", () => {
  it("recognizes seeded family by name and disposition", () => {
    expect(
      isFamilyRelation({ name: "Mother", aliases: [], disposition: "MC's mother", status: "Alive", modifiers: [] }),
    ).toBe(true);
    expect(
      isFamilyRelation({ name: "Younger Sister", aliases: [], disposition: "MC's younger sister", status: "Alive", modifiers: [] }),
    ).toBe(true);
    expect(
      isFamilyRelation({ name: "Mother", aliases: [], disposition: "MC's mother (deceased)", status: "Deceased", modifiers: [] }),
    ).toBe(true);
  });

  it("recognizes family registered under role titles by the AI or director notes", () => {
    expect(
      isFamilyRelation({ name: "Mom", aliases: [], disposition: "", status: "Alive", modifiers: [] }),
    ).toBe(true);
    expect(
      isFamilyRelation({ name: "Parents", aliases: [], disposition: "", status: "Alive", modifiers: [] }),
    ).toBe(true);
  });

  it("rejects ordinary NPCs", () => {
    expect(
      isFamilyRelation({ name: "Elle", aliases: [], disposition: "librarian", status: "Alive", modifiers: [] }),
    ).toBe(false);
    expect(
      isFamilyRelation({ name: "Elder Wu", aliases: [], disposition: "Friendly merchant", status: "Alive", modifiers: [] }),
    ).toBe(false);
    // "Johnson" contains \"son\" only as part of a larger word — not a family role.
    expect(
      isFamilyRelation({ name: "Johnson", aliases: [], disposition: "Blacksmith", status: "Alive", modifiers: [] }),
    ).toBe(false);
  });
});

describe("detectFactReassignmentDirective", () => {
  beforeEach(() => {
    resetState();
  });

  it("parses 'that fact was about <NEW>, not <OLD>'", () => {
    expect(detectFactReassignmentDirective("that fact was about my Dad, not the neighbor")).toEqual({
      oldPhrase: "the neighbor",
      newName: "Dad",
    });
    expect(detectFactReassignmentDirective("that fact was about Mom, not the herbalist")).toEqual({
      oldPhrase: "the herbalist",
      newName: "Mom",
    });
    // No comma variant.
    expect(detectFactReassignmentDirective("that fact was about my dad not the neighbor")).toEqual({
      oldPhrase: "the neighbor",
      newName: "Dad",
    });
  });

  it("parses 'the fact about <OLD> was/is/belongs to <NEW>'", () => {
    expect(
      detectFactReassignmentDirective("the fact about the neighbor was actually about my Dad"),
    ).toEqual({ oldPhrase: "the neighbor", newName: "Dad" });
    expect(
      detectFactReassignmentDirective("the fact about the blacksmith belongs to Johnson"),
    ).toEqual({ oldPhrase: "the blacksmith", newName: "Johnson" });
  });

  it("returns null for ordinary notes and relation directives", () => {
    expect(detectFactReassignmentDirective("The town festival starts in 2 days.")).toBeNull();
    expect(detectFactReassignmentDirective("Add librarian Elle to relationship and NPC list")).toBeNull();
    expect(detectFactReassignmentDirective("That fact is important.")).toBeNull();
    expect(detectFactReassignmentDirective("")).toBeNull();
    expect(detectFactReassignmentDirective("   ")).toBeNull();
  });
});

describe("applyFactReassignment", () => {
  beforeEach(() => {
    resetState();
  });

  it("rewrites the wrong person to the canonical family name", () => {
    seedFamilyRelations("Lives with his widowed mother in a small town."); // Mother + Father (deceased)
    StateModule.state.memory.facts.push({ title: "General World Facts", entries: ["The neighbor fixed the fence."] });
    const result = applyFactReassignment({ oldPhrase: "the neighbor", newName: "Dad" });
    expect(result.rewritten).toBe(1);
    expect(result.newName).toBe("Father"); // resolved via alias
    expect(StateModule.state.memory.facts.find((b) => b.title === "General World Facts")!.entries).toEqual(["Father fixed the fence."]);
  });

  it("matches the article-stripped variant and handles possessives", () => {
    seedFamilyRelations("Lives with his widowed mother in a small town.");
    StateModule.state.memory.facts.push({
      title: "General World Facts",
      entries: ["Neighbor's dog barked all night.", "A stranger left a parcel."],
    });
    const result = applyFactReassignment({ oldPhrase: "the neighbor", newName: "Dad" });
    expect(result.rewritten).toBe(1); // only the neighbor entry
    expect(StateModule.state.memory.facts.find((b) => b.title === "General World Facts")!.entries).toEqual([
      "Father's dog barked all night.",
      "A stranger left a parcel.",
    ]);
  });

  it("dedupes entries that collapse onto the same corrected text", () => {
    seedFamilyRelations("Lives with his widowed mother in a small town.");
    StateModule.state.memory.facts.push({
      title: "General World Facts",
      entries: ["The neighbor fixed the fence.", "Father fixed the fence."],
    });
    applyFactReassignment({ oldPhrase: "the neighbor", newName: "Dad" });
    expect(StateModule.state.memory.facts.find((b) => b.title === "General World Facts")!.entries).toEqual(["Father fixed the fence."]);
  });

  it("uses the raw name when the target person is not registered", () => {
    StateModule.state.memory.facts.push({
      title: "General World Facts",
      entries: ["The blacksmith forged a blade."],
    });
    const result = applyFactReassignment({ oldPhrase: "the blacksmith", newName: "Johnson" });
    expect(result.newName).toBe("Johnson");
    expect(StateModule.state.memory.facts.find((b) => b.title === "General World Facts")!.entries).toEqual(["Johnson forged a blade."]);
  });

  it("auto-registers an unregistered target through the relation pipeline", () => {
    StateModule.state.memory.facts.push({
      title: "General World Facts",
      entries: ["The blacksmith forged a blade."],
    });
    const result = applyFactReassignment({ oldPhrase: "the blacksmith", newName: "Johnson" });
    expect(result.registered).toBe(true);
    expect(result.newName).toBe("Johnson");
    // The NPC is registered with a profile (npcDepth is on in resetState).
    expect(StateModule.state.memory.relations.map((r) => r.name)).toContain("Johnson");
    expect(StateModule.state.npcProfiles.map((p) => p.npcName)).toContain("Johnson");
    // And the fact was rewritten to the registered name.
    expect(StateModule.state.memory.facts.find((b) => b.title === "General World Facts")!.entries).toEqual(["Johnson forged a blade."]);
  });

  it("does not duplicate an already-registered target", () => {
    seedFamilyRelations("Lives with his widowed mother in a small town."); // Mother + Father
    const before = StateModule.state.memory.relations.length;
    const result = applyFactReassignment({ oldPhrase: "the neighbor", newName: "Dad" });
    expect(result.registered).toBe(false);
    expect(result.newName).toBe("Father"); // resolved via alias
    expect(StateModule.state.memory.relations).toHaveLength(before); // no new NPC
    expect(StateModule.state.npcProfiles.map((p) => p.npcName)).not.toContain("Dad");
  });

  it("leaves facts untouched when nothing matches", () => {
    StateModule.state.memory.facts.push({
      title: "General World Facts",
      entries: ["The river flooded the valley."],
    });
    const result = applyFactReassignment({ oldPhrase: "the neighbor", newName: "Dad" });
    expect(result.rewritten).toBe(0);
    expect(StateModule.state.memory.facts.find((b) => b.title === "General World Facts")!.entries).toEqual(["The river flooded the valley."]);
  });
});

describe("detectNamingDirective", () => {
  beforeEach(() => {
    resetState();
  });

  it("parses 'the mother's name is <Name>' onto the seeded role-titled entry", () => {
    seedFamilyRelations("He lives with his mother and his younger sister.");
    expect(detectNamingDirective("the mother's name is Diane")).toEqual({
      update: { name: "Diane", aliases: ["Mother"] },
      role: "Mother",
    });
    // Casual phrasing resolves to the same entry.
    expect(detectNamingDirective("my mom's name is Diane")).toEqual({
      update: { name: "Diane", aliases: ["Mother"] },
      role: "Mother",
    });
    expect(detectNamingDirective("the mother is named Diane")).toEqual({
      update: { name: "Diane", aliases: ["Mother"] },
      role: "Mother",
    });
  });

  it("renames the canonical entry when it is already named", () => {
    seedFamilyRelations("He lives with his mother Diane.");
    expect(detectNamingDirective("the mother's name is Lily")).toEqual({
      update: { name: "Lily", aliases: ["Diane"] },
      role: "Mother",
    });
  });

  it("returns null when the name is already correct or the person is ambiguous", () => {
    seedFamilyRelations("He lives with his mother Diane.");
    expect(detectNamingDirective("the mother's name is Diane")).toBeNull();
    expect(detectNamingDirective("her name is Diane")).toBeNull(); // no role
  });

  it("registers an unnamed role under the name when the person is not registered", () => {
    expect(detectNamingDirective("the aunt's name is Meiling")).toEqual({
      update: { name: "Meiling", disposition: "MC's aunt" },
      role: "Aunt",
    });
  });

  it("returns null for ordinary notes", () => {
    expect(detectNamingDirective("The town festival starts in 2 days.")).toBeNull();
    expect(detectNamingDirective("Add librarian Elle to relationship and NPC list")).toBeNull();
    expect(detectNamingDirective("")).toBeNull();
  });

  it("applies the rename through the relation pipeline — name replaces the role everywhere", () => {
    seedFamilyRelations("He lives with his mother and his younger sister.");
    const naming = detectNamingDirective("the mother's name is Diane")!;
    LoreModule.applyRelationUpdate(naming.update);
    const rels = StateModule.state.memory.relations;
    expect(rels).toHaveLength(2); // no duplicate
    expect(rels.some((r) => r.name === "Mother")).toBe(false);
    const diane = rels.find((r) => r.name === "Diane");
    expect(diane?.disposition).toBe("MC's mother");
    expect(diane?.aliases).toContain("Mother"); // old title kept as alias
    expect(StateModule.state.npcProfiles.map((p) => p.npcName)).toContain("Diane");
    expect(StateModule.state.npcProfiles.map((p) => p.npcName)).not.toContain("Mother");
  });
});

describe("family-anchoring decision — remembered choices and detected members", () => {
  const B1 = "Lin Hao lives with his widowed mother Diane and his younger sister Lily.";
  const B2 = "Kael lives with his mother Sera and his younger brother.";

  beforeEach(() => {
    resetState();
    clearFamilyAnchoringChoices();
    // A minimal localStorage so the per-backstory memory can be exercised.
    const backing = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        backing.set(k, String(v));
      },
      removeItem: (k: string) => {
        backing.delete(k);
      },
      clear: () => backing.clear(),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("reports the detected family with names and roles for the dialog", () => {
    const family = getDetectedFamily(B1);
    const names = family.map((r) => r.name);
    expect(names).toContain("Diane");
    expect(names).toContain("Lily");
    const diane = family.find((r) => r.name === "Diane");
    expect(diane?.disposition).toBe("MC's mother");
  });

  it("returns true without asking when the backstory has no family", () => {
    expect(getRememberedFamilyAnchoring("A lone traveler wandering the wastes.")).toBe(true);
    expect(getDetectedFamily("A lone traveler wandering the wastes.")).toEqual([]);
  });

  it("returns null (unanswered) when family is detected but no choice is stored", () => {
    expect(getRememberedFamilyAnchoring(B1)).toBeNull();
  });

  it("remembers keep and clean-slate answers per backstory", () => {
    rememberFamilyAnchoring(B1, true);
    expect(getRememberedFamilyAnchoring(B1)).toBe(true);
    rememberFamilyAnchoring(B1, false);
    expect(getRememberedFamilyAnchoring(B1)).toBe(false);
  });

  it("a different backstory is not affected by another's remembered choice", () => {
    rememberFamilyAnchoring(B1, true);
    expect(getRememberedFamilyAnchoring(B1)).toBe(true);
    expect(getRememberedFamilyAnchoring(B2)).toBeNull();
  });

  it("clearFamilyAnchoringChoices forgets every answer", () => {
    rememberFamilyAnchoring(B1, true);
    rememberFamilyAnchoring(B2, false);
    clearFamilyAnchoringChoices();
    expect(getRememberedFamilyAnchoring(B1)).toBeNull();
    expect(getRememberedFamilyAnchoring(B2)).toBeNull();
  });
});
