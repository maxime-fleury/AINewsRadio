/**
 * HTTP API. Every handler returns JSON except the audio and preview endpoints.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { slugify } from "./archive";
import { digestSince, generateDigest, readSavedDigest } from "./digest";
import { buildPodcastFeed } from "./feed";
import { clearMemory, forgetStory, memorySummary, playedToday } from "./memory";
import { APP_NAME, CADENCE_OPTIONS, DEFAULT_HOSTS, DUO_PRESETS, FEED_PRESETS, isMusicFile, LOCALES, musicMime, musicMoodFile, MUSIC_MOODS, normalizeTemplate, PERSONA_TEMPLATE_IDS, PERSONA_TEMPLATES, PREFERRED_LLM_MODELS, SHOWS_DIR, THEMES, THEME_GROUPS, templateIdsInUse, TTS_PRESET_MODELS, type Locale, type MusicMood, type PersonaTemplate, type Settings } from "./config";
import { checkKey, getModels, type LlmModel, type TtsModel } from "./openrouter";
import { acknowledgePlayed, clearAll, forgetSegment, getAudio, getHistory, getStats, planSegment, renderSegment, type Segment } from "./radio";
import { getSettings, publicSettings, updateSettings } from "./settings";
import { deleteShow, listDays, listShows, showPath } from "./shows";
import { compare, defaultVoiceFor, edgeVoices, hostVoice, LOCAL_TTS_URL, synthesize, type AudioBytes } from "./tts";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const MUSIC_DIR = join(PUBLIC_DIR, "music");

const json = (data: unknown, status = 200): Response => Response.json(data as Record<string, unknown>, { status });

export function fail(message: string, status = 400, detail?: string): Response {
  return json({ error: message, detail }, status);
}

class HttpError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** decodeURIComponent qui ne casse pas la requête sur un pourcentage mal formé. */
function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError("Corps de requête JSON invalide.");
  }
}

/** Aligns the configured models with the live catalogue (first run, or stale settings). */
export async function ensureModelDefaults(): Promise<void> {
  const { llm, tts } = await getModels();
  if (!llm.length && !tts.length) return;
  const settings = getSettings();
  const patch: Record<string, unknown> = {};
  if (llm.length && !llm.some((m) => m.id === settings.llmModel)) {
    const preferred = PREFERRED_LLM_MODELS.find((id) => llm.some((m) => m.id === id));
    patch.llmModel = preferred ?? llm.find((m) => !m.free)?.id ?? llm[0].id;
  }
  // Le modèle rapide disparu du catalogue : retour silencieux au modèle de rédaction.
  if (llm.length && settings.llmModelFast && !llm.some((m) => m.id === settings.llmModelFast)) {
    patch.llmModelFast = "";
  }
  if (tts.length && !tts.some((m) => m.id === settings.ttsModel)) {
    patch.ttsModel = TTS_PRESET_MODELS.find((id) => tts.some((m) => m.id === id)) ?? tts.find((m) => m.free)?.id ?? tts[0].id;
  }
  if (Object.keys(patch).length) updateSettings(patch);
}

function fmtModels<T extends LlmModel | TtsModel>(list: T[], q: string, limit: number): T[] {
  if (!q) return list.slice(0, limit);
  const needle = q.toLowerCase();
  return list.filter((m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle)).slice(0, limit);
}

function sourceReport() {
  return {
    feeds: FEED_PRESETS,
    locales: Object.entries(LOCALES).map(([id, l]) => ({ id, label: l.label })),
    cadenceOptions: CADENCE_OPTIONS,
    ttsPresets: TTS_PRESET_MODELS,
    themes: THEMES,
    themeGroups: THEME_GROUPS,
    // Ambiances du fond musical : l'interface construit son menu avec ces ids,
    // les libellés venant des clés i18n « music.mood.<id> ».
    musicMoods: ["aucun", ...MUSIC_MOODS.map((mood) => mood.id)],
    hostDefaults: DEFAULT_HOSTS,
    // Gabarits fournis + gabarits persos enregistrés dans les réglages.
    personaTemplates: allTemplates(),
    duoPresets: DUO_PRESETS,
    showsDir: SHOWS_DIR,
  };
}

const customTemplates = (): PersonaTemplate[] => getSettings().customTemplates ?? [];

const allTemplates = (): PersonaTemplate[] => [...PERSONA_TEMPLATES, ...customTemplates()];

/** Handles "dernière info" / "Dernière info" gracefully when generating an id. */
function templateIdFor(label: string, taken: string[]): string {
  const base = slugify(label) || "gabarit";
  const used = new Set(taken);
  let id = base;
  for (let i = 2; used.has(id) && i < 50; i += 1) id = `${base}-${i}`;
  return id;
}

export async function handleApi(req: Request, url: URL): Promise<Response | null> {
  const { pathname } = url;
  // Le flux podcast est public et vit à la racine, comme un vrai podcast.
  const isFeed = pathname === "/feed.xml" || pathname === "/podcast.xml";
  if (!isFeed && !pathname.startsWith("/api/")) return null;
  const method = req.method.toUpperCase();

  try {
    if (pathname === "/api/state" && method === "GET") {
      const settings = getSettings();
      const { llm, tts, fetchedAt } = await getModels();
      const voices = await edgeVoices(settings.locale as Locale).catch(() => []);
      const llmModel = llm.find((m) => m.id === settings.llmModel);
      const ttsModel = tts.find((m) => m.id === settings.ttsModel);
      return json({
        app: APP_NAME,
        settings: publicSettings(),
        stats: getStats(),
        history: getHistory(24),
        models: {
          fetchedAt,
          llmCount: llm.length,
          ttsCount: tts.length,
          llmModel: llmModel ?? null,
          ttsModel: ttsModel ?? null,
          llmFreeCount: llm.filter((m) => m.free).length,
        },
        voices,
        hostVoices: [hostVoice(settings, 0), hostVoice(settings, 1)],
        defaultOpenRouterVoice: defaultVoiceFor(ttsModel, settings.locale as Locale),
        archivedCount: getHistory(500).filter((segment) => segment.archive).length,
        // Histoires déjà passées à l'antenne aujourd'hui (mémoire éditoriale),
        // et la liste elle-même : l'onglet Sources permet d'en oublier une seule.
        memory: memorySummary(),
        played: playedToday(),
        // Émissions réellement présentes sur le disque (compteur du bouton « Replay »).
        archivedOnDisk: listDays().reduce((total, entry) => total + entry.count, 0),
        customTemplates: customTemplates(),
        ...sourceReport(),
      });
    }

    /* ─────────────────── flux podcast ─────────────────── */

    if (isFeed && (method === "GET" || method === "HEAD")) {
      const { xml, count } = buildPodcastFeed(new URL(req.url).origin, getSettings().locale);
      return new Response(method === "HEAD" ? null : new Blob([xml], { type: "application/rss+xml; charset=utf-8" }), {
        headers: {
          "content-type": "application/rss+xml; charset=utf-8",
          "cache-control": "no-store",
          "x-show-count": String(count),
        },
      });
    }

    /* ─────────────────── mémoire longue : récapitulatif ─────────────────── */

    if (pathname === "/api/digest" && method === "GET") {
      const days = Number(url.searchParams.get("days") ?? 7);
      return json({ ...digestSince(days), saved: readSavedDigest(days) });
    }

    if (pathname === "/api/digest" && method === "POST") {
      const body = await readJson<{ days?: number }>(req);
      if (!getSettings().openrouterKey) throw new HttpError("Le récapitulatif nécessite une clé OpenRouter.");
      return json(await generateDigest(body.days ?? 7, getSettings(), req.signal));
    }

    if (pathname === "/api/memory" && method === "DELETE") {
      return json({ cleared: clearMemory(), memory: memorySummary(), played: playedToday() });
    }

    // Oublier une seule histoire : elle seule pourra revenir à l'antenne.
    if (pathname === "/api/memory/story" && method === "DELETE") {
      const title = url.searchParams.get("title") ?? "";
      const at = url.searchParams.get("at") ?? "";
      if (!title.trim() || !at.trim()) throw new HttpError("Titre et horodatage de l'histoire requis pour l'oublier.");
      return json({ removed: forgetStory(title, at), memory: memorySummary(), played: playedToday() });
    }

    /* ─────────────────── replay : émissions archivées ─────────────────── */

    if (pathname === "/api/shows" && method === "GET") {
      const day = url.searchParams.get("day") ?? undefined;
      return json({ ...listShows(day ?? undefined), showsDir: SHOWS_DIR });
    }

    if (pathname.startsWith("/api/shows/") && (method === "GET" || method === "HEAD")) {
      const rest = pathname.slice("/api/shows/".length);
      const slash = rest.indexOf("/");
      if (slash < 0) return fail("Chemin d'archive invalide.", 400);
      const day = decodePath(rest.slice(0, slash));
      const file = decodePath(rest.slice(slash + 1));
      if (!day || !file) return fail("Chemin d'archive invalide.", 400);
      const path = showPath(day, file);
      if (!path) return fail("Émission archivée introuvable.", 404);
      // Lu et découpé sur le disque : le fichier entier ne passe jamais par la mémoire.
      const size = statSync(path).size;
      return fileResponse(path, size, "audio/mpeg", req);
    }

    if (pathname.startsWith("/api/shows/") && method === "DELETE") {
      const rest = pathname.slice("/api/shows/".length);
      const slash = rest.indexOf("/");
      if (slash < 0) return fail("Chemin d'archive invalide.", 400);
      const day = decodePath(rest.slice(0, slash));
      const file = decodePath(rest.slice(slash + 1));
      if (!day || !file) return fail("Chemin d'archive invalide.", 400);
      const deleted = deleteShow(day, file);
      if (!deleted) return fail("Émission archivée introuvable.", 404);
      // La console ne garde pas une carte dont l'audio n'existe plus.
      forgetSegment(deleted.id);
      return json({ deleted, ...listShows(url.searchParams.get("day") || deleted.day) });
    }

    /* ─────────────────── gabarits de présentateurs ─────────────────── */

    if (pathname === "/api/templates" && method === "POST") {
      const body = await readJson<Record<string, unknown>>(req);
      const patch = { ...body };
      const existing = customTemplates();
      const requested = String(body.id ?? "").toLowerCase();
      const isUpdate = requested && existing.some((tpl) => tpl.id === requested);
      if (requested && !isUpdate && PERSONA_TEMPLATE_IDS.has(requested)) {
        throw new HttpError(`« ${requested} » est un gabarit fourni : choisis un autre nom.`);
      }
      if (!isUpdate) patch.id = templateIdFor(String(body.label ?? body.id ?? ""), templateIdsInUse(existing));
      const template = normalizeTemplate(patch);
      if (!template) throw new HttpError("Gabarit incomplet : un libellé et au moins un prénom sont nécessaires.");
      const next = isUpdate
        ? existing.map((tpl) => (tpl.id === template.id ? template : tpl))
        : [...existing, template];
      updateSettings({ customTemplates: next });
      return json({ template, templates: customTemplates(), personaTemplates: allTemplates() });
    }

    if (pathname.startsWith("/api/templates/") && method === "DELETE") {
      const id = decodePath(pathname.slice("/api/templates/".length));
      if (!id) return fail("Identifiant de gabarit invalide.", 400);
      const existing = customTemplates();
      if (!existing.some((tpl) => tpl.id === id)) throw new HttpError("Gabarit introuvable.", 404);
      updateSettings({ customTemplates: existing.filter((tpl) => tpl.id !== id) });
      return json({ deleted: id, templates: customTemplates(), personaTemplates: allTemplates() });
    }

    /* ─────────────────── import / export de l'équipe ─────────────────── */

    if (pathname === "/api/team/export" && method === "GET") {
      const settings = getSettings();
      const payload = {
        kind: "ai-news-radio/team",
        version: 1,
        app: APP_NAME,
        exportedAt: new Date().toISOString(),
        locale: settings.locale,
        hostCount: settings.hostCount,
        hosts: settings.hosts,
        listener: settings.listener,
        templates: customTemplates(),
      };
      const name = `equipe-ai-news-radio-${new Date().toISOString().slice(0, 10)}.json`;
      return new Response(JSON.stringify(payload, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${name}"`,
          "cache-control": "no-store",
        },
      });
    }

    if (pathname === "/api/team/import" && method === "POST") {
      const body = await readJson<Record<string, unknown>>(req);
      const source = (body.team && typeof body.team === "object" ? body.team : body) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      let hosts = 0;
      if (Array.isArray(source.hosts)) {
        const list = (source.hosts as unknown[]).filter((h): h is Record<string, unknown> => !!h && typeof h === "object");
        if (list.length) {
          patch.hosts = list;
          hosts = Math.min(list.length, 2);
        }
      }
      if (source.listener && typeof source.listener === "object") patch.listener = source.listener;
      if (source.locale === "fr" || source.locale === "en") patch.locale = source.locale;
      if (source.hostCount === 1 || source.hostCount === 2) patch.hostCount = source.hostCount;

      const existing = customTemplates();
      const importedTemplates: PersonaTemplate[] = [];
      if (Array.isArray(source.templates)) {
        for (const raw of source.templates as unknown[]) {
          const template = normalizeTemplate(raw);
          if (!template || PERSONA_TEMPLATE_IDS.has(template.id)) continue;
          importedTemplates.push(template);
        }
      }
      const merged = [...existing];
      let replaced = 0;
      for (const template of importedTemplates) {
        const index = merged.findIndex((tpl) => tpl.id === template.id);
        if (index >= 0) {
          merged[index] = template;
          replaced += 1;
        } else {
          merged.push(template);
        }
      }
      if (importedTemplates.length) patch.customTemplates = merged;
      if (!Object.keys(patch).length) throw new HttpError("Fichier d'équipe vide : aucune équipe ni gabarit reconnu.");
      updateSettings(patch);
      const imported = { hosts, listener: !!patch.listener, templates: importedTemplates.length, replaced };
      return json({ settings: publicSettings(), personaTemplates: allTemplates(), imported });
    }

    if (pathname === "/api/locale" && method === "GET") {
      // Les pages légères (Replay, Récap) doivent suivre la langue de l'émission
      // sans charger tout /api/state (catalogue, voix, historique).
      return json({ locale: getSettings().locale });
    }

    if (pathname === "/api/models" && method === "GET") {
      const kind = url.searchParams.get("kind") ?? "tts";
      const q = url.searchParams.get("q") ?? "";
      const force = url.searchParams.get("force") === "1";
      const { llm, tts, fetchedAt } = await getModels({ force });
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 1000) || 1000));
      return json({
        fetchedAt,
        llm: kind === "tts" ? [] : fmtModels(llm, q, limit),
        tts: kind === "llm" ? [] : fmtModels(tts, q, limit),
      });
    }

    if (pathname === "/api/settings" && method === "POST") {
      const patch = await readJson<Record<string, unknown>>(req);
      const next = updateSettings(patch);
      const voices = patch.locale ? await edgeVoices(next.locale as Locale).catch(() => []) : [];
      return json({ settings: publicSettings(), voices });
    }

    if (pathname === "/api/settings/check" && method === "POST") {
      const body = await readJson<{ key?: string }>(req);
      const key = body.key?.trim() || getSettings().openrouterKey;
      return json(await checkKey(key));
    }

    if (pathname === "/api/voices" && method === "GET") {
      const locale = (url.searchParams.get("locale") ?? getSettings().locale) as Locale;
      return json({ locale, voices: await edgeVoices(locale, url.searchParams.get("force") === "1").catch(() => []) });
    }

    if (pathname === "/api/music" && method === "GET") {
      // Fonds musicaux : ils comblent le silence quand le tampon est vide (voir
      // cycleIntro dans public/js/app.js). Jamais mixés dans l'audio archivé — la
      // lecture reste purement locale, sous la voix.
      return json(musicReport());
    }

    if (pathname === "/api/music/file" && (method === "GET" || method === "HEAD")) {
      return musicFileResponse(url.searchParams.get("name") ?? "", req);
    }

    if (pathname === "/api/segment/plan" && method === "POST") {
      const body = await readJson<{ mode?: string; topic?: string; question?: string; context?: Parameters<typeof planSegment>[0]["context"]; prepared?: Parameters<typeof planSegment>[0]["prepared"] }>(req);
      const mode = body.mode === "question" ? "question" : body.mode === "debate" ? "debate" : "news";
      if (mode === "question" && !body.question?.trim()) throw new HttpError("Question vide.");
      if (mode === "debate" && !body.question?.trim() && !body.topic?.trim()) {
        throw new HttpError("Choisis un sujet ou une question pour le débat.");
      }
      const segment = await planSegment({ mode, topic: body.topic, question: body.question, context: body.context, prepared: body.prepared }, getSettings(), req.signal);
      return json({ segment });
    }

    if (pathname === "/api/segment/played" && method === "POST") {
      const body = await readJson<{ id?: string; chars?: number; complete?: boolean }>(req);
      if (typeof body.id !== "string" || typeof body.chars !== "number" || !Number.isFinite(body.chars)) throw new HttpError("Segment et position requis.");
      // Cette route est appelée à chaque progression de lecture : la liste des
      // histoires du jour n'est renvoyée que lorsqu'une histoire vient d'entrer
      // en mémoire, sinon la réponse resterait la plus lourde du direct.
      const marked = acknowledgePlayed(body.id, body.chars, body.complete === true, getSettings());
      return json({ marked, memory: memorySummary(), played: marked ? playedToday() : undefined });
    }

    if (pathname === "/api/segment/render" && method === "POST") {
      const body = await readJson<{ id?: string }>(req);
      if (!body.id) throw new HttpError("Champ « id » manquant.");
      const segment = await renderSegment(body.id, getSettings(), req.signal);
      return json({ segment });
    }

    if (pathname.startsWith("/api/audio/") && (method === "GET" || method === "HEAD")) {
      const id = pathname.slice("/api/audio/".length);
      const found = getAudio(id);
      if (!found) return fail("Audio introuvable ou évincé du cache.", 404);
      return audioResponse(found.bytes, found.mime, req);
    }

    if (pathname === "/api/tts/intro" && method === "POST") {
      const body = await readJson<{ topic?: string; title?: string }>(req);
      const settings = getSettings();
      const title = String(body.title || body.topic || "le prochain sujet").replace(/[<>]/g, "").slice(0, 180);
      const text = settings.locale === "fr" ? `Dans ce prochain passage, nous allons parler de ${title}. On prépare la suite pour toi.` : `Coming up, we will talk about ${title}. Your next segment is being prepared.`;
      const result = await synthesize(text, { ...settings, ttsProvider: "edge", ttsVoice: LOCALES[settings.locale].defaultEdgeVoice }, req.signal);
      return new Response(new Blob([result.audio]), { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
    }

    if (pathname === "/api/tts/local" && method === "GET") {
      try {
        const res = await fetch(`${LOCAL_TTS_URL}/health`, { signal: AbortSignal.timeout(2500) });
        return json(await res.json());
      } catch { return json({ ready: false, error: "Serveur local absent : lance le script tts:local." }); }
    }
    if (pathname.startsWith("/api/tts/local/voices/") && method === "PUT") {
      const voice = pathname.slice("/api/tts/local/voices/".length);
      if (!/^host-[12]$/.test(voice)) throw new HttpError("Voix locale invalide.");
      const bytes = await req.arrayBuffer();
      if (bytes.byteLength > 10_000_000) throw new HttpError("Référence limitée à 10 Mo.", 413);
      const res = await fetch(`${LOCAL_TTS_URL}/voices/${voice}`, { method: "PUT", body: bytes, signal: AbortSignal.timeout(30000) });
      return json(await res.json(), res.status);
    }

    if (pathname === "/api/tts/preview" && method === "POST") {
      const body = await readJson<{ text?: string; voice?: string }>(req);
      const settings = getSettings();
      const text = (body.text ?? "").slice(0, 400) ||
        (settings.locale === "fr" ? "Bonjour, ceci est un aperçu de la voix de votre radio." : "Hello, this is a preview of your radio voice.");
      // The preview speaks with the first host's voice.
      const result = await synthesize(text, { ...settings, ttsVoice: settings.ttsProvider === "local" ? body.voice || "host-1" : settings.ttsProvider === "edge" ? hostVoice(settings, 0) : settings.ttsVoice }, req.signal);
      return new Response(new Blob([result.audio]), {
        headers: {
          "content-type": result.mime,
          "cache-control": "no-store",
          "x-tts-provider": result.provider,
          "x-tts-voice": result.voice,
          "x-tts-cost-usd": String(result.costUsd),
        },
      });
    }

    if (pathname === "/api/tts/compare" && method === "POST") {
      const body = await readJson<{ text?: string; candidates?: string[]; audio?: boolean }>(req);
      const settings = getSettings();
      const { tts } = await getModels();
      const fallback = [settings.ttsModel, ...TTS_PRESET_MODELS].filter((id, i, arr) => id && arr.indexOf(id) === i).slice(0, 4);
      const hostVoices = [`edge:${hostVoice(settings, 0)}`, `edge:${hostVoice(settings, 1)}`];
      const requested = body.candidates?.length ? body.candidates : [...hostVoices, ...fallback.map((m) => `or:${m}`)];
      const candidates = [...new Set(requested)];
      const text = (body.text ?? "").trim() ||
        (settings.locale === "fr"
          ? "Le trafic est dense sur la ligne B, et la météo annonce des averses en fin de journée."
          : "Traffic is heavy on the metro, and showers are expected later today.");
      const rows = await compare(text.slice(0, 400), candidates.slice(0, 9), settings, req.signal, body.audio === true);
      return json({ text, rows, ttsCount: tts.length });
    }

    if (pathname === "/api/reset" && method === "POST") {
      clearAll();
      return json({ ok: true, stats: getStats() });
    }

    return fail(`Route inconnue: ${method} ${pathname}`, 404);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return fail("Requête annulée.", 499);
    const status = err instanceof HttpError ? err.status : (err as { status?: number }).status ?? 500;
    const message = (err as Error).message || "Erreur inconnue";
    console.error(`[api] ${method} ${pathname} → ${status}:`, message, (err as { detail?: string }).detail ?? "");
    return fail(message, status, (err as { detail?: string }).detail);
  }
}

/**
 * Pistes à jouer pour le fond musical : celles du dossier choisi par l'auditeur
 * s'il y en a un, sinon les ambiances livrées avec l'app, filtrées sur son type
 * de musique. Les chemins renvoyés sont des URL prêtes pour un <audio>.
 */
export function musicReport(settings: Pick<Settings, "musicMood" | "musicFolder"> = getSettings()): { tracks: string[]; mood: MusicMood; source: "folder" | "builtin" | "none"; folder: string; error?: "unreadable" } {
  const { musicMood, musicFolder } = settings;
  const folder = musicFolder.trim();
  if (musicMood === "aucun") return { tracks: [], mood: musicMood, source: "none", folder };
  if (folder) {
    try {
      const tracks = readdirSync(resolve(folder), { withFileTypes: true })
        .filter((entry) => entry.isFile() && isMusicFile(entry.name))
        .map((entry) => entry.name)
        .sort()
        .map((name) => `/api/music/file?name=${encodeURIComponent(name)}`);
      return { tracks, mood: musicMood, source: "folder", folder };
    } catch {
      return { tracks: [], mood: musicMood, source: "folder", folder, error: "unreadable" };
    }
  }
  let names: string[] = [];
  try {
    names = readdirSync(MUSIC_DIR).filter(isMusicFile).sort();
  } catch {
    /* dossier absent : ce n'est pas une erreur, il n'y a simplement rien à jouer */
  }
  // L'ambiance demandée d'abord ; si elle n'est pas installée (l'auditeur a déposé
  // ses propres pistes dans public/music/), on joue ce qu'il y a plutôt que rien.
  const wanted = musicMoodFile(musicMood);
  const matching = wanted ? names.filter((name) => name === wanted) : [];
  const chosen = matching.length ? matching : names;
  return { tracks: chosen.map((name) => `/music/${encodeURIComponent(name)}`), mood: musicMood, source: "builtin", folder: "" };
}

/** Une piste du dossier choisi par l'auditeur, servie avec le support des plages. */
function musicFileResponse(name: string, req: Request): Response {
  const folder = getSettings().musicFolder.trim();
  if (!folder) return fail("Aucun dossier de musique n'est configuré.", 404);
  // Un nom de fichier seul : ni chemin, ni remontée, ni fichier caché.
  if (!name || name !== basename(name) || name.includes("\\") || name.startsWith(".") || !isMusicFile(name)) {
    return fail("Nom de piste invalide.", 400);
  }
  const path = join(resolve(folder), name);
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return fail("Piste introuvable.", 404);
    size = stat.size;
  } catch {
    return fail("Piste introuvable.", 404);
  }
  return fileResponse(path, size, musicMime(name), req);
}

/** Byte-range aware response for a file on disk, without reading it into memory. */
function fileResponse(path: string, size: number, mime: string, req: Request): Response {
  const file = Bun.file(path);
  const base: Record<string, string> = {
    "content-type": mime,
    "accept-ranges": "bytes",
    // Une archive peut être supprimée depuis le replay : on ne la met pas en cache.
    "cache-control": "no-store",
  };
  const range = req.headers.get("range");
  const match = range?.match(/bytes=(\d*)-(\d*)/);
  if (match && range) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (Number.isNaN(start) || start >= size || start > end) {
      return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
    }
    return new Response(req.method === "HEAD" ? null : file.slice(start, end + 1), {
      status: 206,
      headers: { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(req.method === "HEAD" ? null : file, { headers: { ...base, "content-length": String(size) } });
}

/** Byte-range aware audio response so the <audio> element can seek. */
function audioResponse(bytes: AudioBytes, mime: string, req: Request): Response {
  const total = bytes.byteLength;
  const base: Record<string, string> = {
    "content-type": mime,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
  };
  const range = req.headers.get("range");
  const match = range?.match(/bytes=(\d*)-(\d*)/);
  if (match && range) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (Number.isNaN(start) || start >= total || start > end) {
      return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${total}` } });
    }
    const slice = bytes.slice(start, end + 1);
    return new Response(req.method === "HEAD" ? null : new Blob([slice]), {
      status: 206,
      headers: { ...base, "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(slice.byteLength) },
    });
  }
  return new Response(req.method === "HEAD" ? null : new Blob([bytes]), { headers: { ...base, "content-length": String(total) } });
}

export async function serveStatic(pathname: string, method = "GET"): Promise<Response | null> {
  if (method !== "GET" && method !== "HEAD") return null;
  let rel: string;
  try {
    rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.replace(/^\/+/, ""));
  } catch {
    return null; // pourcentage mal formé : traité comme un fichier introuvable
  }
  if (!rel || rel.includes("..") || rel.startsWith(".")) return null;
  const file = Bun.file(join(PUBLIC_DIR, rel));
  if (!(await file.exists())) return null;
  return new Response(file);
}

export type { Segment };
