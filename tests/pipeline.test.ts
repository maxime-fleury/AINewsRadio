import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/config";
import { conversationContext, editorialStyle, planSegment } from "../src/radio";
import { cachedSearchNews } from "../src/news";
import { toLlmModel } from "../src/openrouter";
import { normalizeHosts } from "../src/settings";

const nativeFetch = globalThis.fetch;
function installFetch(fn: any) { globalThis.fetch = fn; return () => { globalThis.fetch = nativeFetch; }; }

describe("pipeline modes and research", () => {
  test("successful searches are reused, changing topic refreshes, empty results are not cached", async () => {
    let calls = 0;
    let empty = false;
    const restore = installFetch(async () => {
      calls++;
      return new Response(empty ? "<rss><channel></channel></rss>" : '<rss><channel><item><title>Une fusée scientifique européenne décolle</title><link>https://example.org/rocket</link><description>Une mission vers la Lune</description></item></channel></rss>');
    });
    const options = { query: "unique-test-rocket", rankQuery: "fusée", locale: "fr" as const, useGoogleNews: false, feeds: [{ id: "test", label: "test", url: "https://example.org/rss" }] };
    try {
      expect((await cachedSearchNews(options, 600)).cached).toBe(false);
      expect((await cachedSearchNews(options, 600)).cached).toBe(true);
      expect(calls).toBe(1);
      expect((await cachedSearchNews({ ...options, query: "changed" }, 600)).cached).toBe(false);
      empty = true;
      await cachedSearchNews({ ...options, query: "empty" }, 600);
      expect((await cachedSearchNews({ ...options, query: "empty" }, 600)).cached).toBe(false);
      expect(calls).toBe(4);
    } finally { restore(); }
  });
  test("exploration never fetches a feed and passes heard context and editorial controls to the model", async () => {
    const requests: any[] = [];
    const restore = installFetch(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/models")) return Response.json({ data: [] });
      if (!String(url).includes("/chat/completions")) throw new Error("Unexpected research request: " + url);
      const body = JSON.parse(String(init?.body)); requests.push(body);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ title: "La suite", turns: [{ speaker: "Camille", text: "Le sujet s'approfondit sans relire les nouvelles." }, { speaker: "Théo", text: "Voilà un nouvel angle pour Alex." }], usedSources: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    });
    try {
      const result = await planSegment({ mode: "question", question: "Pourquoi ?", topic: "trous noirs", context: [{ topic: "trous noirs", text: "Une étoile massive s'effondre." }] }, { ...DEFAULT_SETTINGS, openrouterKey: "test-key", radioMode: "explore", humor: 0, addressFrequency: 0 }, undefined, { models: async () => ({ llm: [], tts: [], fetchedAt: 0 }) });
      expect(result.sources).toEqual([]);
      expect(result.knowledge).toBe(true);
      expect(result.stages.some(s => s.name === "sans recherche")).toBe(true);
      expect(requests.every(r => r.messages[1].content.includes("Une étoile massive"))).toBe(true);
      expect(requests.at(-1).messages[0].content).toContain("humour aucun");
    } finally { restore(); }
  });
});

describe("context and settings", () => {
  test("context validates, bounds and labels general knowledge", () => {
    expect(conversationContext(null)).toBe("");
    const rows = Array.from({ length: 20 }, () => ({ topic: "A", text: "x".repeat(2000), knowledge: true }));
    const text = conversationContext(rows);
    expect(text.split("Entendu :")).toHaveLength(7);
    expect(text).toContain("non vérifiées");
    expect(text.length).toBeLessThan(11000);
    expect(editorialStyle(DEFAULT_SETTINGS)).toContain("jamais les faits");
  });
  test("local and OpenRouter host voices survive normalization", () => {
    expect(normalizeHosts([{ name: "A", voice: "eve", persona: "p" }], "fr", "fill", "openrouter")[0].voice).toBe("eve");
    expect(normalizeHosts([], "fr", "fill", "local").map(h => h.voice)).toEqual(["host-1", "host-2"]);
    expect(toLlmModel({ id: "router", pricing: { prompt: -1, completion: -1 } }).free).toBe(false);
  });
});
