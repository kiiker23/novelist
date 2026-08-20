// =============================================================================
// family-names.test.ts — normalizeFamilyReferences (fact -> canonical person)
// =============================================================================

import { describe, expect, it } from "vitest";
import { Relation } from "../state/GameState";
import { normalizeFamilyReferences } from "./family-names";

function rel(partial: Partial<Relation> & { name: string }): Relation {
  return {
    name: partial.name,
    aliases: partial.aliases ?? [],
    disposition: partial.disposition ?? "",
    status: partial.status ?? "Alive",
    modifiers: partial.modifiers ?? [],
  };
}

describe("normalizeFamilyReferences", () => {
  it("resolves a casual synonym to the canonical named relation", () => {
    const relations = [
      rel({ name: "Diane", aliases: ["Mother", "Mom", "Mum", "Mama"], disposition: "MC's mother" }),
      rel({ name: "Lily", aliases: ["Younger Sister", "Sis"], disposition: "MC's younger sister" }),
    ];
    expect(normalizeFamilyReferences("Mom came home late.", relations)).toBe(
      "Diane came home late.",
    );
    expect(normalizeFamilyReferences("Sis is doing homework.", relations)).toBe(
      "Lily is doing homework.",
    );
  });

  it("is case-insensitive and handles possessives", () => {
    const relations = [rel({ name: "Diane", aliases: ["Mother", "Mom"], disposition: "MC's mother" })];
    expect(normalizeFamilyReferences("MOM is exhausted.", relations)).toBe(
      "Diane is exhausted.",
    );
    expect(normalizeFamilyReferences("Mom's apron smells of herbs.", relations)).toBe(
      "Diane's apron smells of herbs.",
    );
  });

  it("resolves synonyms to a role-titled relation that has no alias list", () => {
    // AI/directive-registered family entries often carry no aliases — the
    // casual synonyms of the role title must still resolve to it.
    const relations = [rel({ name: "Mother", disposition: "MC's mother" })];
    expect(normalizeFamilyReferences("Mom wants me home early.", relations)).toBe(
      "Mother wants me home early.",
    );
  });

  it("never rewrites non-family NPC aliases", () => {
    const relations = [
      rel({ name: "Mara", aliases: ["Oakhaven Herbalist"], disposition: "Friendly merchant" }),
    ];
    expect(normalizeFamilyReferences("The herbalist smiled.", relations)).toBe(
      "The herbalist smiled.",
    );
  });

  it("respects word boundaries — no substring rewrites", () => {
    const relations = [
      rel({ name: "Diane", aliases: ["Mother", "Mom", "Mum"], disposition: "MC's mother" }),
      rel({ name: "Younger Sister", aliases: ["Sis"], disposition: "MC's younger sister" }),
    ];
    // "Momentum" is not "Mom"; "sister" is not the alias "Sis".
    expect(normalizeFamilyReferences("Momentum builds in the hall.", relations)).toBe(
      "Momentum builds in the hall.",
    );
    expect(normalizeFamilyReferences("My sister is older than me.", relations)).toBe(
      "My sister is older than me.",
    );
  });

  it("replaces longest aliases first so specific titles win", () => {
    const relations = [
      rel({ name: "Lily", aliases: ["Younger Sister", "Sister", "Sis"], disposition: "MC's younger sister" }),
    ];
    expect(normalizeFamilyReferences("Younger Sister is at school.", relations)).toBe(
      "Lily is at school.",
    );
  });

  it("leaves text untouched when there is no family or nothing to resolve", () => {
    expect(normalizeFamilyReferences("The rain fell all night.", [])).toBe(
      "The rain fell all night.",
    );
    const nonFamily = [rel({ name: "Elle", disposition: "librarian" })];
    expect(normalizeFamilyReferences("Elle catalogues the scrolls.", nonFamily)).toBe(
      "Elle catalogues the scrolls.",
    );
    expect(normalizeFamilyReferences("", nonFamily)).toBe("");
    expect(normalizeFamilyReferences("   ", nonFamily)).toBe("");
  });
});
