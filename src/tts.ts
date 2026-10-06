/**
 * Text-to-speech providers.
 *
 *  - "edge"       : free (Microsoft Edge read-aloud voices), returns real word timings.
 *  - "openrouter" : any speech model from the OpenRouter catalogue, billed per
 *                   character (or token/second, estimated).
 *
 * Both return the same shape so the radio pipeline never cares which is used.
 */
import { EdgeTTS, listVoices, type Voice } from "edge-tts-universal";
import { LOCALES, type Locale, type Settings } from "./config";
import { getModels, OrError, speech, ttsCostUsd, type TtsModel } from "./openrouter";

/** Audio buffers are always backed by a plain ArrayBuffer (never shared). */
export type AudioBytes = Uint8Array<ArrayBuffer>;

export interface WordMark {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TtsResult {
  provider: "edge" | "openrouter" | "local";
  model: string;
  voice: string;
  mime: string;
  audio: AudioBytes;
  /** Null when the provider gives no timings; the client then estimates them. */
  words: WordMark[] | null;
  costUsd: number;
  ms: number;
  charCount: number;
}

const EDGE_TIMEOUT_MS = 45_000;

/** Voice codes for models whose ids don't carry a locale prefix. */
const VOICE_HINTS: Record<string, Partial<Record<Locale, string>>> = {
  "hexgrad/kokoro-82m": { fr: "ff_siwis", en: "af_heart" },
  "deepgram/aura-2": { fr: "aura-2-agathe-fr", en: "aura-2-thalia-en" },
};

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function defaultVoiceFor(model: TtsModel | undefined, locale: Locale): string {
  if (!model) return "";
  const hint = VOICE_HINTS[model.id]?.[locale];
  const voices = asArray(model.voices);
  if (hint && voices.includes(hint)) return hint;
  const prefix = locale === "fr" ? /^fr([-_]|$)/i : /^en([-_]|$)/i;
  return voices.find((v) => prefix.test(v)) ?? voices[0] ?? "";
}

/** Edge TTS only accepts integer percentages, e.g. "+5%" or "-10%". */
function rateOf(speed: number): string {
  const pct = Math.round((Math.min(2, Math.max(0.5, speed)) - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

/** Wraps a promise with an abort signal and a hard timeout. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  // The inner synthesis keeps running after we give up on it, so it always needs a
  // rejection handler: without this, an already-aborted signal left the original
  // promise unobserved and its later failure crashed the process.
  promise.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Délai de synthèse dépassé.")), timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export interface EdgeVoiceOption {
  id: string;
  label: string;
}

let voiceCache: { at: number; voices: Voice[] } | null = null;

/** Live Edge voice catalogue, filtered by language, with a curated fallback. */
export async function edgeVoices(locale: Locale, force = false): Promise<EdgeVoiceOption[]> {
  const now = Date.now();
  try {
    if (!voiceCache || force || now - voiceCache.at > 6 * 60 * 60 * 1000) {
      voiceCache = { at: now, voices: await listVoices() };
    }
    const prefix = locale === "fr" ? /^fr-/i : /^en-/i;
    const list = voiceCache.voices
      .filter((v) => prefix.test(v.Locale) && v.Status === "GA")
      .map((v) => ({ id: v.ShortName, label: `${v.ShortName.replace(/Neural$/, "")} (${v.Gender === "Female" ? "F" : "H"})` }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (list.length) return list;
  } catch (err) {
    console.error("[tts] voice list failed:", (err as Error).message);
  }
  return LOCALES[locale].fallbackVoices;
}

async function edgeSynthesize(
  text: string,
  voice: string,
  speed: number,
  locale: Locale,
  signal?: AbortSignal,
): Promise<TtsResult> {
  const started = Date.now();
  const chosen = voice || LOCALES[locale].defaultEdgeVoice;
  const result = await withAbort(new EdgeTTS(text, chosen, { rate: rateOf(speed) }).synthesize(), signal, EDGE_TIMEOUT_MS);
  const audio = new Uint8Array(await result.audio.arrayBuffer());
  const boundaries = Array.isArray(result.subtitle) ? result.subtitle : [];
  const words: WordMark[] = boundaries.map((w) => ({
    text: w.text,
    startMs: w.offset / 1e4,
    endMs: (w.offset + w.duration) / 1e4,
  }));
  if (audio.byteLength === 0) throw new Error("La synthèse Edge n'a renvoyé aucun audio.");
  return {
    provider: "edge",
    model: "edge-tts",
    voice: chosen,
    mime: "audio/mpeg",
    audio,
    words: words.length ? words : null,
    costUsd: 0,
    ms: Date.now() - started,
    charCount: text.length,
  };
}

async function openrouterSynthesize(
  text: string,
  settings: Settings,
  model: TtsModel | undefined,
  signal?: AbortSignal,
): Promise<TtsResult> {
  const started = Date.now();
  const voice = settings.ttsVoice || defaultVoiceFor(model, settings.locale);
  const result = await speech({
    key: settings.openrouterKey,
    model: settings.ttsModel,
    input: text,
    voice: voice || undefined,
    signal,
  });
  return {
    provider: "openrouter",
    model: settings.ttsModel,
    voice,
    mime: result.mime,
    audio: result.audio,
    words: null,
    costUsd: ttsCostUsd(model, text.length),
    ms: Date.now() - started,
    charCount: text.length,
  };
}

export const LOCAL_TTS_URL = "http://127.0.0.1:8765";

async function localSynthesize(text: string, settings: Settings, voice: string, signal?: AbortSignal): Promise<TtsResult> {
  const started = Date.now();
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
  const res = await fetch(`${LOCAL_TTS_URL}/audio/speech`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: text, voice, language: settings.locale, exaggeration: settings.localExaggeration, speed: settings.ttsSpeed }), signal: bounded });
  if (!res.ok) throw new Error(`Chatterbox local ${res.status} : ${(await res.text()).slice(0, 300)}`);
  const audio = new Uint8Array(await res.arrayBuffer());
  if (!audio.length) throw new Error("Audio Chatterbox vide.");
  return { audio, mime: "audio/mpeg", provider: "local", model: "chatterbox-multilingual-v3", voice, words: null, costUsd: 0, ms: Date.now() - started, charCount: text.length };
}

export async function synthesize(text: string, settings: Settings, signal?: AbortSignal): Promise<TtsResult> {
  const clean = text.trim();
  if (!clean) throw new Error("Texte vide : rien à synthétiser.");
  if (settings.ttsProvider === "edge") {
    return edgeSynthesize(clean, settings.ttsVoice, settings.ttsSpeed, settings.locale, signal);
  }
  if (settings.ttsProvider === "local") return localSynthesize(clean, settings, /^host-[12]$/.test(settings.ttsVoice) ? settings.ttsVoice : "host-1", signal);
  const { tts } = await getModels();
  const model = tts.find((m) => m.id === settings.ttsModel);
  if (!model) {
    const err = new OrError(400, `Modèle TTS « ${settings.ttsModel} » introuvable dans le catalogue OpenRouter.`);
    throw err;
  }
  return openrouterSynthesize(clean, settings, model, signal);
}

/* ─────────────────────────── MP3 · durée exacte ───────────────────────────
 * Edge renvoie un MP3 CBR 24 kHz mono. Pour coller plusieurs répliques dans un
 * seul fichier, il faut connaître la durée exacte de chacune : on additionne les
 * trames plutôt que d'estimer au débit nominal (qui dérive de ~4 %). */

const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES = [
  [11025, 12000, 8000], // MPEG 2.5
  [0, 0, 0], // reserved
  [22050, 24000, 16000], // MPEG 2
  [44100, 48000, 32000], // MPEG 1
];

/** Duration in ms, computed by walking the MP3 frames. */
export function mp3DurationMs(bytes: Uint8Array): number {
  let i = 0;
  // Skip an ID3v2 tag if present.
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    i = Math.min(bytes.length, 10 + size);
  }
  let totalMs = 0;
  let frames = 0;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) {
      i += 1;
      continue;
    }
    const version = (bytes[i + 1] >> 3) & 0x03;
    const layer = (bytes[i + 1] >> 1) & 0x03;
    const bitrateIndex = (bytes[i + 2] >> 4) & 0x0f;
    const sampleIndex = (bytes[i + 2] >> 2) & 0x03;
    const padding = (bytes[i + 2] >> 1) & 0x01;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) {
      i += 1;
      continue;
    }
    const mpeg1 = version === 3;
    const bitrate = (mpeg1 ? BITRATE_V1_L3 : BITRATE_V2_L3)[bitrateIndex] * 1000;
    const sampleRate = SAMPLE_RATES[version][sampleIndex];
    if (!bitrate || !sampleRate) {
      i += 1;
      continue;
    }
    const samplesPerFrame = mpeg1 ? 1152 : 576;
    const frameLength = Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;
    if (frameLength < 24 || i + frameLength > bytes.length) break;
    totalMs += (samplesPerFrame / sampleRate) * 1000;
    frames += 1;
    i += frameLength;
  }
  // Safety net: if the parse looks wrong, fall back to the nominal 48 kbps rate.
  if (frames < 10 || totalMs <= 0) return Math.max(0, (bytes.length / 6000) * 1000);
  return totalMs;
}

export interface DialogueTurn {
  speakerIndex: number;
  name: string;
  text: string;
}

export interface DialogueResult extends Omit<TtsResult, "voice"> {
  voices: string[];
  turns: { speakerIndex: number; name: string; startMs: number; endMs: number; durationMs: number }[];
}

/** Voice used for a host, with a sensible default per language. */
export function hostVoice(settings: Settings, index: number): string {
  const host = settings.hosts?.[index];
  return host?.voice?.trim() || LOCALES[settings.locale].defaultEdgeVoice;
}

/** Runs tasks with a bounded concurrency, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Synthesises a multi-host bulletin: one call per reply, then a byte-level
 * concatenation, with word timings shifted onto the global timeline.
 */
export async function synthesizeDialogue(turns: DialogueTurn[], settings: Settings, signal?: AbortSignal): Promise<DialogueResult> {
  const started = Date.now();
  const { tts: catalogue } = await getModels();
  const model = settings.ttsProvider === "openrouter" ? catalogue.find((m) => m.id === settings.ttsModel) : undefined;
  const firstVoice = model ? (model.voices.includes(hostVoice(settings, 0)) ? hostVoice(settings, 0) : model.voices.includes(settings.ttsVoice) ? settings.ttsVoice : defaultVoiceFor(model, settings.locale)) : "";
  const secondVoice = model ? (model.voices.includes(hostVoice(settings, 1)) ? hostVoice(settings, 1) : defaultVoiceFor(model, settings.locale)) : "";

  const chunks = await mapLimit(turns, settings.ttsProvider === "local" ? 1 : 3, async (turn) => {
    const voice = settings.ttsProvider === "local" ? `host-${turn.speakerIndex + 1}` : settings.ttsProvider === "edge"
      ? hostVoice(settings, turn.speakerIndex)
      : turn.speakerIndex === 0 ? firstVoice : secondVoice;
    const run = async () => {
      if (settings.ttsProvider === "local") {
        const one = await localSynthesize(turn.text, settings, voice, signal);
        return { audio: one.audio, words: one.words, voice: one.voice, costUsd: 0, model: one.model };
      }
      if (settings.ttsProvider === "edge") {
        const one = await edgeSynthesize(turn.text, voice, settings.ttsSpeed, settings.locale, signal);
        return { audio: one.audio, words: one.words, voice: one.voice, costUsd: 0, model: "edge-tts" };
      }
      const one = await openrouterSynthesize(turn.text, { ...settings, ttsVoice: voice }, model, signal);
      return { audio: one.audio, words: one.words, voice: one.voice, costUsd: one.costUsd, model: settings.ttsModel };
    };
    try {
      return await run();
    } catch (err) {
      if (signal?.aborted) throw err;
      console.error(`[tts] réplique « ${turn.name} » en échec, nouvel essai:`, (err as Error).message);
      if (settings.ttsProvider === "edge" || !settings.ttsFallback) return await run();
      const backup = settings.ttsProvider === "openrouter" ? catalogue.find(m => m.id === settings.ttsFallbackModel && m.id !== settings.ttsModel) : undefined;
      if (backup) {
        try {
          const one = await openrouterSynthesize(turn.text, { ...settings, ttsModel: backup.id, ttsVoice: backup.voices[turn.speakerIndex] ?? defaultVoiceFor(backup, settings.locale) }, backup, signal);
          return { audio: one.audio, words: one.words, voice: one.voice, costUsd: one.costUsd, model: backup.id };
        } catch (backupError) {
          if (signal?.aborted) throw backupError;
          console.error("[tts] secours OpenRouter en échec:", (backupError as Error).message);
        }
      }
      const one = await edgeSynthesize(turn.text, LOCALES[settings.locale].fallbackVoices[turn.speakerIndex]?.id ?? LOCALES[settings.locale].defaultEdgeVoice, settings.ttsSpeed, settings.locale, signal);
      return { audio: one.audio, words: one.words, voice: one.voice, costUsd: 0, model: "edge-tts" };
    }
  });

  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.audio.byteLength, 0);
  const audio = new Uint8Array(totalBytes);
  const words: WordMark[] = [];
  const placed: DialogueResult["turns"] = [];
  let offsetBytes = 0;
  let offsetMs = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    audio.set(chunk.audio, offsetBytes);
    offsetBytes += chunk.audio.byteLength;
    const durationMs = mp3DurationMs(chunk.audio);
    for (const word of chunk.words ?? []) {
      words.push({ text: word.text, startMs: word.startMs + offsetMs, endMs: word.endMs + offsetMs });
    }
    placed.push({
      speakerIndex: turns[index].speakerIndex,
      name: turns[index].name,
      startMs: offsetMs,
      endMs: offsetMs + durationMs,
      durationMs,
    });
    offsetMs += durationMs;
  }
  // Each reply already carries Edge's natural leading/trailing silence, so the
  // concatenation keeps a believable breath between the two hosts.
  const charCount = turns.reduce((sum, turn) => sum + turn.text.length, 0);
  return {
    provider: chunks.every(c => c.model === "edge-tts") ? "edge" : settings.ttsProvider,
    model: [...new Set(chunks.map(c => c.model))].join(" + "),
    voices: [...new Set(chunks.map((c) => c.voice))],
    mime: "audio/mpeg",
    audio,
    words: chunks.every(c => c.words?.length) ? words : null,
    costUsd: chunks.reduce((sum, chunk) => sum + chunk.costUsd, 0),
    ms: Date.now() - started,
    charCount,
    turns: placed,
  };
}

export interface CompareRow {
  candidate: string;
  label: string;
  provider: string;
  model: string;
  voice: string;
  ok: boolean;
  ms: number;
  bytes: number;
  costUsd: number;
  costPer1k: number;
  free: boolean;
  approximate: boolean;
  words: number;
  /** Inline data URL so the UI can play the sample back. Optional: it is heavy. */
  audio?: string;
  error?: string;
}

function parseCandidate(candidate: string): { provider: "edge" | "openrouter"; model: string; voice: string } {
  if (candidate === "edge" || candidate.startsWith("edge:")) {
    return { provider: "edge", model: "edge-tts", voice: candidate.split(":")[1] ?? "" };
  }
  const model = candidate.startsWith("or:") ? candidate.slice(3) : candidate;
  return { provider: "openrouter", model, voice: "" };
}

/**
 * Runs the same sentence through several engines so the user can compare
 * latency, size and price for their own text.
 */
export async function compare(
  text: string,
  candidates: string[],
  settings: Settings,
  signal?: AbortSignal,
  includeAudio = false,
): Promise<CompareRow[]> {
  const { tts } = await getModels();
  const rows = await Promise.all(
    candidates.map(async (candidate): Promise<CompareRow> => {
      const parsed = parseCandidate(candidate);
      const model = parsed.provider === "openrouter" ? tts.find((m) => m.id === parsed.model) : undefined;
      const base: CompareRow = {
        candidate,
        label: parsed.provider === "edge" ? `Edge TTS (gratuit) — ${parsed.voice || settings.ttsVoice}` : model?.name ?? parsed.model,
        provider: parsed.provider,
        model: parsed.provider === "edge" ? "edge-tts" : parsed.model,
        voice: parsed.voice || (parsed.provider === "edge" ? settings.ttsVoice : defaultVoiceFor(model, settings.locale)),
        ok: false,
        ms: 0,
        bytes: 0,
        costUsd: 0,
        costPer1k: parsed.provider === "edge" ? 0 : model?.per1k ?? 0,
        free: parsed.provider === "edge" || (model?.free ?? false),
        approximate: model?.approximate ?? false,
        words: 0,
      };
      const started = Date.now();
      try {
        const result = parsed.provider === "edge"
          ? await edgeSynthesize(text, base.voice, settings.ttsSpeed, settings.locale, signal)
          : await synthesize(text, { ...settings, ttsProvider: "openrouter", ttsModel: parsed.model, ttsVoice: base.voice }, signal);
        return {
          ...base,
          ok: true,
          voice: result.voice,
          ms: Date.now() - started,
          bytes: result.audio.byteLength,
          costUsd: result.costUsd,
          costPer1k: parsed.provider === "edge" ? 0 : (model?.per1k ?? 0),
          words: result.words?.length ?? 0,
          audio: includeAudio ? `data:${result.mime};base64,${Buffer.from(result.audio).toString("base64")}` : undefined,
        };
      } catch (err) {
        return { ...base, ok: false, ms: Date.now() - started, error: (err as Error).message };
      }
    }),
  );
  return rows.sort((a, b) => a.costPer1k - b.costPer1k || a.ms - b.ms);
}
