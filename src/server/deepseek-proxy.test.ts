// =============================================================================
// deepseek-proxy.test.ts — Unit tests for the DeepSeek dev-server proxy.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  forwardDeepSeekChat,
  deepseekProxyPlugin,
  DEEPSEEK_UPSTREAM,
  DEEPSEEK_PROXY_PATH,
  DEEPSEEK_STATUS_PATH,
} from "./deepseek-proxy";

type MiddlewareFn = (req: any, res: any, next?: () => void) => void;

/** Build the plugin against a fake Vite server and capture the route handlers. */
function buildPlugin(): Record<string, MiddlewareFn> {
  const handlers: Record<string, MiddlewareFn> = {};
  const plugin = deepseekProxyPlugin() as unknown as {
    configureServer(server: { middlewares: { use(path: string, fn: MiddlewareFn): void } }): void;
  };
  plugin.configureServer({ middlewares: { use: (p, f) => void (handlers[p] = f) } });
  return handlers;
}

function makeReq(method: string) {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  return {
    method,
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ||= []).push(cb);
      return this;
    },
    emit(event: string, arg?: unknown) {
      (listeners[event] || []).forEach((cb) => cb(arg));
    },
  };
}

function makeRes() {
  const res: {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    setHeader(k: string, v: string): void;
    end(b?: string): void;
  } = {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    end(b?: string) {
      this.body = b || "";
    },
  };
  return res;
}

const chatPayload = {
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: "You are a test." },
    { role: "user", content: "Hello" },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("forwardDeepSeekChat", () => {
  it("POSTs the payload upstream with a Bearer key and returns status + body", async () => {
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      expect(String(url)).toBe(DEEPSEEK_UPSTREAM);
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
      expect(JSON.parse(String(init?.body))).toEqual(chatPayload);
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const result = await forwardDeepSeekChat(chatPayload, "sk-test");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).choices[0].message.content).toBe("pong");
  });

  it("passes upstream error statuses and bodies through unchanged", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "Authentication Fails" } }), { status: 401 }),
      ),
    );
    const result = await forwardDeepSeekChat(chatPayload, "sk-invalid");
    expect(result.status).toBe(401);
    expect(result.body).toContain("Authentication Fails");
  });

  it("rejects when the upstream call throws (network failure)", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));
    await expect(forwardDeepSeekChat(chatPayload, "sk-test")).rejects.toThrow("ECONNREFUSED");
  });
});

describe("deepseekProxyPlugin middleware", () => {
  it("reports the env key as configured on the status route", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-server");
    const handlers = buildPlugin();
    const res = makeRes();
    handlers[DEEPSEEK_STATUS_PATH](makeReq("GET"), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ configured: true });
  });

  it("reports the env key as missing on the status route", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const handlers = buildPlugin();
    const res = makeRes();
    handlers[DEEPSEEK_STATUS_PATH](makeReq("GET"), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ configured: false });
  });

  it("returns 503 with a helpful message when POSTing without an env key", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const handlers = buildPlugin();
    const res = makeRes();
    const req = makeReq("POST");
    const pending = handlers[DEEPSEEK_PROXY_PATH](req, res);
    req.emit("data", JSON.stringify(chatPayload));
    req.emit("end");
    await pending;
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("DEEPSEEK_API_KEY");
  });

  it("forwards a chat POST end-to-end and returns the upstream body", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-server");
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      expect(String(url)).toBe(DEEPSEEK_UPSTREAM);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-server");
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 }),
      );
    });

    const handlers = buildPlugin();
    const res = makeRes();
    const req = makeReq("POST");
    const pending = handlers[DEEPSEEK_PROXY_PATH](req, res);
    req.emit("data", JSON.stringify(chatPayload));
    req.emit("end");
    await pending;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).choices[0].message.content).toBe("pong");
  });

  it("returns 502 when the upstream call throws", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-server");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));

    const handlers = buildPlugin();
    const res = makeRes();
    const req = makeReq("POST");
    const pending = handlers[DEEPSEEK_PROXY_PATH](req, res);
    req.emit("data", JSON.stringify(chatPayload));
    req.emit("end");
    await pending;
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain("ECONNREFUSED");
  });

  it("rejects non-POST methods on the chat route", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-server");
    const handlers = buildPlugin();
    const res = makeRes();
    handlers[DEEPSEEK_PROXY_PATH](makeReq("GET"), res);
    expect(res.statusCode).toBe(405);
  });
});
