/**
 * OpenRouter client: model catalogue (with pricing), chat completions and TTS.
 *
 * Everything is priced in USD and normalised to a per-1k-character figure so the
 * UI can rank TTS models by cost without knowing each provider's billing scheme.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHARS_PER_SECOND, DATA_DIR } from "./config";

const BASE = "https://openrouter.ai/api/v1";
const CACHE_FILE = join(DATA_DIR, "models.json");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Published Gemini TTS audio token rate, used to estimate token-billed speech cost. */
const AUDIO_TOKENS_PER_SECOND = 25;

export class OrError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail = "",
  ) {
    super(message);
    this.name = "OrError";
  }
}

export interface LlmModel {
  id: string;
  name: string;
  ctx: number;
  inPerM: number;
  outPerM: number;
  free: boolean;
  desc?: string;
}

export interface TtsModel {
  id: string;
  name: string;
  /** Estimated USD per 1000 characters of input text. */
  per1k: number;
  billed: "char" | "token" | "second";
  approximate: boolean;
  free: boolean;
  voices: string[];
}

interface RawModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: Record<string, string | number | undefined>;
  architecture?: { output_modalities?: string[] };
  supported_voices?: unknown;
}

interface Cache {
  fetchedAt: number;
  llm: LlmModel[];
  tts: TtsModel[];
}

let cache: Cache | null = null;
let inflight: Promise<Cache> | null = null;

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? "0"));
  return Number.isFinite(n) ? n : 0;
};

export function toTtsModel(raw: RawModel): TtsModel {
  const p = raw.pricing ?? {};
  const perChar = num(p.prompt);
  const perTokenOut = num(p.completion);
  const voices = Array.isArray(raw.supported_voices) ? raw.supported_voices.map(String) : [];
  const tokenBilled = perTokenOut > 0 && perChar < 0.0001;
  if (tokenBilled) {
    const seconds = 1000 / CHARS_PER_SECOND;
    const cost = (1000 / 4) * perChar + seconds * AUDIO_TOKENS_PER_SECOND * perTokenOut;
    return { id: raw.id, name: raw.name ?? raw.id, per1k: cost, billed: "token", approximate: true, free: cost === 0, voices };
  }
  const cost = perChar * 1000;
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    per1k: cost,
    billed: perChar > 0 ? "char" : "second",
    approximate: perChar === 0,
    free: cost === 0,
    voices,
  };
}

export function toLlmModel(raw: RawModel): LlmModel {
  const p = raw.pricing ?? {};
  const inPerM = num(p.prompt) * 1e6;
  const outPerM = num(p.completion) * 1e6;
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    ctx: num(raw.context_length),
    inPerM,
    outPerM,
    free: inPerM === 0 && outPerM === 0,
    desc: (raw.description ?? "").slice(0, 200),
  };
}

function readDiskCache(): Cache | null {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Cache;
    if (Array.isArray(parsed.llm) && Array.isArray(parsed.tts)) return parsed;
  } catch {
    /* no cache yet */
  }
  return null;
}

async function fetchModels(): Promise<Cache> {
  const get = async (kind: string): Promise<RawModel[]> => {
    const res = await fetch(`${BASE}/models?output_modalities=${kind}`, { headers: authHeaders(), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new OrError(res.status, `Impossible de lister les modèles OpenRouter (${res.status})`);
    const json = (await res.json()) as { data?: RawModel[] };
    return json.data ?? [];
  };
  const [text, speech] = await Promise.all([get("text"), get("speech")]);
  const llm = text
    .map(toLlmModel)
    .filter((m) => m.id && !m.id.startsWith("~") && m.inPerM >= 0 && m.outPerM >= 0)
    .sort((a, b) => a.inPerM - b.inPerM || a.id.localeCompare(b.id));
  const tts = speech.map(toTtsModel).filter(m => m.per1k >= 0).sort((a, b) => a.per1k - b.per1k || a.id.localeCompare(b.id));
  const fresh: Cache = { fetchedAt: Date.now(), llm, tts };
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    await Bun.write(CACHE_FILE, JSON.stringify(fresh));
  } catch (err) {
    console.error("[openrouter] cache write failed:", err);
  }
  return fresh;
}

/** Loads the catalogue once; refreshes when stale. Never throws on a network failure. */
export async function getModels(opts: { force?: boolean } = {}): Promise<Cache> {
  if (cache && !opts.force && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
  const cleanCache = (value: Cache): Cache => ({ ...value, llm: value.llm.filter(m => m.inPerM >= 0 && m.outPerM >= 0), tts: value.tts.filter(m => m.per1k >= 0) });
  if (inflight) return inflight;
  const stale = cache ?? readDiskCache();
  inflight = (async () => {
    try {
      cache = await fetchModels();
      return cache;
    } catch (err) {
      console.error("[openrouter] model fetch failed:", (err as Error).message);
      if (stale) {
        cache = cleanCache(stale);
        return cache;
      }
      cache = { fetchedAt: Date.now(), llm: [], tts: [] };
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function cachedModels(): Cache | null {
  return cache;
}

export function findTtsModel(models: TtsModel[], id: string): TtsModel | undefined {
  return models.find((m) => m.id === id);
}

export function ttsCostUsd(model: TtsModel | undefined, chars: number): number {
  if (!model) return 0;
  return model.per1k * (chars / 1000);
}

export function llmCostUsd(model: LlmModel | undefined, inTokens: number, outTokens: number): number {
  if (!model) return 0;
  return (inTokens / 1e6) * model.inPerM + (outTokens / 1e6) * model.outPerM;
}

function authHeaders(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY ?? "";
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function headers(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "http://localhost",
    "X-Title": "AI News Radio",
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); };
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Single retry for transient upstream failures (429/5xx). */
async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err instanceof OrError ? err.status : 0;
      const transient = status === 429 || status === 408 || status >= 500;
      if (attempt >= 1 || !transient) throw err;
      await sleep(1200 + Math.random() * 800, signal);
    }
  }
}

async function orFetch(path: string, key: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  if (!key) throw new OrError(401, "Clé OpenRouter manquante. Ouvrez les réglages et collez votre clé.");
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers(key), ...(init.headers ?? {}) }, signal: bounded });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    let message = `OpenRouter ${res.status}`;
    if (res.status === 401) message = "Clé OpenRouter invalide (401).";
    else if (res.status === 402) message = "Crédits OpenRouter insuffisants (402).";
    else if (res.status === 429) message = "Limite de débit OpenRouter atteinte (429).";
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: string } };
      if (parsed.error?.message) message = `${message} — ${parsed.error.message}`;
    } catch {
      /* not json */
    }
    throw new OrError(res.status, message, detail.slice(0, 600));
  }
  return res;
}

export interface ChatResult {
  text: string;
  inTokens: number;
  outTokens: number;
  costUsd: number;
  model: string;
}

export async function chat(opts: {
  key: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  signal?: AbortSignal;
  models?: LlmModel[];
}): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 900,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  if (/tencent\/hy3/.test(opts.model)) body.reasoning = { effort: "none" };
  const res = await withRetry(
    () => orFetch("/chat/completions", opts.key, { method: "POST", body: JSON.stringify(body) }, opts.signal),
    opts.signal,
  );
  const json = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_cost?: number };
  };
  const raw = json.choices?.[0]?.message?.content;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text ?? "")).join("") : "";
  if (!text.trim()) throw new OrError(502, "Réponse vide du modèle.");
  const inTokens = json.usage?.prompt_tokens ?? 0;
  const outTokens = json.usage?.completion_tokens ?? 0;
  const reported = num(json.usage?.total_cost);
  const costUsd = reported > 0 ? reported : llmCostUsd(findLlm(opts.models, opts.model), inTokens, outTokens);
  return { text, inTokens, outTokens, costUsd, model: opts.model };
}

function findLlm(models: LlmModel[] | undefined, id: string): LlmModel | undefined {
  return models?.find((m) => m.id === id);
}

export async function speech(opts: {
  key: string;
  model: string;
  input: string;
  voice?: string;
  speed?: number;
  signal?: AbortSignal;
}): Promise<{ audio: Uint8Array<ArrayBuffer>; mime: string }> {
  const body: Record<string, unknown> = { model: opts.model, input: opts.input, response_format: "mp3" };
  if (opts.voice) body.voice = opts.voice;
  const res = await withRetry(
    () => orFetch("/audio/speech", opts.key, { method: "POST", body: JSON.stringify(body) }, opts.signal),
    opts.signal,
  );
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new OrError(502, "Audio vide reçu depuis OpenRouter.");
  return { audio: buf, mime: res.headers.get("content-type") ?? "audio/mpeg" };
}

/** Cheap key validity probe used by the settings panel. */
export async function checkKey(key: string): Promise<{ ok: boolean; message: string }> {
  if (!key) return { ok: false, message: "Aucune clé fournie." };
  try {
    // Bounded like every other OpenRouter call: without a timeout a hanging
    // network left the « Tester » button spinning forever.
    const res = await fetch(`${BASE}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    if (res.status === 401) return { ok: false, message: "Clé invalide (401)." };
    if (!res.ok) return { ok: false, message: `OpenRouter a répondu ${res.status}.` };
    const json = (await res.json()) as { data?: { label?: string; usage?: number; limit?: number | null } };
    const d = json.data ?? {};
    const limit = d.limit == null ? "illimité" : `$${d.limit}`;
    return { ok: true, message: `Clé valide (${d.label ?? "sans nom"}) — usage $${(d.usage ?? 0).toFixed(4)} / limite ${limit}.` };
  } catch (err) {
    const reason = (err as Error).name === "TimeoutError" ? "délai dépassé" : (err as Error).message;
    return { ok: false, message: `Réseau: ${reason}` };
  }
}
