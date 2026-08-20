// =============================================================================
// providers.ts — Multi-provider API gateway with retry logic.
//
// Providers: Gemini, OpenAI, Claude, DeepSeek, Groq, Together, Mistral, Local, Custom
// =============================================================================

import { ApiConfig, ChatMessage } from "../state/GameState";
import { StateModule } from "../state/state";

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

/** Default timeout for the one-shot connection test. */
export const TEST_TIMEOUT_MS = 20000;

const TEST_SYSTEM_PROMPT = "You are a connectivity test. Reply with exactly one word: pong.";
const TEST_USER_PROMPT = "Reply with the word: pong";

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  /** Model's reply, truncated for display (present when ok). */
  reply?: string;
  /** Human-readable failure reason (present when !ok). */
  error?: string;
}

/**
 * Whether a provider strictly requires an API key. Cloud providers all throw
 * "API Key missing." without one; `local` never needs one and `custom` treats
 * it as optional (sent only when present), so those don't count.
 */
export function providerNeedsApiKey(provider: ApiConfig["provider"]): boolean {
  return provider !== "local" && provider !== "custom";
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildMessages(
  systemPrompt: string,
  userText: string,
  compressedHistory?: ChatMessage[],
): Array<{ role: string; content: string }> {
  const history = compressedHistory || StateModule.state.history;
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
  ];
  history.forEach(function(msg: ChatMessage) {
    messages.push({ role: msg.role === "user" ? "user" : "assistant", content: msg.content });
  });
  messages.push({ role: "user", content: userText });
  return messages;
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function callGemini(
  systemPrompt: string,
  userText: string,
  config: ApiConfig,
  compressedHistory?: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = config.key || "";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${apiKey}`;

  const history = compressedHistory || StateModule.state.history;
  const contents = history.map(function(msg: ChatMessage) {
    return {
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    };
  });
  contents.push({ role: "user", parts: [{ text: userText }] });

  const payload = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
  };

  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) throw new Error(`Gemini Error ${response.status}: ${await response.text()}`);

  const data = await response.json();
  return data.candidates[0].content.parts[0].text as string;
}

async function callOpenAI(
  systemPrompt: string,
  userText: string,
  config: ApiConfig,
  compressedHistory?: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  if (!config.key) throw new Error("API Key missing.");
  const url = "https://api.openai.com/v1/chat/completions";

  const messages = buildMessages(systemPrompt, userText, compressedHistory);

  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({ model: config.model || "gpt-4o", messages }),
  });

  if (!response.ok) throw new Error(`OpenAI Error ${response.status}`);
  const data = await response.json();
  return data.choices[0].message.content as string;
}

async function callClaude(
  systemPrompt: string,
  userText: string,
  config: ApiConfig,
  compressedHistory?: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  if (!config.key) throw new Error("API Key missing.");
  const url = "https://api.anthropic.com/v1/messages";

  const history = compressedHistory || StateModule.state.history;
  const messages: Array<{ role: string; content: string }> = [];
  history.forEach(function(msg: ChatMessage) {
    messages.push({ role: msg.role, content: msg.content });
  });
  messages.push({ role: "user", content: userText });

  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model || "claude-sonnet-4-20250514",
      system: systemPrompt,
      max_tokens: 8192,
      messages,
    }),
  });

  if (!response.ok) throw new Error(`Claude Error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.content[0].text as string;
}

async function callDeepSeek(
  systemPrompt: string,
  userText: string,
  config: ApiConfig,
  compressedHistory?: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const messages = buildMessages(systemPrompt, userText, compressedHistory);
  const payload = { model: config.model || "deepseek-v4-flash", messages };

  // No key in the browser -> route through the dev-server proxy, which holds
  // DEEPSEEK_API_KEY in the server environment (see src/server/deepseek-proxy.ts).
  const url = config.key
    ? "https://api.deepseek.com/v1/chat/completions"
    : "/api/deepseek/chat";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.key) headers["Authorization"] = `Bearer ${config.key}`;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) throw new Error(`DeepSeek Error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content as string;
}

async function callGroq(
  systemPrompt: string,
  userText: string,
  config: ApiConfig,
  compressedHistory?: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  if (!config.key) throw new Error("API Key missing.");
  const url = "https://api.groq.com/openai/v1/chat/completions";

  const messages = buildMessages(systemPrompt, userText, compressedHistory);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({ model: config.model || "llama-3.3-70b-versatile", messages }),
    signal,
  });

  if (!response.ok) throw new Error(`Groq Error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content as string;
}

async function callTogether(
  systemPrompt: string,
  userText: string,
  config: ApiConfig,
  compressedHistory?: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  if (!config.key) throw new Error("API Key missing.");
  const url = `https://api.together.xyz/v1/chat/completions`;

  const messages = buildMessages(systemPrompt, userText, compressedHistory);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({ model: config.model || "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free", messages }),
    signal,
  });

  if (!response.ok) throw new Error(`Together Error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content as string;
}

async function callMistral(
  systemPrompt: string,
  userText: string,
  config: ApiConfig,
  compressedHistory?: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  if (!config.key) throw new Error("API Key missing.");
  const url = "https://api.mistral.ai/v1/chat/completions";

  const messages = buildMessages(systemPrompt, userText, compressedHistory);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({ model: config.model || "mistral-large-latest", messages }),
    signal,
  });

  if (!response.ok) throw new Error(`Mistral Error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content as string;
}

async function callLocal(
  systemPrompt: string,
  userText: string,
  config: ApiConfig,
  compressedHistory?: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const url = config.url || "http://localhost:11434/api/chat";
  const isGenerateEndpoint = /\/api\/generate\s*$/i.test(url);
  // Ollama endpoints (/api/chat, /api/generate) accept an `options` block.
  // Raise the context window + generation budget from Ollama's small defaults
  // so thinking models (e.g. supergemma4) finish their internal reasoning and
  // still emit a final answer; otherwise they get cut mid-thought and return
  // an empty `content`. Other OpenAI-compatible local servers ignore this.
  const isOllamaEndpoint = /\/api\/(chat|generate)\s*$/i.test(url);
  const ollamaOptions = isOllamaEndpoint
    ? { options: { num_ctx: 32768, num_predict: 8192 } }
    : {};

  let response: Response;

  if (isGenerateEndpoint) {
    // Ollama /api/generate format: single prompt + system field
    const history = compressedHistory || StateModule.state.history;
    const promptParts: string[] = [];
    history.forEach(function (msg: ChatMessage) {
      promptParts.push(msg.role === "user" ? `User: ${msg.content}` : `Assistant: ${msg.content}`);
    });
    promptParts.push(`User: ${userText}`);

    response = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        prompt: promptParts.join("\n\n"),
        system: systemPrompt,
        stream: false,
        ...ollamaOptions,
      }),
    });
  } else {
    // Ollama /api/chat format (also works with LM Studio & OpenAI-compatible local servers)
    const messages = buildMessages(systemPrompt, userText, compressedHistory);

    response = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, messages, stream: false, ...ollamaOptions }),
    });
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Local API Error ${response.status}: ${errText || response.statusText}`);
  }

  const data = await response.json();

  // Robust response extraction: handle both /api/chat and /api/generate shapes,
  // plus OpenAI-compatible local servers (LM Studio, llama.cpp, vLLM, etc.).
  // Empty/whitespace strings count as missing so thinking models (which can
  // return an empty `content` when their reasoning gets truncated) fall back
  // to `message.thinking` rather than handing the game a blank reply.
  const pickNonEmpty = (...vals: Array<string | null | undefined>): string | undefined => {
    for (const v of vals) {
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
    return undefined;
  };

  const content = pickNonEmpty(
    data.message?.content, // Ollama /api/chat (final answer)
    data.message?.thinking, // Ollama thinking models (e.g. supergemma4) fallback
    data.response, // Ollama /api/generate
    data.choices?.[0]?.message?.content, // OpenAI-compatible
    data.content?.[0]?.text, // Claude-style fallback
  );

  if (content == null) {
    throw new Error(
      `Local API returned an unrecognized response shape. Keys: [${Object.keys(data).join(", ")}]. ` +
      `If using Ollama, try endpoint http://localhost:11434/api/chat`,
    );
  }

  return content as string;
}

async function callCustom(
  systemPrompt: string,
  userText: string,
  config: ApiConfig,
  compressedHistory?: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  if (!config.url) throw new Error("Custom endpoint URL is required.");
  const messages = buildMessages(systemPrompt, userText, compressedHistory);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.key) headers["Authorization"] = `Bearer ${config.key}`;

  const response = await fetch(config.url, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify({ model: config.model, messages }),
  });

  if (!response.ok) throw new Error(`Custom API Error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  // Try OpenAI-compatible format first, then fall back
  return data.choices?.[0]?.message?.content || data.content?.[0]?.text || JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function executeCall(
  config: ApiConfig,
  systemPrompt: string,
  userText: string,
  compressedHistory?: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  switch (config.provider) {
    case "gemini":   return callGemini(systemPrompt, userText, config, compressedHistory, signal);
    case "openai":   return callOpenAI(systemPrompt, userText, config, compressedHistory, signal);
    case "claude":   return callClaude(systemPrompt, userText, config, compressedHistory, signal);
    case "deepseek": return callDeepSeek(systemPrompt, userText, config, compressedHistory, signal);
    case "groq":     return callGroq(systemPrompt, userText, config, compressedHistory, signal);
    case "together": return callTogether(systemPrompt, userText, config, compressedHistory, signal);
    case "mistral":  return callMistral(systemPrompt, userText, config, compressedHistory, signal);
    case "local":    return callLocal(systemPrompt, userText, config, compressedHistory, signal);
    case "custom":   return callCustom(systemPrompt, userText, config, compressedHistory, signal);
    default:         throw new Error(`Unknown provider: ${config.provider}`);
  }
}

// ---------------------------------------------------------------------------
// Generation retries with visibility
// ---------------------------------------------------------------------------

/** Backoff for aborted / dropped-connection generations. Each retry restarts
 * a FULL generation (minutes on local models), so the wait is meaningful and
 * gives Ollama time to recover — and the stall is surfaced to the player via
 * the onRetry callback instead of silently looping. */
const ABORT_RETRY_DELAYS = [10000, 30000, 60000];

/** Backoff for transient server errors (5xx / 408 / 429). */
const SERVER_RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];

export interface GenerationRetryInfo {
  /** "waiting" = about to sleep before the retry; "resuming" = retry starts. */
  phase: "waiting" | "resuming";
  /** Which retry this is, 1-based. */
  attempt: number;
  /** Total retries allowed for this failure class. */
  maxAttempts: number;
  /** Backoff before the retry, ms. */
  delayMs: number;
  /** Why the attempt failed. */
  reason: "aborted" | "server";
}

/** Human-readable loading-pill text for a generation retry. */
export function formatRetryStatus(info: GenerationRetryInfo): string {
  if (info.phase === "resuming") return "AI is writing...";
  const secs = Math.max(1, Math.round(info.delayMs / 1000));
  const label = `attempt ${info.attempt}/${info.maxAttempts}`;
  return info.reason === "aborted"
    ? `The AI connection stalled — retrying in ${secs}s (${label})…`
    : `The AI server errored — retrying in ${secs}s (${label})…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract an HTTP status from a thrown provider error, or null. */
function httpStatus(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const m = /(?:API Error|Error)\s+(\d{3})/i.exec(error.message);
  return m ? Number(m[1]) : null;
}

/** A fetch-level failure: connection dropped, stream aborted, DNS/timeout. */
function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const name = (error as { name?: string } | undefined)?.name;
  return name === "AbortError" || name === "TimeoutError" || name === "NetworkError";
}

/** HTTP statuses worth retrying (rate limits and server hiccups). */
function isServerStatusCode(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export const ApiModule = {
  async generateResponse(
    systemPrompt: string,
    userText: string,
    compressedHistory?: ChatMessage[],
    onRetry?: (info: GenerationRetryInfo) => void,
  ): Promise<string> {
    const config = StateModule.state.api;
    let abortRetries = 0;
    let serverRetries = 0;

    for (;;) {
      try {
        return await executeCall(config, systemPrompt, userText, compressedHistory);
      } catch (error) {
        // Aborted / dropped connections: the failed attempt already burned a
        // full generation, so wait visibly (longer than a normal retry) and
        // let the local server recover before restarting it.
        if (isTransientNetworkError(error) && abortRetries < ABORT_RETRY_DELAYS.length) {
          const delayMs = ABORT_RETRY_DELAYS[abortRetries];
          abortRetries++;
          onRetry?.({
            phase: "waiting",
            attempt: abortRetries,
            maxAttempts: ABORT_RETRY_DELAYS.length,
            delayMs,
            reason: "aborted",
          });
          await sleep(delayMs);
          onRetry?.({
            phase: "resuming",
            attempt: abortRetries,
            maxAttempts: ABORT_RETRY_DELAYS.length,
            delayMs,
            reason: "aborted",
          });
          continue;
        }
        // Transient server errors (5xx / 408 / 429): quick backoff.
        const status = httpStatus(error);
        if (
          status !== null &&
          isServerStatusCode(status) &&
          serverRetries < SERVER_RETRY_DELAYS.length
        ) {
          const delayMs = SERVER_RETRY_DELAYS[serverRetries];
          serverRetries++;
          onRetry?.({
            phase: "waiting",
            attempt: serverRetries,
            maxAttempts: SERVER_RETRY_DELAYS.length,
            delayMs,
            reason: "server",
          });
          await sleep(delayMs);
          onRetry?.({
            phase: "resuming",
            attempt: serverRetries,
            maxAttempts: SERVER_RETRY_DELAYS.length,
            delayMs,
            reason: "server",
          });
          continue;
        }
        // Permanent failures (4xx, missing key, malformed) or retries
        // exhausted — surface the error immediately instead of looping.
        console.error("API Error after retries:", error);
        const msg = error instanceof Error ? error.message : "Unknown error.";
        throw new Error(
          `Failed to reach the AI engine. ${msg} Please check your API Settings.`,
        );
      }
    }
  },

  /**
   * One-shot connectivity check for the given config (no retries). Sends a
   * tiny prompt and reports latency + the model's reply, or the failure
   * reason. Aborts after `timeoutMs` (default TEST_TIMEOUT_MS).
   */
  async testConnection(
    config: ApiConfig,
    timeoutMs: number = TEST_TIMEOUT_MS,
  ): Promise<ConnectionTestResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const reply = await executeCall(
        config,
        TEST_SYSTEM_PROMPT,
        TEST_USER_PROMPT,
        [],
        controller.signal,
      );
      return { ok: true, latencyMs: Date.now() - started, reply: reply.slice(0, 200) };
    } catch (error) {
      const msg = controller.signal.aborted
        ? `Timed out after ${Math.round(timeoutMs / 1000)}s`
        : error instanceof TypeError
          ? "Network error — could not reach the endpoint. Check the URL and your connection."
          : error instanceof Error
            ? error.message
            : "Unknown error.";
      return { ok: false, latencyMs: Date.now() - started, error: msg };
    } finally {
      clearTimeout(timer);
    }
  },
};
