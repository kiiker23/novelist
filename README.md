# OmniNovel Engine — AI Interactive Novel Generator

The AI Interactive Novel Generator, migrated from a single 1,463-line HTML file
into a **type-safe, modular TypeScript project that builds back to one
self-contained HTML file**. Same features, same "double-click, offline,
shareable" deliverable — now with a compiler catching the class of bugs that
used to silently corrupt saves, and a prompt-scaling engine that supports
arbitrarily long sessions.

## Commands

```bash
npm install      # install deps (vite, typescript, zod, vitest)
npm run dev      # local dev server with HMR
npm run build    # type-check + bundle -> dist/index.html (single file)
npm run test     # run the unit tests (vitest)
npm run preview  # serve the built dist/ locally
```

The final shippable file is **`dist/index.html`** (~128 KB). All JS and custom
CSS are inlined; the only external references are the Tailwind and Font Awesome
CDNs, exactly as in the original file.

## Project structure

```
src/
  state/
    GameState.ts   # master TypeScript types + SCHEMA_VERSION
    schema.ts      # Zod schemas + safeParseJson helper
    state.ts       # live state + buildFromUI + subskill recalc
  storage/
    save.ts        # export / import / autosave
    migrate.ts     # versioned save migration keyed on SCHEMA_VERSION
    migrate.test.ts
  engine/
    lore.ts        # hardened [STATE_UPDATE]/[FACT]/[RELATION] parser
    lore.test.ts   # parser behavior tests (valid + broken input)
    prompt.ts      # buildSystemPrompt() with summarization + relevance
    turn.ts        # turn loop + lifecycle + token meter
    summarizer.ts  # rolling history summarization module
    summarizer.test.ts
    relevance.ts   # fact/relation relevance filtering
    relevance.test.ts
    token-estimator.ts  # lightweight token counting utility
    token-estimator.test.ts
  api/
    providers.ts   # Gemini / OpenAI / local + retry (accepts compressed history)
    discovery.ts   # auto-detects running local LLM servers (Ollama, LM Studio, ...)
  ui/
    UIManager.ts   # all DOM rendering + parse-notice + token meter
  main.ts          # entry point; wires globals for inline HTML handlers
  styles.css       # custom CSS extracted from the original <style> block
index.html         # original body markup; script blocks replaced by module import
```

## Architecture

### State Management
Centralized `GameState` interface with Zod schema validation for all AI-generated
JSON updates. Broken output is safely skipped rather than partially applied.

### Parsing Engine
Regex-based extraction of engine tags (`[STATE_UPDATE]`, `[FACT]`, `[RELATION]`)
from AI text. Every JSON-bearing block is validated with Zod — valid blocks apply,
recoverable ones are repaired by schema defaults, and genuinely broken ones are
skipped entirely and reported via a non-blocking UI notice.

### Prompt Scaling (Phase 2)
Instead of dumping the full chat history every turn, the engine now:
1. **Rolling Summarization** — periodically asks the AI to produce a "Story So
   Far" summary, then discards older turns from the prompt while keeping recent
   turns in full detail.
2. **Relevance Filtering** — only surfaces facts and relations that match the
   current location, time, or active NPCs, dramatically reducing lorebook size.
3. **Token Meter** — live HUD indicator showing estimated prompt size and remaining
   context budget (green < 50%, yellow 50-80%, orange 80-95%, red > 95%).

### AI Integration
Modular API connectors (Gemini, OpenAI, Local/Ollama) with exponential backoff
retry. All providers accept an optional compressed history array from the
summarizer, enabling bounded prompt sizes regardless of session length.

### Local API Auto-Detection
When the provider is set to Local/Custom, the API Settings modal scans
well-known ports (Ollama 11434, LM Studio 1234, llama.cpp 8080, vLLM 8000,
KoboldCpp 5001, text-generation-webui 5000, Jan 1337, GPT4All 4891) via
`discovery.ts`. Detected servers are listed with their available models; one
click fills the endpoint URL and model name. Probes run in parallel with a
1.5s timeout each, and every response is shape-checked to avoid false
positives. A live navbar badge also scans once at startup and refreshes every
30s (a cheap single-endpoint ping while connected, a full rescan when not), so
starting Ollama mid-session updates the badge automatically.

A **Test Connection** button in the settings modal sends a tiny one-shot
prompt (no retries, no game history) to whatever provider is currently
configured, and reports latency plus the model's reply or the failure reason.
If the selected provider requires an API key and none is entered, it warns
instead of firing a doomed request. Clicking **Use** on a detected local or
LAN server also runs the test automatically, so applying a machine instantly
validates it.

A **LAN scan** option in the settings modal probes other machines on your
network for Ollama (port 11434) and LM Studio (port 1234). Subnets can be
entered as `192.168.1.0/24`, `192.168.1`, `192.168.1.10-40`, or a single IP
(the box pre-fills from your machine's LAN IP). Hosts are probed in bounded
parallel chunks with per-probe timeouts and a live progress counter. Note
that remote servers must allow cross-origin requests: Ollama binds localhost
by default (set `OLLAMA_HOST=0.0.0.0` to expose it) and its CORS only permits
localhost origins — if the app is served from a LAN IP, set `OLLAMA_ORIGINS`
to allow that origin. Most OpenAI-compatible servers (llama.cpp, vLLM) send
`Access-Control-Allow-Origin: *` by default.

### Testing
46 passing unit tests cover tag stripping, valid + broken `STATE_UPDATE` handling,
FACT bundling/reset, structured + legacy `RELATION` parsing, versioned migration,
rolling summarization, relevance filtering, and token estimation.

## Phases

### Phase 0 — TypeScript migration ✅
Migrated the original 1,463-line HTML file into typed, modular TypeScript that
builds back to one self-contained HTML file — no feature changes, full type
safety, parser tests pinned.

### Phase 1 — State & parsing hardening ✅
- Zod-validated AI output: every `[STATE_UPDATE]` and `[RELATION]` block is
  validated; broken output is safely skipped.
- Structured relations with legacy string fallback.
- Non-blocking parse notice for skipped updates.
- Versioned save migration for schema evolution.

### Phase 2 — Prompt scaling ✅
- Rolling history summarization via `summarizer.ts` — compresses older turns
  into a "Story So Far" summary, keeping recent turns in full detail.
- Fact and relation relevance filtering via `relevance.ts` — only includes
  lorebook entries matching the current location, time, or active NPCs.
- Token estimation utility (`token-estimator.ts`) — lightweight character-to-token
  approximation for UI feedback.
- Live token meter in the HUD — color-coded progress bar showing estimated prompt
  size and remaining context budget.
- API providers accept compressed history for bounded prompt sizes.

### Phase 3 — Structured game systems (planned)
- Quest tracking system with objectives and rewards.
- Equipment slots (HEAD, BODY, WEAPON, ACCESSORY, etc.) with stat bonuses.
- Economy system with currencies, shops, and trading.

### Phase 4 — Character progression (planned)
- XP/leveling system with stat growth curves.
- Skill trees and talent points.
- Cultivation breakthrough mechanics.

### Phase 5 — UX polish (planned)
- Auto-generated Codex from lorebook facts.
- Markdown rendering in the story feed.
- Mobile-responsive layout.
- Theme customization.
