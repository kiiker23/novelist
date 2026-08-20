// =============================================================================
// discovery.test.ts — Unit tests for the local API auto-detection module.
// =============================================================================

import { describe, it, expect, vi } from "vitest";
import {
  parseOllamaModels,
  parseOpenAiModels,
  hasModelList,
  chatEndpointFor,
  KNOWN_SERVERS,
  detectLocalApis,
  checkServerAlive,
  expandSubnet,
  subnetFromIp,
  scanLanForApis,
  MAX_LAN_HOSTS,
} from "./discovery";
import type { DetectedServer } from "./discovery";

describe("Local API Discovery", () => {
  describe("parseOllamaModels", () => {
    it("extracts model names from an /api/tags response", () => {
      const json = {
        models: [
          { name: "llama3.2:latest", model: "llama3.2:latest" },
          { name: "mistral:latest" },
        ],
      };
      expect(parseOllamaModels(json)).toEqual(["llama3.2:latest", "mistral:latest"]);
    });

    it("returns an empty list when no models are pulled", () => {
      expect(parseOllamaModels({ models: [] })).toEqual([]);
    });

    it("returns an empty list for malformed input", () => {
      expect(parseOllamaModels(null)).toEqual([]);
      expect(parseOllamaModels("junk")).toEqual([]);
      expect(parseOllamaModels({})).toEqual([]);
      expect(parseOllamaModels({ models: "nope" })).toEqual([]);
      expect(parseOllamaModels([{ name: "x" }])).toEqual([]);
    });
  });

  describe("parseOpenAiModels", () => {
    it("extracts ids from an OpenAI-compatible /v1/models response", () => {
      const json = {
        object: "list",
        data: [
          { id: "llama-3.2-3b-instruct", object: "model" },
          { id: "qwen2.5-coder" },
        ],
      };
      expect(parseOpenAiModels(json)).toEqual(["llama-3.2-3b-instruct", "qwen2.5-coder"]);
    });

    it("handles legacy llama.cpp bare-array responses", () => {
      expect(parseOpenAiModels([{ id: "model-1" }, { id: "model-2" }])).toEqual(["model-1", "model-2"]);
    });

    it("skips entries without an id and rejects malformed input", () => {
      expect(parseOpenAiModels({ data: [{ object: "model" }, { id: 42 }] })).toEqual([]);
      expect(parseOpenAiModels(null)).toEqual([]);
      expect(parseOpenAiModels(42)).toEqual([]);
      expect(parseOpenAiModels({ data: "nope" })).toEqual([]);
    });
  });

  describe("hasModelList", () => {
    it("accepts Ollama responses with a models array", () => {
      expect(hasModelList("ollama", { models: [] })).toBe(true);
      expect(hasModelList("ollama", { models: [{ name: "x" }] })).toBe(true);
      expect(hasModelList("ollama", {})).toBe(false);
    });

    it("accepts OpenAI-compatible responses with data arrays or bare arrays", () => {
      expect(hasModelList("openai", { data: [] })).toBe(true);
      expect(hasModelList("openai", [{ id: "x" }])).toBe(true);
      expect(hasModelList("openai", {})).toBe(false);
    });
  });

  describe("chatEndpointFor", () => {
    it("maps Ollama to /api/chat", () => {
      const ollama = KNOWN_SERVERS.find((s) => s.id === "ollama");
      expect(ollama).toBeDefined();
      expect(chatEndpointFor(ollama!)).toBe("http://localhost:11434/api/chat");
    });

    it("maps OpenAI-compatible servers to /v1/chat/completions", () => {
      const lmStudio = KNOWN_SERVERS.find((s) => s.id === "lm-studio");
      expect(lmStudio).toBeDefined();
      expect(chatEndpointFor(lmStudio!)).toBe("http://localhost:1234/v1/chat/completions");
    });
  });

  describe("detectLocalApis", () => {
    it("returns only servers that answer with a recognized model list", async () => {
      const urls: string[] = [];
      vi.stubGlobal("fetch", (url: string | URL | Request) => {
        urls.push(String(url));
        if (String(url).includes("11434")) {
          return Promise.resolve(
            new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), { status: 200 }),
          );
        }
        return Promise.reject(new TypeError("fetch failed"));
      });

      const servers = await detectLocalApis();
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        id: "ollama",
        name: "Ollama",
        chatUrl: "http://localhost:11434/api/chat",
      });
      expect(servers[0].models).toEqual(["llama3.2:latest"]);
      expect(urls.some((u) => u === "http://localhost:11434/api/tags")).toBe(true);
      vi.unstubAllGlobals();
    });

    it("skips ports that answer with non-JSON or unrecognized shapes", async () => {
      vi.stubGlobal("fetch", () => {
        return Promise.resolve(new Response("<html>not an api</html>", { status: 200 }));
      });
      const servers = await detectLocalApis();
      expect(servers).toEqual([]);
      vi.unstubAllGlobals();
    });

    it("returns an empty list when every probe fails", async () => {
      vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
      const servers: DetectedServer[] = await detectLocalApis();
      expect(servers).toEqual([]);
      vi.unstubAllGlobals();
    });
  });

  describe("checkServerAlive", () => {
    const ollamaServer: DetectedServer = {
      id: "ollama",
      name: "Ollama",
      kind: "ollama",
      baseUrl: "http://localhost:11434",
      chatUrl: "http://localhost:11434/api/chat",
      models: ["llama3.2:latest"],
    };

    it("returns true while the server answers with its model list", async () => {
      vi.stubGlobal("fetch", (url: string) => {
        expect(url).toBe("http://localhost:11434/api/tags");
        return Promise.resolve(new Response(JSON.stringify({ models: [] }), { status: 200 }));
      });
      expect(await checkServerAlive(ollamaServer)).toBe(true);
      vi.unstubAllGlobals();
    });

    it("returns false when the server is unreachable", async () => {
      vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
      expect(await checkServerAlive(ollamaServer)).toBe(false);
      vi.unstubAllGlobals();
    });

    it("returns false when the response no longer has the expected shape", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(new Response(JSON.stringify({ error: "not found" }), { status: 200 })),
      );
      expect(await checkServerAlive(ollamaServer)).toBe(false);
      vi.unstubAllGlobals();
    });

    it("returns false for an unknown server id", async () => {
      expect(await checkServerAlive({ ...ollamaServer, id: "mystery" })).toBe(false);
    });
  });

  describe("expandSubnet", () => {
    it("accepts a single host", () => {
      expect(expandSubnet("192.168.1.5")).toEqual(["192.168.1.5"]);
    });

    it("accepts the a.b.c shorthand as a /24", () => {
      const ips = expandSubnet("192.168.1");
      expect(ips).toHaveLength(254);
      expect(ips[0]).toBe("192.168.1.1");
      expect(ips[253]).toBe("192.168.1.254");
    });

    it("expands a /24 CIDR, skipping network and broadcast", () => {
      const ips = expandSubnet("192.168.1.0/24");
      expect(ips).toHaveLength(254);
      expect(ips[0]).toBe("192.168.1.1");
      expect(ips[ips.length - 1]).toBe("192.168.1.254");
      expect(ips).not.toContain("192.168.1.0");
      expect(ips).not.toContain("192.168.1.255");
    });

    it("expands an inclusive last-octet range", () => {
      expect(expandSubnet("192.168.1.10-12")).toEqual([
        "192.168.1.10",
        "192.168.1.11",
        "192.168.1.12",
      ]);
    });

    it("caps oversized ranges at MAX_LAN_HOSTS", () => {
      expect(expandSubnet("10.0.0.0/8")).toHaveLength(MAX_LAN_HOSTS);
    });

    it("rejects invalid input", () => {
      expect(expandSubnet("")).toEqual([]);
      expect(expandSubnet("nonsense")).toEqual([]);
      expect(expandSubnet("999.1.1.1")).toEqual([]);
      expect(expandSubnet("192.168.1.5-2")).toEqual([]);
      expect(expandSubnet("192.168.1.0/33")).toEqual([]);
    });
  });

  describe("subnetFromIp", () => {
    it("derives a /24 from a host IP", () => {
      expect(subnetFromIp("192.168.1.5")).toBe("192.168.1.0/24");
    });

    it("returns an empty string for junk", () => {
      expect(subnetFromIp("localhost")).toBe("");
    });
  });

  describe("scanLanForApis", () => {
    it("finds Ollama and LM Studio hosts and maps their chat endpoints", async () => {
      vi.stubGlobal("fetch", (url: string) => {
        if (url === "http://192.168.1.50:11434/api/tags") {
          return Promise.resolve(
            new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 }),
          );
        }
        if (url === "http://192.168.1.51:1234/v1/models") {
          return Promise.resolve(
            new Response(JSON.stringify({ data: [{ id: "llama-3.2-3b-instruct" }] }), { status: 200 }),
          );
        }
        return Promise.reject(new TypeError("fetch failed"));
      });

      const servers = await scanLanForApis("192.168.1.50-51");
      expect(servers).toHaveLength(2);
      const ollama = servers.find((s) => s.id === "lan-11434-192.168.1.50");
      const lmStudio = servers.find((s) => s.id === "lan-1234-192.168.1.51");
      expect(ollama).toMatchObject({
        name: "Ollama (192.168.1.50)",
        chatUrl: "http://192.168.1.50:11434/api/chat",
      });
      expect(ollama!.models).toEqual(["qwen2.5:7b"]);
      expect(lmStudio).toMatchObject({
        name: "LM Studio (192.168.1.51)",
        chatUrl: "http://192.168.1.51:1234/v1/chat/completions",
      });
      expect(lmStudio!.models).toEqual(["llama-3.2-3b-instruct"]);
      vi.unstubAllGlobals();
    });

    it("ignores hosts that answer with unrecognized shapes", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(new Response("<html>router admin</html>", { status: 200 })),
      );
      expect(await scanLanForApis("192.168.1.10-11")).toEqual([]);
      vi.unstubAllGlobals();
    });

    it("returns an empty list for an invalid subnet", async () => {
      expect(await scanLanForApis("not a subnet")).toEqual([]);
    });
  });
});
