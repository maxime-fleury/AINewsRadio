/**
 * Interface de test isolée : bun run scripts/preview-ui.ts
 * http://127.0.0.1:3011/?scenario=ready|offline|catalog-error|no-key|solo|slow|music
 * Aucun appel IA, aucune écriture de réglages ou d'archives.
 */
import { resolve, sep } from "node:path";
import {
  CADENCE_OPTIONS, DEFAULT_HOSTS, DEFAULT_SETTINGS, DUO_PRESETS, FEED_PRESETS,
  LOCALES, PERSONA_TEMPLATES, PROJECT_ROOT, THEME_GROUPS, THEMES, TTS_PRESET_MODELS,
} from "../src/config";

const settingsByScenario = new Map<string, Record<string, any>>();
const offlineAttempts = new Map<string, number>();
const counts: Record<string, number> = {};
const json = (value: unknown, status = 200) => Response.json(value, { status });
const root = resolve(PROJECT_ROOT, "public");
const clip = {
  id: "ui-smoke", kind: "news", status: "ready", title: "Émission de démonstration",
  topic: "IA & tech", searchQuery: "Test d’interface", transcript: "Bonjour. Ceci est une démonstration de la radio. Le transcript accompagne la voix et les commandes restent disponibles.",
  speakers: [{ name: "Lila", voice: "fr-FR-DeniseNeural" }], turns: [], words: null,
  sources: [], reports: [], stages: [], llm: null, tts: null, knowledge: true,
  recycled: 0, createdAt: new Date().toISOString(), audioUrl: "/jingle/start.mp3",
  archive: null, durationMs: null, estimatedSeconds: 10,
};

const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.PORT) || 3011,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const scenario = new URL(req.headers.get("referer") || url).searchParams.get("scenario") || "ready";
    if (!settingsByScenario.has(scenario)) {
      settingsByScenario.set(scenario, {
        ...structuredClone(DEFAULT_SETTINGS), openrouterKey: "", hasKey: scenario !== "no-key",
        keyHint: "test", hostCount: scenario === "solo" ? 1 : 2, musicMood: scenario === "music" ? "ambient" : "aucun", prefetch: 1, topic: "IA & tech",
      });
    }
    const settings = settingsByScenario.get(scenario)!;
    if (path.startsWith("/api/")) counts[path] = (counts[path] || 0) + 1;
    if (path === "/api/state") {
      if (scenario === "slow") await Bun.sleep(1200);
      const attempts = offlineAttempts.get(scenario) || 0;
      offlineAttempts.set(scenario, attempts + 1);
      if (scenario === "offline" && attempts === 0) return json({ error: "Serveur temporairement indisponible (test)" }, 503);
      return json({
        settings, models: { llmModel: null }, voices: [], stats: { totalCostUsd: 0, segments: 0, audioSeconds: 0 },
        history: [], feeds: FEED_PRESETS, locales: Object.entries(LOCALES).map(([id, item]) => ({ id, label: item.label })),
        cadenceOptions: CADENCE_OPTIONS, ttsPresets: TTS_PRESET_MODELS, customTemplates: [], themes: THEMES,
        themeGroups: THEME_GROUPS, hostDefaults: DEFAULT_HOSTS, personaTemplates: PERSONA_TEMPLATES,
        duoPresets: DUO_PRESETS, showsDir: "shows", musicMoods: ["aucun", "ambient"], defaultOpenRouterVoice: "",
        archivedOnDisk: 0, memory: { today: 0, total: 0 }, played: [],
      });
    }
    if (path === "/api/models") return scenario === "catalog-error"
      ? json({ error: "Catalogue indisponible (test)" }, 503) : json({ llm: [], tts: [] });
    if (path === "/api/settings" && req.method === "POST") {
      Object.assign(settings, await req.json());
      return json({ settings });
    }
    if (path === "/api/voices") return json({ voices: [] });
    if (path === "/api/music") return json({ tracks: scenario === "music" ? ["/music/bed-ambient.mp3", "/music/bed-jazz.mp3"] : [], source: "builtin", folder: "", mood: "ambient" });
    if (path === "/api/segment/plan") {        await Bun.sleep(1000);
      return json({ segment: { ...clip, status: "planned" } });
    }
    if (path === "/api/tts/intro") return new Response(await Bun.file(resolve(root, "jingle/start.mp3")).arrayBuffer(), { headers: { "content-type": "audio/mpeg" } });    if (path === "/api/segment/render") {
      await Bun.sleep(scenario === "music" ? 15000 : 1000);
      return json({ segment: clip });
    }
    if (path === "/api/segment/played") return json({ memory: { today: 0, total: 0 }, played: [] });
    if (path === "/api/shows") return json({ days: [], shows: [], totalCount: 0, totalBytes: 0 });
    if (path === "/api/locale") return json({ locale: settings.locale });
    if (path === "/__test/counts") return json(counts);
    if (path.startsWith("/api/")) return json({ error: "Route non simulée" }, 404);
    const filePath = resolve(root, `.${decodeURIComponent(path === "/" ? "/index.html" : path)}`);
    if (!filePath.startsWith(root + sep)) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(filePath);
    if (!await file.exists()) return new Response("Not found", { status: 404 });
    return new Response(await file.arrayBuffer(), { headers: { "content-type": file.type } });
  },
});
console.log(`UI isolée : http://127.0.0.1:${server.port}/?scenario=ready`);
