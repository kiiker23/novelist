// =============================================================================
// providers.test.ts — Unit tests for the one-shot connection test.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiModule, providerNeedsApiKey, formatRetryStatus, GenerationRetryInfo } from "./providers";
import type { ApiConfig } from "../state/GameState";
import { StateModule } from "../state/state";

const localConfig: ApiConfig = {
  provider: "local",
  key: "",
  url: "http://localhost:11434/api/chat",
  model: "test-model",
};

const openAiConfig: ApiConfig = {
  provider: "openai",
  key: "sk-test",
  url: "",
  model: "gpt-4o-mini",
};

describe("ApiModule.testConnection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports success with latency and the model reply, using a minimal message set", async () => {
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      expect(String(url)).toContain("api.openai.com");
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
      // system + one user prompt, no game history
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[1].role).toBe("user");
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
          status: 200,
        }),
      );
    });

    const result = await ApiModule.testConnection(openAiConfig);
    expect(result.ok).toBe(true);
    expect(result.reply).toBe("pong");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a missing API key without touching the network", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(String(url));
      return Promise.reject(new Error("should not be called"));
    });

    const result = await ApiModule.testConnection({ ...openAiConfig, key: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("API Key missing");
    expect(calls).toHaveLength(0);
  });

  it("reports provider errors with their status code", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("bad key", { status: 401 })));
    const result = await ApiModule.testConnection(openAiConfig);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
  });

  it("routes DeepSeek through the dev-server proxy when no key is set", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      expect(String(url)).toBe("/api/deepseek/chat");
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
          status: 200,
        }),
      );
    });

    const result = await ApiModule.testConnection({
      ...openAiConfig,
      provider: "deepseek",
      key: "",
      model: "deepseek-v4-flash",
    });
    expect(result.ok).toBe(true);
    expect(result.reply).toBe("pong");
  });

  it("hits api.deepseek.com directly when a DeepSeek key is set", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      expect(String(url)).toContain("api.deepseek.com");
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
          status: 200,
        }),
      );
    });

    const result = await ApiModule.testConnection({
      ...openAiConfig,
      provider: "deepseek",
      key: "sk-test",
      model: "deepseek-v4-flash",
    });
    expect(result.ok).toBe(true);
  });

  it("reports network failures with an actionable message", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    const result = await ApiModule.testConnection(openAiConfig);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Network error");
    expect(result.error).toContain("could not reach the endpoint");
  });

  it("aborts and reports a timeout when the provider hangs", async () => {
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      // Honor the abort signal instead of hanging the test forever.
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }
      });
    });

    const result = await ApiModule.testConnection(openAiConfig, 50);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Timed out");
  });

  it("warns only for providers that strictly require a key", () => {
    // Cloud providers: key is mandatory.
    for (const p of ["gemini", "openai", "claude", "deepseek", "groq", "together", "mistral"] as ApiConfig["provider"][]) {
      expect(providerNeedsApiKey(p)).toBe(true);
    }
    // Local and custom endpoints may run without auth.
    expect(providerNeedsApiKey("local")).toBe(false);
    expect(providerNeedsApiKey("custom")).toBe(false);
  });

  it("routes local providers through the local call path", async () => {
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      expect(String(url)).toBe("http://localhost:11434/api/chat");
      const body = JSON.parse(String(init?.body)) as { model: string; messages: unknown[] };
      expect(body.model).toBe("llama3.2");
      return Promise.resolve(
        new Response(JSON.stringify({ message: { content: "pong" } }), { status: 200 }),
      );
    });

    const result = await ApiModule.testConnection({
      provider: "local",
      key: "",
      url: "http://localhost:11434/api/chat",
      model: "llama3.2",
    });
    expect(result.ok).toBe(true);
    expect(result.reply).toBe("pong");
  });
});

// ===========================================================================
// generateResponse — retry-with-backoff around aborted / transient failures
// ===========================================================================

describe("ApiModule.generateResponse retry-with-backoff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubOnceThenSucceed(rejectWith: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(rejectWith)
      .mockResolvedValue(
        new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("retries an aborted generation with visible backoff and recovers", async () => {
    vi.useFakeTimers();
    StateModule.state.api = { ...localConfig };
    const fetchMock = stubOnceThenSucceed(new DOMException("aborted", "AbortError"));
    const retries: GenerationRetryInfo[] = [];

    const promise = ApiModule.generateResponse("sys", "user", undefined, (i) => retries.push(i));
    await vi.advanceTimersByTimeAsync(10000);
    await expect(promise).resolves.toBe("ok");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retries).toHaveLength(2); // waiting + resuming
    expect(retries[0]).toMatchObject({
      phase: "waiting",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10000,
      reason: "aborted",
    });
    expect(retries[1]).toMatchObject({ phase: "resuming", attempt: 1 });
    expect(formatRetryStatus(retries[0])).toBe(
      "The AI connection stalled — retrying in 10s (attempt 1/3)…",
    );
    expect(formatRetryStatus(retries[1])).toBe("AI is writing...");
  });

  it("retries a network TypeError (dropped connection) the same way", async () => {
    vi.useFakeTimers();
    StateModule.state.api = { ...localConfig };
    const fetchMock = stubOnceThenSucceed(new TypeError("fetch failed"));

    const promise = ApiModule.generateResponse("sys", "user");
    await vi.advanceTimersByTimeAsync(10000);
    await expect(promise).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off longer across successive aborts and gives up after 3", async () => {
    vi.useFakeTimers();
    StateModule.state.api = { ...localConfig };
    const abort = new DOMException("aborted", "AbortError");
    const fetchMock = vi.fn().mockRejectedValue(abort);
    vi.stubGlobal("fetch", fetchMock);

    const promise = ApiModule.generateResponse("sys", "user");
    // Attach the rejection handler eagerly so the timer-advanced rejection is
    // never reported as unhandled.
    const assertion = expect(promise).rejects.toThrow(/Failed to reach the AI engine/);
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
    // 1 original attempt + 3 retries, then the error is surfaced.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fails fast on permanent 4xx errors instead of looping", async () => {
    StateModule.state.api = { ...localConfig };
    const fetchMock = vi.fn().mockRejectedValue(
      new Error("Local API Error 404: model not found"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const retries: GenerationRetryInfo[] = [];
    const call = ApiModule.generateResponse("sys", "user", undefined, (i) => retries.push(i));
    const assertion = expect(call).rejects.toThrow(/Local API Error 404/);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(retries).toHaveLength(0);
  });

  it("retries transient server errors with the short backoff", async () => {
    vi.useFakeTimers();
    StateModule.state.api = { ...localConfig };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("Local API Error 503: busy"))
      .mockResolvedValue(
        new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const retries: GenerationRetryInfo[] = [];

    const promise = ApiModule.generateResponse("sys", "user", undefined, (i) => retries.push(i));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retries[0]).toMatchObject({ reason: "server", delayMs: 1000, maxAttempts: 5 });
    expect(formatRetryStatus(retries[0])).toBe(
      "The AI server errored — retrying in 1s (attempt 1/5)…",
    );
  });
});
