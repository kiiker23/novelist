// =============================================================================
// discovery.ts — Local API auto-detection.
//
// Probes well-known ports for running local LLM servers (Ollama, LM Studio,
// llama.cpp, text-generation-webui, KoboldCpp, vLLM, Jan, GPT4All) and returns
// the chat-completions endpoint plus the available model names, ready to be
// dropped straight into ApiConfig. Runs entirely from the browser via fetch.
// =============================================================================

export type LocalServerKind = "ollama" | "openai";

export interface KnownServerDef {
  /** Stable id used by the UI to reference a detected server. */
  id: string;
  /** Human-readable server name. */
  name: string;
  /** Default port the server listens on. */
  port: number;
  /** Probe paths, tried in order until one answers (supports legacy endpoints). */
  paths: string[];
  /** How its model-list response is shaped. */
  kind: LocalServerKind;
}

export interface DetectedServer {
  id: string;
  name: string;
  kind: LocalServerKind;
  /** e.g. http://localhost:11434 */
  baseUrl: string;
  /** Endpoint to POST chat completions to (value for ApiConfig.url). */
  chatUrl: string;
  /** Model names/ids reported by the server (may be empty). */
  models: string[];
}

export const PROBE_TIMEOUT_MS = 1500;

// ---- LAN scanning ----
export const LAN_PROBE_TIMEOUT_MS = 500;
export const LAN_CONCURRENCY = 24;
export const MAX_LAN_HOSTS = 1024;

function isValidOctet(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= 255;
}

/**
 * Expand a subnet specifier into a list of host IPs to probe. Accepts:
 *   "192.168.1.5"        — single host
 *   "192.168.1"          — shorthand for 192.168.1.0/24
 *   "192.168.1.0/24"     — CIDR (network/broadcast excluded, capped at MAX_LAN_HOSTS)
 *   "192.168.1.10-40"    — inclusive last-octet range
 */
export function expandSubnet(input: string): string[] {
  const s = input.trim();
  if (!s) return [];
  const pushHosts = (ips: number[]): string[] => {
    const hosts: string[] = [];
    for (const ip of ips) {
      if (hosts.length >= MAX_LAN_HOSTS) break;
      hosts.push(`${(ip >>> 24) & 255}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`);
    }
    return hosts;
  };

  // a.b.c.d — single host
  const single = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (single) {
    const nums = single.slice(1).map(Number);
    return nums.every(isValidOctet)
      ? [`${nums[0]}.${nums[1]}.${nums[2]}.${nums[3]}`]
      : [];
  }

  // a.b.c.d/prefix — CIDR
  const cidr = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(s);
  if (cidr) {
    const nums = cidr.slice(1, 5).map(Number);
    const prefix = Number(cidr[5]);
    if (!nums.every(isValidOctet) || prefix < 0 || prefix > 32) return [];
    const base =
      ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (base & mask) >>> 0;
    const broadcast = (network | ~mask) >>> 0;
    const hosts: number[] = [];
    for (let ip = network + 1; ip < broadcast; ip++) hosts.push(ip);
    return pushHosts(hosts);
  }

  // a.b.c.d1-d2 — inclusive last-octet range
  const range = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})-(\d{1,3})$/.exec(s);
  if (range) {
    const nums = range.slice(1).map(Number);
    const [a, b, c, d1, d2] = nums;
    if (!nums.every(isValidOctet) || d2 < d1) return [];
    const hosts: number[] = [];
    for (let d = d1; d <= d2; d++) {
      hosts.push(((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
    }
    return pushHosts(hosts);
  }

  // a.b.c — shorthand for a.b.c.0/24
  const short = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (short) {
    const nums = short.slice(1).map(Number);
    if (!nums.every(isValidOctet)) return [];
    const [a, b, c] = nums;
    const hosts: number[] = [];
    for (let d = 1; d <= 254; d++) {
      hosts.push(((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
    }
    return pushHosts(hosts);
  }

  return [];
}

/** "192.168.1.5" → "192.168.1.0/24" */
export function subnetFromIp(ip: string): string {
  const parts = ip.split(".");
  if (parts.length !== 4) return "";
  return `${parts.slice(0, 3).join(".")}.0/24`;
}

/**
 * Best-effort guess of this machine's LAN IP via the WebRTC trick. Modern
 * browsers may obfuscate the address (mDNS), in which case we return null and
 * the user types their subnet manually.
 */
export function guessLocalIp(): Promise<string | null> {
  if (typeof window === "undefined" || typeof RTCPeerConnection === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let pc: RTCPeerConnection | null = null;
    let done = false;
    const finish = (ip: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (pc) {
        try {
          pc.close();
        } catch {
          // ignore
        }
      }
      resolve(ip);
    };
    let timer: ReturnType<typeof setTimeout>;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch {
      resolve(null);
      return;
    }
    timer = setTimeout(() => finish(null), 1500);
    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        finish(null);
        return;
      }
      const m = /([0-9]{1,3}(\.[0-9]{1,3}){3})/.exec(e.candidate.candidate);
      if (m && m[1] !== "127.0.0.1") finish(m[1]);
    };
    pc.createDataChannel("probe");
    pc.createOffer()
      .then((offer) => pc && pc.setLocalDescription(offer))
      .catch(() => finish(null));
  });
}

/** Registry of well-known local LLM servers. */
export const KNOWN_SERVERS: KnownServerDef[] = [
  { id: "ollama",       name: "Ollama",              port: 11434, paths: ["/api/tags"],                 kind: "ollama" },
  { id: "lm-studio",    name: "LM Studio",           port: 1234,  paths: ["/v1/models"],                kind: "openai" },
  { id: "llama-cpp",    name: "llama.cpp / LocalAI", port: 8080,  paths: ["/v1/models", "/models"],     kind: "openai" },
  { id: "text-gen-webui", name: "text-generation-webui", port: 5000, paths: ["/v1/models"],            kind: "openai" },
  { id: "koboldcpp",    name: "KoboldCpp",           port: 5001,  paths: ["/v1/models"],                kind: "openai" },
  { id: "vllm",         name: "vLLM",                port: 8000,  paths: ["/v1/models"],                kind: "openai" },
  { id: "jan",          name: "Jan",                 port: 1337,  paths: ["/v1/models"],                kind: "openai" },
  { id: "gpt4all",      name: "GPT4All",             port: 4891,  paths: ["/v1/models"],                kind: "openai" },
];

// ---------------------------------------------------------------------------
// Response parsing (pure — unit tested)
// ---------------------------------------------------------------------------

/** Ollama /api/tags shape: { models: [{ name: "llama3.2:latest", ... }] } */
export function parseOllamaModels(json: unknown): string[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const models = (json as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models
    .map((m) =>
      m && typeof m === "object" && typeof (m as { name?: unknown }).name === "string"
        ? (m as { name: string }).name
        : null,
    )
    .filter((x): x is string => x !== null);
}

/** OpenAI-compatible /v1/models shape: { data: [{ id: "model", ... }] } — plus legacy bare-array responses. */
export function parseOpenAiModels(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const root = json as { data?: unknown };
  const list = Array.isArray(root.data) ? root.data : Array.isArray(json) ? json : null;
  if (!list) return [];
  return list
    .map((m) =>
      m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string"
        ? (m as { id: string }).id
        : null,
    )
    .filter((x): x is string => x !== null);
}

/**
 * Shape check used to avoid false positives: an Ollama server must answer with
 * a `models` array; an OpenAI-compatible server with a `data` array (or a bare
 * array, as legacy llama.cpp does). Empty arrays still count — the server is
 * up, the user just hasn't pulled/loaded any models.
 */
export function hasModelList(kind: LocalServerKind, json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  if (kind === "ollama") return Array.isArray((json as { models?: unknown }).models);
  return Array.isArray((json as { data?: unknown }).data) || Array.isArray(json);
}

/** Chat-completions endpoint to store in ApiConfig.url. */
export function chatEndpointFor(def: Pick<KnownServerDef, "kind" | "port">): string {
  return def.kind === "ollama"
    ? `http://localhost:${def.port}/api/chat`
    : `http://localhost:${def.port}/v1/chat/completions`;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

async function fetchJson(url: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function probe(def: KnownServerDef): Promise<DetectedServer | null> {
  const baseUrl = `http://localhost:${def.port}`;
  for (const path of def.paths) {
    let json: unknown = null;
    try {
      json = await fetchJson(`${baseUrl}${path}`);
    } catch {
      // Connection refused / timeout / CORS block — not this server.
      json = null;
    }
    if (json === null || !hasModelList(def.kind, json)) continue;
    return {
      id: def.id,
      name: def.name,
      kind: def.kind,
      baseUrl,
      chatUrl: chatEndpointFor(def),
      models: def.kind === "ollama" ? parseOllamaModels(json) : parseOpenAiModels(json),
    };
  }
  return null;
}

/**
 * Scan every known server port in parallel. Each probe is bounded by
 * PROBE_TIMEOUT_MS, so a full scan finishes in ~1.5s regardless of how many
 * ports are closed.
 */
export async function detectLocalApis(): Promise<DetectedServer[]> {
  const settled = await Promise.allSettled(KNOWN_SERVERS.map((def) => probe(def)));
  const servers: DetectedServer[] = [];
  settled.forEach((result) => {
    if (result.status === "fulfilled" && result.value !== null) servers.push(result.value);
  });
  return servers;
}

/**
 * Lightweight liveness check for an already-detected server: re-fetches just
 * its probe endpoint and verifies the response shape still holds. Used by the
 * navbar badge to stay live without rescanning every port on each tick.
 */
export async function checkServerAlive(server: DetectedServer): Promise<boolean> {
  const def = KNOWN_SERVERS.find((s) => s.id === server.id);
  if (!def || def.paths.length === 0) return false;
  try {
    const json = await fetchJson(`${server.baseUrl}${def.paths[0]}`);
    return json !== null && hasModelList(def.kind, json);
  } catch {
    return false;
  }
}

async function probeLanPort(
  ip: string,
  port: number,
  kind: LocalServerKind,
  path: string,
  name: string,
): Promise<DetectedServer | null> {
  const baseUrl = `http://${ip}:${port}`;
  try {
    const json = await fetchJson(`${baseUrl}${path}`, LAN_PROBE_TIMEOUT_MS);
    if (json === null || !hasModelList(kind, json)) return null;
    return {
      id: `lan-${port}-${ip}`,
      name: `${name} (${ip})`,
      kind,
      baseUrl,
      chatUrl: kind === "ollama" ? `${baseUrl}/api/chat` : `${baseUrl}/v1/chat/completions`,
      models: kind === "ollama" ? parseOllamaModels(json) : parseOpenAiModels(json),
    };
  } catch {
    return null;
  }
}

/**
 * Probe one host for Ollama (11434) and LM Studio (1234) in parallel — this
 * halves socket pressure vs. sequential probes and avoids double timeouts on
 * unreachable hosts.
 */
async function probeHost(ip: string): Promise<DetectedServer | null> {
  const [ollama, lmStudio] = await Promise.all([
    probeLanPort(ip, 11434, "ollama", "/api/tags", "Ollama"),
    probeLanPort(ip, 1234, "openai", "/v1/models", "LM Studio"),
  ]);
  return ollama || lmStudio;
}

/**
 * Scan machines on the local network for running Ollama / LM Studio servers.
 * Hosts are probed in bounded parallel chunks; each probe is capped at
 * LAN_PROBE_TIMEOUT_MS. `onProgress` (if given) fires after each chunk with
 * the number of hosts completed vs. total. Note: remote servers must allow
 * cross-origin requests (Ollama needs OLLAMA_ORIGINS=*) or the browser will
 * block the response.
 */
export async function scanLanForApis(
  subnetInput: string,
  onProgress?: (progress: { done: number; total: number }) => void,
): Promise<DetectedServer[]> {
  const ips = expandSubnet(subnetInput);
  const servers: DetectedServer[] = [];
  for (let i = 0; i < ips.length; i += LAN_CONCURRENCY) {
    const chunk = ips.slice(i, i + LAN_CONCURRENCY);
    const results = await Promise.all(chunk.map((ip) => probeHost(ip)));
    results.forEach((r) => {
      if (r) servers.push(r);
    });
    if (onProgress) onProgress({ done: Math.min(i + chunk.length, ips.length), total: ips.length });
  }
  return servers;
}
