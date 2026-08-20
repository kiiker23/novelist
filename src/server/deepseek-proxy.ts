// =============================================================================
// deepseek-proxy.ts — Vite dev-server middleware that proxies chat requests to
// DeepSeek's API using DEEPSEEK_API_KEY from the server environment.
//
// Why: OmniNovel is a 100% client-side app, so every request to
// api.deepseek.com must carry an API key. When the key lives in the dev-server
// environment instead, the browser can POST to `/api/deepseek/chat` on its own
// origin and never handle a key — the same "no extra steps" UX as Freebuff or
// Gemini Studio.
//
// Dev-server only: the single-file production build (vite-plugin-singlefile)
// has no server, so the app falls back to the in-browser key path there.
// =============================================================================

import type { ViteDevServer } from "vite";

export const DEEPSEEK_UPSTREAM = "https://api.deepseek.com/v1/chat/completions";
export const DEEPSEEK_PROXY_PATH = "/api/deepseek/chat";
export const DEEPSEEK_STATUS_PATH = "/api/deepseek/status";

export interface DeepSeekProxyResult {
  status: number;
  body: string;
}

/**
 * Forward a chat payload to DeepSeek's API with the given key. Exported so
 * tests can exercise it with a mocked fetch.
 */
export async function forwardDeepSeekChat(
  payload: unknown,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeepSeekProxyResult> {
  const upstream = await fetchImpl(DEEPSEEK_UPSTREAM, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await upstream.text();
  return { status: upstream.status, body };
}

interface ProxyRequest {
  method?: string;
  on(event: "data", cb: (chunk: { toString(encoding: string): string }) => void): void;
  on(event: "end", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

interface ProxyResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

function sendJson(res: ProxyResponse, status: number, obj: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function readBody(req: ProxyRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: string[] = [];
    req.on("data", (chunk) => parts.push(chunk.toString("utf8")));
    req.on("end", () => resolve(parts.join("")));
    req.on("error", reject);
  });
}

/**
 * Vite plugin exposing two same-origin routes:
 *   GET  /api/deepseek/status  -> { configured } (env key present?)
 *   POST /api/deepseek/chat    -> forwarded to api.deepseek.com with the key
 */
export function deepseekProxyPlugin() {
  return {
    name: "deepseek-proxy",
    configureServer(server: ViteDevServer) {
      const apiKey = (process.env.DEEPSEEK_API_KEY || "").trim();

      server.middlewares.use(DEEPSEEK_STATUS_PATH, (req, res) => {
        if (req.method === "GET" || req.method === "HEAD") {
          sendJson(res, 200, { configured: apiKey.length > 0 });
        } else {
          sendJson(res, 405, { error: "Method not allowed. Use GET." });
        }
      });

      server.middlewares.use(DEEPSEEK_PROXY_PATH, async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method not allowed. Use POST with a chat payload." });
          return;
        }
        if (!apiKey) {
          sendJson(res, 503, {
            error:
              "DEEPSEEK_API_KEY is not set in the dev-server environment. " +
              "Set it when starting `npm run dev`, or enter a key in API Settings.",
          });
          return;
        }
        try {
          const raw = await readBody(req);
          const payload = JSON.parse(raw) as unknown;
          const result = await forwardDeepSeekChat(payload, apiKey);
          res.statusCode = result.status;
          res.setHeader("Content-Type", "application/json");
          res.end(result.body);
        } catch (err) {
          sendJson(res, 502, {
            error: `DeepSeek proxy failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });
    },
  };
}
