/**
 * Runtime settings: merged from defaults + .data/settings.json, with the
 * OpenRouter key optionally seeded from the OPENROUTER_API_KEY env var.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, DEFAULT_HOSTS, DEFAULT_LISTENER, DEFAULT_SETTINGS, isMusicMood, LOCALES, normalizeTemplate, PERSONA_TEMPLATE_IDS, type Host, type Locale, type PersonaTemplate, type Settings } from "./config";

const FILE = join(DATA_DIR, "settings.json");

let current: Settings = { ...DEFAULT_SETTINGS };

function coerce(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== "object") return {};
  const p = raw as Record<string, unknown>;
  const out: Partial<Settings> = {};
  if (p.radioMode === "news" || p.radioMode === "explore" || p.radioMode === "hybrid") out.radioMode = p.radioMode;
  if (typeof p.searchIntervalSec === "number" && Number.isFinite(p.searchIntervalSec)) out.searchIntervalSec = Math.min(3600, Math.max(60, Math.round(p.searchIntervalSec)));
  if (p.questionTiming === "after" || p.questionTiming === "now") out.questionTiming = p.questionTiming;
  if (typeof p.ttsFallback === "boolean") out.ttsFallback = p.ttsFallback;
  if (typeof p.ttsFallbackModel === "string") out.ttsFallbackModel = p.ttsFallbackModel.trim().slice(0, 120);
  for (const key of ["humor", "disagreement", "technicality", "replyLength", "addressFrequency"] as const) {
    if (typeof p[key] === "number" && Number.isFinite(p[key])) out[key] = Math.min(3, Math.max(0, Math.round(p[key])));
  }
  if (typeof p.openrouterKey === "string" && !p.openrouterKey.includes("•")) out.openrouterKey = p.openrouterKey.trim();
  if (typeof p.llmModel === "string" && p.llmModel.trim()) out.llmModel = p.llmModel.trim();
  // Le modèle rapide peut être vidé (retour au modèle de rédaction).
  if (typeof p.llmModelFast === "string") out.llmModelFast = p.llmModelFast.trim();
  if (p.ttsProvider === "edge" || p.ttsProvider === "openrouter" || p.ttsProvider === "local") out.ttsProvider = p.ttsProvider;
  if (typeof p.localExaggeration === "number" && Number.isFinite(p.localExaggeration)) out.localExaggeration = Math.min(1, Math.max(0, p.localExaggeration));
  if (typeof p.ttsModel === "string" && p.ttsModel.trim()) out.ttsModel = p.ttsModel.trim();
  if (typeof p.ttsVoice === "string" && p.ttsVoice.trim()) out.ttsVoice = p.ttsVoice.trim();
  if (typeof p.ttsSpeed === "number" && Number.isFinite(p.ttsSpeed)) out.ttsSpeed = Math.min(2, Math.max(0.5, p.ttsSpeed));
  if (p.locale === "fr" || p.locale === "en") out.locale = p.locale;
  if (typeof p.topic === "string" && p.topic.trim()) out.topic = p.topic.trim().slice(0, 120);
  if (Array.isArray(p.chips)) out.chips = p.chips.filter((c): c is string => typeof c === "string" && !!c.trim()).map((c) => c.trim()).slice(0, 24);
  if (Array.isArray(p.feeds)) out.feeds = p.feeds.filter((c): c is string => typeof c === "string");
  if (Array.isArray(p.customFeeds)) {
    out.customFeeds = (p.customFeeds as unknown[])
      .filter((f): f is { label?: unknown; url?: unknown } => !!f && typeof f === "object")
      .map((f) => ({ label: String(f.label ?? "flux"), url: String(f.url ?? "") }))
      .filter((f) => f.url.startsWith("http"))
      .slice(0, 20);
  }
  if (typeof p.hostCount === "number") out.hostCount = p.hostCount >= 2 ? 2 : 1;
  // Backwards compatibility with the first "duo" flag.
  if (p.hostCount == null && typeof p.duo === "boolean") out.hostCount = p.duo ? 2 : 1;
  if (p.listener && typeof p.listener === "object") {
    const l = p.listener as Record<string, unknown>;
    out.listener = {
      name: String(l.name ?? "").trim().slice(0, 24) || DEFAULT_LISTENER[current.locale].name,
      persona: String(l.persona ?? "").slice(0, 400) || DEFAULT_LISTENER[current.locale].persona,
    };
  }
  if (Array.isArray(p.customTemplates)) {
    const seen = new Set<string>();
    const list: PersonaTemplate[] = [];
    for (const raw of p.customTemplates) {
      const template = normalizeTemplate(raw);
      if (!template || PERSONA_TEMPLATE_IDS.has(template.id) || seen.has(template.id)) continue;
      seen.add(template.id);
      list.push(template);
      if (list.length >= 40) break;
    }
    out.customTemplates = list;
  }
  if (typeof p.archive === "boolean") out.archive = p.archive;
  if (typeof p.knowledgeFallback === "boolean") out.knowledgeFallback = p.knowledgeFallback;
  if (typeof p.newsMemory === "boolean") out.newsMemory = p.newsMemory;
  if (typeof p.tutoiement === "boolean") out.tutoiement = p.tutoiement;
  if (Array.isArray(p.hosts)) {
    out.hosts = (p.hosts as unknown[])
      .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
      .slice(0, 2)
      .map((h) => ({
        name: String(h.name ?? "").trim().slice(0, 24),
        voice: String(h.voice ?? "").trim().slice(0, 80),
        persona: String(h.persona ?? "").slice(0, 400),
      }));
  }
  if (typeof p.useGoogleNews === "boolean") out.useGoogleNews = p.useGoogleNews;
  if (typeof p.cadenceSec === "number" && Number.isFinite(p.cadenceSec)) out.cadenceSec = Math.min(600, Math.max(15, Math.round(p.cadenceSec)));
  if (typeof p.maxSources === "number" && Number.isFinite(p.maxSources)) out.maxSources = Math.min(12, Math.max(1, Math.round(p.maxSources)));
  if (typeof p.prefetch === "number" && Number.isFinite(p.prefetch)) out.prefetch = Math.min(3, Math.max(0, Math.round(p.prefetch)));
  if (typeof p.deepRead === "boolean") out.deepRead = p.deepRead;
  if (typeof p.styleNote === "string") out.styleNote = p.styleNote.slice(0, 300);
  if (isMusicMood(p.musicMood)) out.musicMood = p.musicMood;
  // Dossier de musique : c'est un chemin du disque, on le garde tel quel mais on
  // refuse les octets nuls et on borne la longueur. Le serveur ne lit dedans que
  // des fichiers audio, sans jamais sortir du dossier (voir /api/music/file).
  if (typeof p.musicFolder === "string") out.musicFolder = p.musicFolder.replace(/\0/g, "").trim().slice(0, 400);
  return out;
}

export function loadSettings(): void {
  let fromFile: Partial<Settings> = {};
  try {
    fromFile = coerce(JSON.parse(readFileSync(FILE, "utf8")));
  } catch {
    /* first run */
  }
  current = { ...DEFAULT_SETTINGS, ...fromFile };
  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  if (envKey) current.openrouterKey = envKey;
  if (!LOCALES[current.locale as Locale]) current.locale = "fr";
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: unknown): Settings {
  const next: Partial<Settings> = coerce(patch);
  // Clearing the key is allowed with an explicit empty string.
  if (patch && typeof patch === "object" && (patch as Record<string, unknown>).openrouterKey === "") next.openrouterKey = "";
  const localeChanged = next.locale && next.locale !== current.locale;
  current = { ...current, ...next };
  current.hosts = normalizeHosts(current.hosts, current.locale, localeChanged ? "all" : "fill", current.ttsProvider);
  if (localeChanged) {
    // Keep the names, but speak the new language's defaults for the listener.
    current.listener = { ...current.listener, persona: current.listener.persona || DEFAULT_LISTENER[current.locale].persona };
  }
  persist();
  return current;
}

/**
 * Always keeps exactly two hosts, with usable defaults. When the language
 * changes, voices that no longer match it are swapped for the locale default.
 */
export function normalizeHosts(hosts: Host[] | undefined, locale: Locale, mode: "fill" | "all" = "fill", provider: Settings["ttsProvider"] = "edge"): Host[] {
  const defaults = DEFAULT_HOSTS[locale];
  const prefix = locale === "fr" ? /^fr([-_]|$)/i : /^en([-_]|$)/i;
  return [0, 1].map((index) => {
    const fallback = defaults[index];
    const saved = hosts?.[index];
    const voice = saved?.voice ?? "";
    const voiceFits = provider === "local" ? /^host-[12]$/.test(voice) : provider === "openrouter" ? !!voice : prefix.test(voice) && (mode === "fill" || voice === fallback.voice);
    return {
      name: saved?.name?.trim() || fallback.name,
      voice: voiceFits ? voice : provider === "local" ? `host-${index + 1}` : fallback.voice,
      persona: saved?.persona?.trim() ? saved.persona : fallback.persona,
    };
  });
}

function persist(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    void Bun.write(FILE, JSON.stringify(current, null, 2)).catch(err => console.error("[settings] persist failed:", err));
  } catch (err) {
    console.error("[settings] persist failed:", err);
  }
}

/** Never send the raw key to the browser. */
export function publicSettings() {
  const s = current;
  return {
    ...s,
    openrouterKey: "",
    hasKey: s.openrouterKey.length > 0,
    keyHint: s.openrouterKey ? `${s.openrouterKey.slice(0, 8)}…${s.openrouterKey.slice(-4)}` : "",
  };
}
