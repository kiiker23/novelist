// =============================================================================
// relevance.test.ts - Unit tests for fact/relation relevance filtering.
// =============================================================================

import { describe, it, expect } from "vitest";
import { filterFacts, filterRelations, buildRelevanceContext } from "./relevance";
import { FactBundle, Relation } from "../state/GameState";

describe("Relevance Filtering", () => {
  describe("filterFacts", () => {
    const facts: FactBundle[] = [
      { title: "Household", entries: ["The Wang family lives in the eastern quarter."] },
      { title: "Prices", entries: ["A bowl of noodles costs 5 copper.", "An inn room costs 50 copper."] },
      { title: "Lin Hao", entries: ["Lin Hao has a secret jade pendant.", "His mother died when he was young."] },
      { title: "General", entries: ["Cultivation requires meditating at dawn."] },
      { title: "Eastern Quarter", entries: ["The eastern quarter is guarded by the Crimson Sect.", "Patrols happen at midnight."] },
    ];

    it("should boost facts matching active NPC names", () => {
      const relations: Relation[] = [
        { name: "Lin Hao", aliases: [], disposition: "Self", status: "Alive", modifiers: [] },
      ];
      const ctx = buildRelevanceContext("", "", relations, 0);
      const result = filterFacts(facts, ctx);
      // Lin Hao bundle should score higher than Price bundle (no NPC match).
      const linHaoIdx = result.findIndex((f) => f.title === "Lin Hao");
      const priceIdx = result.findIndex((f) => f.title === "Prices");
      expect(linHaoIdx).toBeLessThan(priceIdx);
    });

    it("should boost location-matching facts", () => {
      const relations: Relation[] = [];
      const ctx = buildRelevanceContext("Eastern Quarter", "Morning", relations, 0);
      const result = filterFacts(facts, ctx);
      // Eastern Quarter facts should be boosted.
      const eqIdx = result.findIndex((f) => f.title === "Eastern Quarter");
      expect(eqIdx).toBeGreaterThanOrEqual(0);
      expect(eqIdx).toBeLessThan(result.length - 1); // Not last
    });

    it("should include general facts at low scores", () => {
      const relations: Relation[] = [];
      const ctx = buildRelevanceContext("", "", relations, 0);
      const result = filterFacts(facts, ctx);
      const generalIdx = result.findIndex((f) => f.title === "General");
      expect(generalIdx).toBeGreaterThanOrEqual(0);
    });

    it("should exclude low-scoring facts with high minScore", () => {
      const relations: Relation[] = [];
      const ctx = buildRelevanceContext("Moon Temple", "Midnight", relations, 15);
      const result = filterFacts(facts, ctx);
      // No facts mention "Moon Temple" or "Midnight", so most should be filtered.
      expect(result.length).toBeLessThan(facts.length);
    });

    it("should combine NPC and location scoring", () => {
      const relations: Relation[] = [
        { name: "Lin Hao", aliases: [], disposition: "Self", status: "Alive", modifiers: [] },
      ];
      const ctx = buildRelevanceContext("Eastern Quarter", "Morning", relations, 0);
      const result = filterFacts(facts, ctx);
      // Both Eastern Quarter bundle (+8 location) and Lin Hao bundle (+10 NPC) should score high.
      // General and Prices (no matches) should score lowest.
      const generalIdx = result.findIndex((f) => f.title === "General");
      const pricesIdx = result.findIndex((f) => f.title === "Prices");
      // General and Prices should be at the bottom (score 0 or 1).
      expect(generalIdx).toBeGreaterThanOrEqual(result.length - 2);
      expect(pricesIdx).toBeGreaterThanOrEqual(result.length - 2);
    });

    it("should keep the Family bundle visible regardless of location/time", () => {
      const familyFacts: FactBundle[] = [
        { title: "Family", entries: ["Father passed away years ago."] },
        { title: "Prices", entries: ["A bowl of noodles costs 5 copper."] },
      ];
      const ctx = buildRelevanceContext("", "", [], 1);
      const result = filterFacts(familyFacts, ctx);
      // "family" is a general keyword — the household stays in context even
      // when the scene is far from home.
      expect(result.map((f) => f.title)).toContain("Family");
      expect(result.map((f) => f.title)).not.toContain("Prices");
    });
  });

  describe("filterRelations", () => {
    const relations: Relation[] = [
      { name: "Lin Hao", aliases: [], disposition: "Self", status: "Alive", modifiers: [] },
      { name: "Wang Mei", aliases: [], disposition: "Friendly", status: "Alive", modifiers: [] },
      { name: "Elder Zhang", aliases: ["Zhang"], disposition: "Hostile", status: "Alive", modifiers: [{ name: "Suspicious", duration: 2 }] },
      { name: "Dead Bandit", aliases: [], disposition: "Was aggressive", status: "Deceased", modifiers: [] },
      { name: "Master Li", aliases: ["Li"], disposition: "Respectful", status: "Alive", modifiers: [{ name: "Teaching", duration: 10 }] },
    ];

    it("should return all active relations when minScore is 0", () => {
      const ctx = buildRelevanceContext("", "", relations, 0);
      const result = filterRelations(relations, ctx);
      expect(result.active.length).toBe(4); // All alive
      expect(result.deceased.length).toBe(1);
    });

    it("should cap active relations when minScore is high", () => {
      const ctx = buildRelevanceContext("City", "Noon", relations, 5);
      const result = filterRelations(relations, ctx);
      // With minScore 5, only relations matching context or with modifiers are kept.
      // Elder Zhang (+20 modifiers) and Master Li (+20 modifiers) should survive.
      expect(result.active.length).toBeLessThanOrEqual(4);
    });

    it("should boost relations with active modifiers", () => {
      const ctx = buildRelevanceContext("", "", relations, 0);
      const result = filterRelations(relations, ctx);
      // Elder Zhang has modifiers, should score higher than Wang Mei.
      const elderIdx = result.active.findIndex((r) => r.name === "Elder Zhang");
      const wangIdx = result.active.findIndex((r) => r.name === "Wang Mei");
      expect(elderIdx).toBeLessThan(wangIdx);
    });

    it("should always separate deceased from active", () => {
      const ctx = buildRelevanceContext("", "", relations, 0);
      const result = filterRelations(relations, ctx);
      const deceasedNames = result.deceased.map((r) => r.name);
      expect(deceasedNames).toContain("Dead Bandit");
      const activeNames = result.active.map((r) => r.name);
      expect(activeNames).not.toContain("Dead Bandit");
    });
  });
});
