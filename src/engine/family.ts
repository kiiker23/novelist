// =============================================================================
// family.ts — Cast anchoring for the MC's household and author directives.
//
// Two gaps this closes:
//
// 1. Family members named in the MC backstory ("lives with his mother and
//    younger sister") were never REGISTERED as relationships — [RELATION] is
//    only emitted when the MC "meets or interacts with" someone, and family
//    is neither met nor interacted with; they just exist. So after a few
//    turns the AI had no durable record of them and "forgot" the sister when
//    the story needed her (school pickup, chores). seedFamilyRelations()
//    scans the backstory once and registers each family member as a real
//    relation (+ NPC profile), so ESTABLISHED RELATIONSHIPS and the NPC
//    panels carry them from turn 1 onward.
//
// 2. Director notes phrased as instructions ("Add librarian Elle to
//    relationship and NPC list") were ignored: the note system told the AI
//    to treat notes as in-world facts and never as meta-instructions.
//    detectRelationDirective() mechanically registers the named person via
//    the same relation pipeline the AI uses, and the note is reworded into
//    a neutral in-world form for the prompt.
// =============================================================================

import { Relation } from "../state/GameState";
import { RelationUpdate, RelationUpdateSchema, safeParseJson } from "../state/schema";
import { StateModule } from "../state/state";
import { LoreModule } from "./lore";
import { unwrapJsonBlock } from "./tag-utils";
import {
  FAMILY_ROLE_NAME_RE,
  ROLE_SYNONYMS,
  containsWholeWord,
  replaceWholeWord,
  resolveCanonicalRelationName,
} from "./family-names";

interface FamilyRolePattern {
  /** Display name used as the relation's name (e.g. "Mother"). */
  role: string;
  /** Matches the role mention inside a sentence. */
  re: RegExp;
  /** Disposition describing the role. */
  disposition: string;
}

/** Role patterns in priority order — the more specific role wins on overlap. */
const FAMILY_ROLE_PATTERNS: FamilyRolePattern[] = [
  { role: "Younger Sister", re: /\byounger\s+sister\b/i, disposition: "MC's younger sister" },
  { role: "Older Sister", re: /\bolder\s+sister\b/i, disposition: "MC's older sister" },
  { role: "Sister", re: /\bsister\b/i, disposition: "MC's sister" },
  { role: "Younger Brother", re: /\byounger\s+brother\b/i, disposition: "MC's younger brother" },
  { role: "Older Brother", re: /\bolder\s+brother\b/i, disposition: "MC's older brother" },
  { role: "Brother", re: /\b(?:half-?)?brother\b/i, disposition: "MC's brother" },
  { role: "Mother", re: /\b(?:mother|mom|mum|mommy|mummy|mama)\b/i, disposition: "MC's mother" },
  { role: "Father", re: /\b(?:father|dad|daddy|papa|pops)\b/i, disposition: "MC's father" },
  { role: "Grandmother", re: /\b(?:grand\s*mother|grandma|granny|nana)\b/i, disposition: "MC's grandmother" },
  { role: "Grandfather", re: /\b(?:grand\s*father|grandpa)\b/i, disposition: "MC's grandfather" },
  { role: "Aunt", re: /\baunt\b/i, disposition: "MC's aunt" },
  { role: "Uncle", re: /\buncle\b/i, disposition: "MC's uncle" },
  { role: "Cousin", re: /\bcousin\b/i, disposition: "MC's cousin" },
  { role: "Niece", re: /\bniece\b/i, disposition: "MC's niece" },
  { role: "Nephew", re: /\bnephew\b/i, disposition: "MC's nephew" },
  { role: "Wife", re: /\bwife\b/i, disposition: "MC's wife" },
  { role: "Husband", re: /\bhusband\b/i, disposition: "MC's husband" },
  { role: "Daughter", re: /\bdaughter\b/i, disposition: "MC's daughter" },
  { role: "Son", re: /\bson\b/i, disposition: "MC's son" },
  { role: "Parents", re: /\bparents?\b/i, disposition: "MC's parents" },
];

/** Parental roles skipped entirely when the MC is an orphan. */
const PARENTAL_ROLES = new Set(["Mother", "Father", "Grandmother", "Grandfather", "Parents"]);

/** Sentence-level hints that the family member has DIED. */
const DEATH_HINTS = /\b(?:died|dead|deceased|killed|murdered|passed\s+away|perished|succumbed|fatal|late\s+(?:mother|father|wife|husband|son|daughter))\b/i;

/** Sentence-level hints that the family member is ABSENT — never fabricate them. */
const ABSENCE_HINTS = /\b(?:without|never\s+had|abandoned|absent|deserted|estranged|missing|orphan|put\s+up\s+for\s+adoption)\b|\bno\s+(?:mother|father|mom|dad|parents?|family)\b/i;

/** Split free text into sentence-like chunks for context classification. */
function splitSentences(text: string): string[] {
  return text
    .split(/[.!?\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Split a sentence into clause fragments (commas, and/but/so/while) so a
 * death or absence hint in one clause ("His mother died, so his father
 * raised him") doesn't misclassify a role in another clause.
 */
function splitClauses(sentence: string): string[] {
  return sentence
    .split(/\s*,\s*|\s+(?:and|but|so|while|whereas)\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Classify a clause fragment around a family mention. */
type FamilyHint = "deceased" | "absent" | "present";
function classifyFragment(fragment: string): FamilyHint {
  if (DEATH_HINTS.test(fragment)) return "deceased";
  if (ABSENCE_HINTS.test(fragment)) return "absent";
  return "present";
}

/**
 * Try to capture a proper name right after a family-role mention within the
 * same sentence: "his mother Diane", "his mother, Mary, was a nurse",
 * "his mother (Sarah)", "his mother named June". Returns null when no name
 * is there — "his mother worked at the Diner" must NOT yield "Diner", so
 * only a capitalized word IMMEDIATELY following the role (optionally after a
 * comma/paren/dash or "named/called") is accepted; a following lowercase
 * word ("works", "was", "spoke") blocks the capture.
 */
function captureNameNearRole(sentence: string, roleText: string): string | null {
  const idx = sentence.toLowerCase().indexOf(roleText.toLowerCase());
  if (idx === -1) return null;
  const after = sentence.slice(idx + roleText.length);
  const m =
    /^\s*(?:[,(\u2014\u2013-]\s*|named\s+|called\s+)?([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)?)/.exec(
      after,
    );
  if (!m) return null;
  // Strip a trailing possessive ("Mary's" -> "Mary") and refuse obvious
  // sentence-start noise that somehow slipped through.
  const name = m[1].replace(/'s$/, "").trim();
  if (name.length < 2) return null;
  return name;
}

/** A single family-role mention in the backstory. */
interface Hit {
  role: string;
  disposition: string;
  start: number;
  end: number;
  /** Full sentence containing the role (used for name capture). */
  sentence: string;
  /** Clause fragment containing the role (used for death/absence). */
  clause: string;
  /** Force this status regardless of clause hints (widow/widower inference). */
  forcedStatus?: "deceased";
}

/**
 * Scan the backstory text for family-role mentions and return the deduped,
 * pruned set (most-specific role wins, plain sibling dropped next to a
 * specific variant, widow/widower inference applied). Shared by relation
 * detection and deceased-fact extraction.
 */
function scanFamilyHits(backstory: string): { kept: Map<string, Hit>; isOrphan: boolean; text: string } {
  const text = (backstory || "").trim();
  if (!text) return { kept: new Map(), isOrphan: false, text };

  const sentences = splitSentences(text);
  const isOrphan = /\borphan(?:age|ed|s)?\b/i.test(text);

  // Collect (role, start, end, sentence, clause) for every role match.
  const hits: Hit[] = [];
  for (const pattern of FAMILY_ROLE_PATTERNS) {
    // Global flag so exec() advances past each match (never loops forever).
    const re = new RegExp(
      pattern.re.source,
      pattern.re.flags.includes("g") ? pattern.re.flags : pattern.re.flags + "g",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const match = m;
      const sentence = sentences.find((s) => s.includes(match[0])) ?? "";
      // The clause fragment containing this mention, so a death/absence hint
      // in a SIBLING clause doesn't misclassify this family member.
      const clause =
        splitClauses(sentence).find((c) => c.includes(match[0])) ?? sentence;
      hits.push({
        role: pattern.role,
        disposition: pattern.disposition,
        start: match.index,
        end: match.index + match[0].length,
        sentence,
        clause,
      });
    }
  }

  // Keep only the most specific match when roles overlap ("younger sister"
  // also matches plain "sister" at the same span) and dedupe by role.
  const kept = new Map<string, Hit>();
  for (const hit of hits) {
    const overlapping = hits.some(
      (h) => h !== hit && h.start <= hit.start && hit.end <= h.end && h.role !== hit.role,
    );
    if (overlapping) continue; // a more specific pattern already covered this span
    if (!kept.has(hit.role)) kept.set(hit.role, hit);
  }

  // A plain "Sister"/"Brother" mention alongside a specific variant
  // ("younger sister" ... "his sister") refers to the SAME person — drop
  // the plain role so we don't create two NPCs for one sibling.
  if ((kept.has("Younger Sister") || kept.has("Older Sister")) && kept.has("Sister")) {
    kept.delete("Sister");
  }
  if ((kept.has("Younger Brother") || kept.has("Older Brother")) && kept.has("Brother")) {
    kept.delete("Brother");
  }

  // "widowed mother" / "mother is a widow" names the MC's father without
  // mentioning him — acknowledge the dead parent so the household record is
  // complete instead of silently absent. Guards: only infer when the parent
  // is otherwise UNMENTIONED (an explicit mention is handled by normal
  // detection, alive or dead), and never from a widow that belongs to
  // someone else ("her widowed aunt" — "widowed X" where X isn't a parent).
  // (Note: the widow/widower checks below intentionally run on the raw text,
  // before the kept-map return, so both relation and fact views share them.)
  const widowTiedToMother =
    /\bwidowed\s+(?:mother|mom|mum|parent)\b/i.test(text) ||
    /\b(?:mother|mom|mum)\b[^.!?\n]{0,30}\b(?:is\s+a\s+)?widow\b/i.test(text) ||
    /\b(?:mother|mom|mum)\b\s+is\s+widowed\b/i.test(text);
  if (widowTiedToMother && !kept.has("Father") && !isOrphan) {
    kept.set("Father", {
      role: "Father",
      disposition: "MC's father",
      start: -1,
      end: -1,
      sentence: "",
      clause: "",
      forcedStatus: "deceased",
    });
  }
  const fatherIsWidower =
    /\bwidowed\s+(?:father|dad)\b/i.test(text) ||
    /\b(?:father|dad)\b[^.!?\n]{0,30}\b(?:is\s+a\s+)?widower\b/i.test(text) ||
    /\b(?:father|dad)\b\s+is\s+widowed\b/i.test(text);
  if (fatherIsWidower && !kept.has("Mother") && !isOrphan) {
    kept.set("Mother", {
      role: "Mother",
      disposition: "MC's mother",
      start: -1,
      end: -1,
      sentence: "",
      clause: "",
      forcedStatus: "deceased",
    });
  }

  return { kept, isOrphan, text };
}

/**
 * Scan the MC's backstory/appearance text for family members and return the
 * relations that should exist. One entry per role, with status Deceased when
 * the surrounding sentence clearly describes a death; members whose sentence
 * indicates absence ("grew up without a father") are NOT returned — seeding
 * must never fabricate people the backstory excludes. Parental roles are
 * skipped for orphans (siblings still count). When a proper name immediately
 * follows the role ("his mother Diane"), the NAME becomes the relation name
 * and the role title is kept as an alias (so the AI can call her either).
 */
export function detectFamilyFromBackstory(backstory: string): Relation[] {
  const { kept, isOrphan, text } = scanFamilyHits(backstory);
  const relations: Relation[] = [];
  for (const hit of kept.values()) {
    if (isOrphan && PARENTAL_ROLES.has(hit.role)) continue;
    const fragment = hit.clause || text;
    const hint: FamilyHint = hit.forcedStatus ? hit.forcedStatus : classifyFragment(fragment);
    if (hint === "absent") {
      // Don't fabricate people the backstory excludes.
      continue;
    }
    // A proper name right after the role ("his mother Diane") becomes the
    // relation's name; the role title stays as an alias. Casual synonyms
    // ("Mom", "Mum", "Dad", "Grandma"...) are always aliased so AI updates
    // phrased in everyday terms merge onto this same entry.
    const captured = captureNameNearRole(hit.sentence, hit.role);
    const name = captured || hit.role;
    const synonyms = ROLE_SYNONYMS[hit.role] ?? [];
    const aliases = captured ? [hit.role, ...synonyms] : [...synonyms];
    const disposition =
      hint === "deceased" ? `${hit.disposition} (deceased)` : hit.disposition;
    relations.push({
      name,
      aliases,
      disposition,
      status: hint === "deceased" ? "Deceased" : "Alive",
      modifiers: [],
    });
  }
  return relations;
}

/** Collapse whitespace and trim trailing punctuation from a fact sentence. */
function cleanFactSentence(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[.?!,\s]+$/, "").trim();
}

/**
 * Natural narrative facts explaining why each deceased family member is
 * absent, so the AI has context (not just a DEAD marker in the lists). For
 * an explicit death in the backstory the member's own clause is used
 * ("His mother died when he was young"); for a widow/widower-inferred
 * parent there is no death text, so a neutral default is produced
 * ("Father passed away years ago").
 */
export function deceasedFamilyFacts(backstory: string): Array<{ name: string; text: string }> {
  const { kept, isOrphan, text } = scanFamilyHits(backstory);
  const facts: Array<{ name: string; text: string }> = [];
  for (const hit of kept.values()) {
    if (isOrphan && PARENTAL_ROLES.has(hit.role)) continue;
    const fragment = hit.clause || text;
    const hint: FamilyHint = hit.forcedStatus ? hit.forcedStatus : classifyFragment(fragment);
    if (hint !== "deceased") continue;
    const name = captureNameNearRole(hit.sentence, hit.role) || hit.role;
    const hasSource = !hit.forcedStatus && hit.clause.trim().length > 0;
    const textEntry = hasSource
      ? `${cleanFactSentence(hit.clause)}.`
      : `${name} passed away years ago.`;
    facts.push({ name, text: textEntry });
  }
  return facts;
}

/**
 * Ensure every family member found in the backstory is registered as a
 * relationship (+ auto-generated NPC profile when NPC depth is on).
 * Idempotent: existing entries are left untouched (so the AI's richer
 * disposition data is never clobbered on resume). When a member is detected
 * WITH a proper name but already exists under its role title ("Mother" from
 * an older save), the entry is UPGRADED in place: renamed to the real name
 * with the role kept as an alias, and any matching NPC profile is renamed
 * too. Returns the number of relations added or upgraded (0 = no change).
 */
/**
 * localStorage key storing the player's last family-anchoring answer per
 * backstory (hash → boolean), so repeat starts with the same backstory don't
 * re-ask when nothing changed.
 */
const FAMILY_CHOICE_KEY = "omninovel_family_choice";

/** Stable short hash of a backstory, used as the per-backstory record key. */
function familyChoiceKey(backstory: string): string {
  let h = 5381;
  for (let i = 0; i < backstory.length; i++) {
    h = ((h << 5) + h + backstory.charCodeAt(i)) >>> 0;
  }
  return `b${h.toString(36)}`;
}

/** Read all remembered family-anchoring choices ({} when unreadable). */
function readFamilyChoices(): Record<string, boolean> {
  try {
    const store =
      typeof localStorage !== "undefined" ? localStorage : undefined;
    const raw = store ? store.getItem(FAMILY_CHOICE_KEY) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** Remember the answer for a backstory (silently ignored when storage is off). */
function writeFamilyChoice(backstory: string, keep: boolean): void {
  try {
    const store =
      typeof localStorage !== "undefined" ? localStorage : undefined;
    if (!store) return;
    const all = readFamilyChoices();
    all[familyChoiceKey(backstory)] = keep;
    store.setItem(FAMILY_CHOICE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable — just don't remember */
  }
}

/** Forget every remembered family-anchoring choice (used by tests/UX reset). */
export function clearFamilyAnchoringChoices(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(FAMILY_CHOICE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Read the remembered family-anchoring decision for a backstory:
 *   - true  → keep anchoring (either no family to anchor, or the player said
 *             keep for this exact backstory before)
 *   - false → the player previously chose a clean slate for this backstory
 *   - null  → family IS present but unanswered → the caller should ask
 *             (the UI modal previews the detected family with name + role).
 */
export function getRememberedFamilyAnchoring(backstory: string): boolean | null {
  const detected = detectFamilyFromBackstory(backstory || "");
  if (detected.length === 0) return true; // nothing to anchor, nothing to ask
  const remembered = readFamilyChoices()[familyChoiceKey(backstory)];
  return typeof remembered === "boolean" ? remembered : null;
}

/** Persist the player's decision for a backstory (repeat starts won't re-ask). */
export function rememberFamilyAnchoring(backstory: string, keep: boolean): void {
  writeFamilyChoice(backstory, keep);
}

/** The family members detected in a backstory (names + roles), for the dialog. */
export function getDetectedFamily(backstory: string): Relation[] {
  return detectFamilyFromBackstory(backstory || "");
}

export function seedFamilyRelations(backstory: string): number {
  const s = StateModule.state;
  const detected = detectFamilyFromBackstory(backstory);
  let added = 0;

  // Narrative context for deceased members: a "Family" fact bundle entry
  // ("Father passed away years ago") so the AI understands WHY the parent
  // is absent, not just that the lists mark them dead. Deduped + idempotent.
  const deceasedFacts = deceasedFamilyFacts(backstory);
  if (deceasedFacts.length > 0) {
    let bundle = s.memory.facts.find((b) => b.title === "Family");
    if (!bundle) {
      bundle = { title: "Family", entries: [] };
      s.memory.facts.push(bundle);
    }
    for (const f of deceasedFacts) {
      if (!bundle.entries.includes(f.text)) bundle.entries.push(f.text);
    }
  }

  for (const rel of detected) {
    // The AI may have RENAMED a family entry in a prior turn ("Mother" ->
    // "Lin Wei", with the role title demoted to an alias) or registered it
    // under a casual term. Resolve by name OR alias so resume seeding merges
    // onto the canonical entry instead of creating a duplicate "Mother"/
    // "Younger Sister" next to "Lin Wei"/"Lin Mei". Merging only unions
    // aliases/disposition — it NEVER renames an entry back to a role title
    // (the reverse of the AI's name capture would be a regression).
    // Match the detected member against an existing entry — by name/alias
    // first (canonical), then by the seeded disposition, which comes from the
    // same role table and survives AI renames ("Mother" -> "Lin Wei") even
    // when the role alias itself was lost. Merge in place; never duplicate.
    const canonical = resolveCanonicalRelationName(rel.name, s.memory.relations);
    let entry: Relation | undefined = canonical
      ? s.memory.relations.find(
          (r) => r.name.toLowerCase() === canonical.toLowerCase(),
        )
      : undefined;
    if (!entry) {
      // Old saves list the member under the role title ("Mother") while the
      // backstory now names her ("his mother Diane") — the role alias is the
      // first detected alias, so a name lookup on it finds the entry.
      const roleTitle = rel.aliases[0];
      if (roleTitle) {
        const byRole = s.memory.relations.find(
          (r) => r.name.toLowerCase() === roleTitle.toLowerCase(),
        );
        if (byRole) entry = byRole;
      }
    }
    if (!entry) {
      // AI-renamed entries ("Lin Wei" with disposition "MC's mother" but no
      // "Mother" alias): the seeded disposition comes from the same role
      // table, so an exact match identifies the same person.
      entry = s.memory.relations.find(
        (r) =>
          r.status === rel.status &&
          (r.disposition || "").toLowerCase() ===
            (rel.disposition || "").toLowerCase(),
      );
    }
    if (entry) {
      // The backstory may now NAME a member the save still lists by role
      // title ("his mother Diane" when the entry is "Mother") — promote the
      // captured name, keeping the old primary as an alias. Role titles
      // themselves are ROLE_SYNONYMS keys and never rename an entry backward
      // ("Mother" must never demote "Lin Wei" back to a generic title).
      const isRoleTitle = Object.prototype.hasOwnProperty.call(
        ROLE_SYNONYMS,
        rel.name,
      );
      if (!isRoleTitle && entry.name.toLowerCase() !== rel.name.toLowerCase()) {
        const oldName = entry.name;
        if (
          !entry.aliases.some((x) => x.toLowerCase() === oldName.toLowerCase())
        ) {
          entry.aliases.push(oldName);
        }
        entry.name = rel.name;
        const prof = s.npcProfiles.find(
          (p) => p.npcName.toLowerCase() === oldName.toLowerCase(),
        );
        if (prof) prof.npcName = rel.name;
        added++;
      }
      // Union the detected name + synonyms back in as aliases — this repairs
      // entries whose role title was dropped during an AI rename, so future
      // alias-based resolution ([RELATION] updates, directives, FACT
      // linking, location shifts) can still find them as "Mother".
      for (const a of [rel.name, ...rel.aliases]) {
        if (a.toLowerCase() === entry.name.toLowerCase()) continue;
        if (!entry.aliases.some((x) => x.toLowerCase() === a.toLowerCase())) {
          entry.aliases.push(a);
        }
      }
      if (!entry.disposition) entry.disposition = rel.disposition;
      continue;
    }
    added++;
    LoreModule.applyRelationUpdate({
      name: rel.name,
      aliases: rel.aliases,
      disposition: rel.disposition,
      status: rel.status,
    });
  }

  // Family members live under the same roof: anchor each ALIVE family
  // profile's location to the MC's home so household NPCs count as witnesses
  // when the MC is home — kindness, chores, and gifts toward family then
  // genuinely move their Trust/Affection (the reaction pipeline keys off
  // witnesses at the MC's location). Deceased members never witness. Runs on
  // both new-game seeding and resume (repairs saves whose family profiles
  // predate location tracking); idempotent — a knownLocation the AI later
  // set (e.g. "Diner", "School") is never clobbered.
  const home = homeLocation();
  if (home) {
    for (const rel of s.memory.relations) {
      if (rel.status !== "Alive" || !isFamilyRelation(rel)) continue;
      const prof = s.npcProfiles.find(
        (p) =>
          p.npcName.toLowerCase() === rel.name.toLowerCase() ||
          (rel.aliases || []).some(
            (a) => p.npcName.toLowerCase() === a.toLowerCase(),
          ),
      );
      if (prof && !prof.knownLocation) prof.knownLocation = home;
    }
  }
  return added;
}

/**
 * The MC's home — the starting location recorded at setup (survives moves,
 * so "repair at school" still resolves to home), falling back to the current
 * location when an old save has no setup record.
 */
function homeLocation(): string | null {
  const s = StateModule.state;
  const setup = s.setup as { location?: string } | Record<string, never>;
  const fromSetup =
    setup && typeof setup === "object" && "location" in setup
      ? (setup as { location?: string }).location
      : "";
  return (fromSetup || s.worldState.location || "").trim() || null;
}

/**
 * True when a registered relation is family of the MC — either seeded from
 * the backstory (disposition carries the "MC's ..." marker) or registered
 * by the AI/directive under a recognizable family role title. Used by the
 * prompt to render the FAMILY (household) block inside MAIN CHARACTER.
 */
export function isFamilyRelation(rel: Relation): boolean {
  if (!rel) return false;
  const name = (rel.name || "").toLowerCase();
  const disp = (rel.disposition || "").toLowerCase();
  return FAMILY_ROLE_NAME_RE.test(name) || /^mc's\b|family of the mc/.test(disp);
}

/** Stopwords that can never be an NPC name. */
const NON_NAME_WORDS = new Set([
  "the", "a", "an", "and", "or", "list", "npc", "npcs", "character",
  "relationship", "relationships", "new", "one", "some", "this", "that",
]);

/** Words that never belong in a parsed directive disposition. */
const DISPOSITION_NOISE = new Set([
  "my", "our", "your", "his", "her", "their", "its", "a", "an", "the",
]);

/** Best-guess person name from a directive phrase ("my Dad" -> "Dad"). */
function extractDirectiveName(phrase: string): string | null {
  const words = phrase.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const capitalized = words.filter((w) => /^[A-Z]/.test(w));
  const nameWord =
    capitalized.length > 0 ? capitalized[capitalized.length - 1] : words[words.length - 1];
  if (!nameWord || NON_NAME_WORDS.has(nameWord.toLowerCase())) return null;
  return nameWord[0].toUpperCase() + nameWord.slice(1);
}

/** Strip possessive pronouns/articles from a parsed directive disposition. */
function cleanDirectiveDisposition(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const cleaned = d
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !DISPOSITION_NOISE.has(w.toLowerCase()))
    .join(" ");
  return cleaned || undefined;
}

/**
 * Finalize a natural-language directive: resolve casual family terms
 * ("Mom", "Dad", "Grandma") onto the canonical registered relation name so
 * the note merges instead of creating a duplicate NPC, and strip possessive
 * noise from the disposition ("my Mom" -> no disposition, so the existing
 * relation's richer disposition is never clobbered). The explicit [RELATION]
 * JSON path is NOT finalized — it carries full update semantics (status,
 * aliases for name discovery) that must survive untouched.
 */
function finalizeDirective(update: { name: string; disposition?: string }): {
  name: string;
  disposition?: string;
} {
  const canonical = resolveCanonicalRelationName(
    update.name,
    StateModule.state.memory.relations,
  );
  return {
    name: canonical || update.name,
    disposition: cleanDirectiveDisposition(update.disposition),
  };
}

/**
 * Detect an author directive that registers an NPC / relationship inside a
 * Director's Note. Understands the phrasings users actually type:
 *   - "Add librarian Elle to relationship and NPC list"
 *   - "Add mother in list"
 *   - "Create NPC Sarah, a blacksmith"
 *   - "relationship: Bob - friendly"
 *   - "[RELATION]{\"name\":\"Elle\",...}[/RELATION]"
 * Returns a RelationUpdate to apply, or null when the note is a normal
 * in-world event (festivals, weather, etc.) — those keep the event behavior.
 */
export function detectRelationDirective(text: string): RelationUpdate | null {
  const t = (text || "").trim();
  if (!t) return null;

  // 1. Explicit engine tag in the note.
  const relMatch = /\[RELATION\]\s*(\{.*?\})\s*\[\/RELATION\]/is.exec(t);
  if (relMatch) {
    const parsed = safeParseJson(RelationUpdateSchema, unwrapJsonBlock(relMatch[1]));
    if (parsed.ok && parsed.data) return parsed.data;
  }

  // 2. "relationship: Name - disposition" prefix.
  const relColon = /(?:add|register|create|introduce)?\s*relationships?\s*:\s*(.+)$/i.exec(t);
  if (relColon) {
    const rest = relColon[1].trim().replace(/^[-–—>\s]+/, "");
    const sep = rest.split(/\s+[-–—]\s+/);
    const head = sep[0].trim();
    const tail = sep.slice(1).join(" ").trim();
    const headWords = head.split(/\s+/).filter(Boolean);
    if (headWords.length > 0) {
      const capitalized = headWords.filter((w) => /^[A-Z]/.test(w));
      const nameWord = capitalized.length > 0 ? capitalized[capitalized.length - 1] : headWords[0];
      if (!NON_NAME_WORDS.has(nameWord.toLowerCase())) {
        const name = nameWord;
        const disposition = [headWords.filter((w) => w !== nameWord).join(" "), tail]
          .filter(Boolean)
          .join(" ");
        return finalizeDirective({ name, disposition: disposition || undefined });
      }
    }
  }

  // 3. "add/register/create/introduce X (to|in) the relationship/NPC list".
  const verbMatch = /\b(add|register|create|introduce|log)\b/i.exec(t);
  if (!verbMatch) return null;
  const hasTarget =
    /\b(?:relationships?|npcs?|npc\s+list|characters?|persons?|people|to\s+(?:the\s+)?list|in\s+(?:the\s+)?list)\b/i.test(
      t,
    );
  if (!hasTarget) return null;

  const subjRe = new RegExp(
    `\\b${verbMatch[1]}\\s+(?:the\\s+|a\\s+|an\\s+)?(.+?)(?:\\s+(?:to|in|as|with|from|for)\\b.*)?$`,
    "i",
  );
  const subjMatch = subjRe.exec(t);
  if (!subjMatch) return null;

  // Cut trailing clauses and take the name-bearing head ("Sarah, a blacksmith" -> "Sarah").
  const head = subjMatch[1].split(/[,:;]/)[0].trim();
  if (!head) return null;
  const name = extractDirectiveName(head);
  if (!name) return null;
  const disposition = head
    .split(/\s+/)
    .filter((w) => w.toLowerCase() !== name.toLowerCase())
    .join(" ");
  return finalizeDirective({ name, disposition: disposition || undefined });
}

/**
 * Detect a director note that corrects which person a stored fact is about
 * ("that fact was about my Dad, not the neighbor"). Returns the WRONG person
 * phrase (oldPhrase) and the CORRECT person phrase (newName) — or null for
 * ordinary notes. Two grammars:
 *   - correction-first:  "fact ... about <NEW> (,) not <OLD>"
 *   - attribution-first: "fact about <OLD> (was|is|belongs to|concerns...) <NEW>"
 */
export function detectFactReassignmentDirective(
  text: string,
): { oldPhrase: string; newName: string } | null {
  const t = (text || "").trim();
  if (!t) return null;

  // NEW first: "that fact was about my Dad, not the neighbor".
  const newFirst =
    /\bfacts?\b[^.!?\n]{0,50}?\babout\s+(.+?)\s*(?:,\s*)?not\s+(.+?)(?:[.!]|$)/i.exec(t);
  if (newFirst) {
    const newRaw = newFirst[1].trim();
    const oldRaw = newFirst[2].trim();
    const newName = extractDirectiveName(newRaw);
    if (newName && oldRaw) return { oldPhrase: oldRaw, newName };
  }

  // OLD first: "the fact about the neighbor was actually about my Dad".
  const oldFirst =
    /\bfacts?\b[^.!?\n]{0,50}?\babout\s+(.+?)\s+(?:was|is|was\s+actually|actually\s+was|was\s+really|really\s+was|should\s+be|belongs?|concerns?|is\s+about|was\s+about|turns?\s+out\s+to\s+be)\s+(?:about\s+)?(.+?)(?:[.!]|$)/i.exec(
      t,
    );
  if (oldFirst) {
    const oldRaw = oldFirst[1].trim();
    const newRaw = oldFirst[2].trim();
    const newName = extractDirectiveName(newRaw);
    if (newName && oldRaw) return { oldPhrase: oldRaw, newName };
  }
  return null;
}

/**
 * Detect a director note that names an unnamed family member
 * ("the mother's name is Diane", "my mom is named Diane", "name the mother
 * Diane"). The person phrase must be a recognizable family role (Mother,
 * Mom, Sister, Dad...); "her name is Diane" with no role is left alone as
 * ambiguous. Returns the relation update to apply (which renames the
 * role-titled entry via the discovery merge, keeping the old title as an
 * alias) plus the role title for the reworded note, or null.
 */
export function detectNamingDirective(text: string): {
  update: RelationUpdate;
  role: string;
} | null {
  const t = (text || "").trim();
  if (!t) return null;

  const nameRe = "([A-Z][A-Za-z'-]+(?:\\s+[A-Z][A-Za-z'-]+)?)";
  const patterns = [
    // "(the|my) <role>('s) name is <Name>"
    new RegExp(`(?:my\\s+|the\\s+)?([A-Za-z][A-Za-z\\s-]*?)\\s*(?:'s)?\\s+name\\s+is\\s+${nameRe}`, "i"),
    // "(the|my) <role> is named <Name>"
    new RegExp(`(?:my\\s+|the\\s+)?([A-Za-z][A-Za-z\\s-]*?)\\s+is\\s+named\\s+${nameRe}`, "i"),
    // "name (the|my) <role> <Name>"
    new RegExp(`\\bname\\s+(?:the\\s+|my\\s+)?([A-Za-z][A-Za-z\\s-]*?)\\s+${nameRe}\\s*$`, "i"),
  ];

  for (const re of patterns) {
    const m = re.exec(t);
    if (!m) continue;
    const person = m[1].trim();
    const name = m[2].trim();
    const rolePattern = FAMILY_ROLE_PATTERNS.find((p) => p.re.test(person));
    if (!rolePattern) continue; // "her name is Diane" — no role to attach to
    const personKey = person.replace(/^(?:the|my|our|your|his|her|their)\s+/i, "");
    const canonical = resolveCanonicalRelationName(personKey, StateModule.state.memory.relations);
    const entry = canonical
      ? StateModule.state.memory.relations.find(
          (r) => r.name.toLowerCase() === canonical.toLowerCase(),
        )
      : undefined;
    if (entry) {
      // Already carries this name — nothing to rename; treat as ordinary note.
      if (entry.name.toLowerCase() === name.toLowerCase()) return null;
      // Rename via the discovery merge: new name + the current name as alias.
      return { update: { name, aliases: [entry.name] }, role: rolePattern.role };
    }
    // Not registered yet — register under the name with the role disposition.
    return { update: { name, disposition: rolePattern.disposition }, role: rolePattern.role };
  }
  return null;
}

/**
 * Rewrite stored facts whose person is wrong. oldPhrase is matched as whole
 * words inside fact entries ("the neighbor" or bare "neighbor"); matching
 * mentions are replaced with the canonical registered name of newName ("Dad"
 * -> "Father", "Mom" -> "Diane"), or the raw name when the person isn't
 * registered. Rewrites every matching entry (deduped per bundle). Returns the
 * number of entries rewritten and the resolved name used.
 */
export function applyFactReassignment(directive: {
  oldPhrase: string;
  newName: string;
}): { rewritten: number; newName: string; registered: boolean } {
  const s = StateModule.state;
  const relations = s.memory.relations || [];
  const canonical =
    resolveCanonicalRelationName(directive.newName, relations) || directive.newName;
  // The corrected person may not be known yet — register them through the
  // same relation pipeline the AI uses, so the NPC appears in the
  // relationships list and (with NPC depth on) gets an auto-generated
  // profile. The AI can enrich the disposition later via [RELATION].
  let registered = false;
  if (!relations.some((r) => r.name.toLowerCase() === canonical.toLowerCase())) {
    LoreModule.applyRelationUpdate({ name: canonical, disposition: "" });
    registered = true;
  }
  const full = directive.oldPhrase.trim();
  const stripped = full.replace(/^(?:the|a|an)\s+/i, "");
  const variants: string[] = [full];
  if (stripped && stripped.toLowerCase() !== full.toLowerCase()) variants.push(stripped);

  let rewritten = 0;
  for (const bundle of s.memory.facts || []) {
    const out: string[] = [];
    for (const entry of bundle.entries || []) {
      let changed = entry;
      for (const v of variants) {
        if (containsWholeWord(changed, v)) {
          changed = replaceWholeWord(changed, v, canonical);
        }
      }
      if (changed !== entry) rewritten++;
      if (changed && !out.includes(changed)) out.push(changed);
    }
    bundle.entries = out;
  }
  return { rewritten, newName: canonical, registered };
}
