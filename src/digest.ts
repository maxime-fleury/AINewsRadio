/**
 * Mémoire longue : agrège les émissions archivées sur N jours (sujets les plus
 * traités, médias les plus cités, volume d'antenne) et rédige un récapitulatif
 * « cette semaine à l'antenne » avec le modèle rapide.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, LOCALES, themeFor, type Locale, type Settings } from "./config";
import { extractJson } from "./llm";
import { chat, getModels, OrError } from "./openrouter";
import { listDays, listShows, type ShowEntry } from "./shows";

const FILE = join(DATA_DIR, "digest.json");
const MAX_SHOWS = 400;
/** Au-delà, le prompt devient gros pour rien : on ne garde que les plus récents. */
const PROMPT_SHOWS = 120;

export interface DigestShow {
  id: string;
  clock: string;
  title: string;
  kind: ShowEntry["kind"];
  topic: string;
  durationSec: number;
}

export interface DigestDay {
  day: string;
  count: number;
  shows: DigestShow[];
}

export interface DigestRank {
  label: string;
  count: number;
}

export interface Digest {
  days: number;
  from: string;
  to: string;
  totals: {
    shows: number;
    bulletins: number;
    questions: number;
    debates: number;
    fromMemory: number;
    durationSec: number;
    costUsd: number;
    sources: number;
  };
  topics: DigestRank[];
  sources: DigestRank[];
  byDay: DigestDay[];
}

export interface SavedDigest {
  at: string;
  days: number;
  text: string;
  model: string;
  costUsd: number;
  shows: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

const shiftDay = (day: string, delta: number): string => {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + delta);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const clampDays = (value: unknown): number => {
  const days = Math.round(Number(value));
  return Number.isFinite(days) ? Math.min(90, Math.max(1, days)) : 7;
};

/** Agrège une liste d'émissions. Fonction pure : testable sans disque. */
export function summarize(shows: ShowEntry[], days: number): Digest {
  const topics = new Map<string, number>();
  const sources = new Map<string, number>();
  const byDay = new Map<string, DigestShow[]>();
  const totals: Digest["totals"] = {
    shows: 0, bulletins: 0, questions: 0, debates: 0, fromMemory: 0, durationSec: 0, costUsd: 0, sources: 0,
  };
  for (const show of shows) {
    totals.shows += 1;
    if (show.kind === "question") totals.questions += 1;
    else if (show.kind === "debate") totals.debates += 1;
    else totals.bulletins += 1;
    if (show.knowledge) totals.fromMemory += 1;
    totals.durationSec += Number.isFinite(show.durationSec) ? show.durationSec : 0;
    totals.costUsd += Number.isFinite(show.costUsd) ? show.costUsd : 0;
    totals.sources += Number.isFinite(show.sourceCount) ? show.sourceCount : 0;
    const label = themeFor(show.topic)?.label || show.topic || (show.kind === "question" ? "Questions libres" : "Sans rubrique");
    topics.set(label, (topics.get(label) ?? 0) + 1);
    for (const source of show.sources ?? []) {
      const name = source.source || "source";
      sources.set(name, (sources.get(name) ?? 0) + 1);
    }
    const list = byDay.get(show.day) ?? [];
    list.push({ id: show.id, clock: show.clock, title: show.title, kind: show.kind, topic: show.topic, durationSec: show.durationSec });
    byDay.set(show.day, list);
  }
  const rank = (map: Map<string, number>): DigestRank[] =>
    [...map.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, 12);
  const daysList: DigestDay[] = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, list]) => ({ day, count: list.length, shows: list.sort((a, b) => b.clock.localeCompare(a.clock)) }));
  const dates = shows.map((show) => show.day).sort();
  return { days, from: dates[0] ?? "", to: dates[dates.length - 1] ?? "", totals, topics: rank(topics), sources: rank(sources), byDay: daysList };
}

/** Émissions des N derniers jours (à partir du jour le plus récent archivé). */
export function digestSince(days: number): Digest {
  const requested = clampDays(days);
  const newest = listDays()[0]?.day;
  const shows: ShowEntry[] = [];
  if (newest) {
    const from = shiftDay(newest, -(requested - 1));
    for (const entry of listDays()) {
      if (entry.day < from || entry.day > newest) continue;
      if (shows.length >= MAX_SHOWS) break;
      shows.push(...listShows(entry.day).shows);
    }
  }
  return summarize(shows, requested);
}

const kindLabel = (locale: Locale, kind: ShowEntry["kind"]): string =>
  locale === "fr"
    ? kind === "question" ? "question" : kind === "debate" ? "débat" : "bulletin"
    : kind === "question" ? "listener question" : kind === "debate" ? "debate" : "bulletin";

export function digestPrompt(digest: Digest, locale: Locale): { system: string; user: string } {
  const lines = digest.byDay
    .flatMap((day) => day.shows.map((show) => ({ day: day.day, show })))
    .slice(0, PROMPT_SHOWS)
    .map(({ day, show }) => {
      const media = show.topic ? ` · rubrique ${show.topic}` : "";
      return `- ${day} [${kindLabel(locale, show.kind)}] ${show.title}${media}`;
    })
    .join("\n");
  const totals = digest.totals;
  if (locale === "fr") {
    return {
      system: `Tu es le rédacteur en chef d'une radio d'actualité. Tu écris en ${LOCALES[locale].langName}, au présent, sans jargon, sans emphase.`,
      user: [
        `Voici ce qui a été diffusé à l'antenne sur les ${digest.days} derniers jours (du plus récent au plus ancien) :`,
        lines || "(aucune émission)",
        `Totaux : ${totals.shows} émissions · ${totals.bulletins} bulletins · ${totals.questions} questions · ${totals.debates} débats · ${Math.round(totals.durationSec / 60)} minutes d'antenne${totals.fromMemory ? ` · ${totals.fromMemory} réponses de mémoire` : ""}.`,
        "Écris le récapitulatif « Cette semaine à l'antenne » en 200 à 260 mots : un chapeau d'une ou deux phrases sur les dominantes de la période, puis 3 à 5 paragraphes thématiques qui regroupent les sujets traités (avec les faits marquants, pas une liste de titres), et une dernière ligne « À suivre : … » avec deux ou trois suites possibles.",
        "N'invente aucun fait, chiffre, date ni citation : tout doit venir des lignes ci-dessus. Pas de markdown, pas de titres de section : un texte continu.",
        'Réponds STRICTEMENT en JSON (aucun texte autour) : {"recap": "le texte du récapitulatif"}.',
      ].join("\n\n"),
    };
  }
  return {
    system: `You are the editor-in-chief of a news radio station. You write in ${LOCALES[locale].langName}, in the present tense, plain and factual.`,
    user: [
      `Here is what aired over the last ${digest.days} days (newest first):`,
      lines || "(no show)",
      `Totals: ${totals.shows} shows · ${totals.bulletins} bulletins · ${totals.questions} questions · ${totals.debates} debates · ${Math.round(totals.durationSec / 60)} minutes on air.`,
      "Write the weekly recap in 200-260 words: a one or two sentence lead on the period's dominant themes, then 3 to 5 thematic paragraphs grouping the stories (with the key facts, not a list of headlines), and a final \"Coming up: …\" line with two or three follow-ups.",
      "Do not invent any fact, figure, date or quote: everything must come from the lines above. No markdown, no section headings: continuous prose.",
      'Answer STRICTLY in JSON (no text around it): {"recap": "the recap text"}.',
    ].join("\n\n"),
  };
}

export function readSavedDigest(days: number): SavedDigest | null {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as { byDays?: Record<string, SavedDigest> };
    const saved = raw?.byDays?.[String(clampDays(days))];
    return saved && typeof saved.text === "string" && saved.text.trim() ? saved : null;
  } catch {
    return null;
  }
}

function saveDigest(days: number, payload: SavedDigest): void {
  let byDays: Record<string, SavedDigest> = {};
  try {
    byDays = (JSON.parse(readFileSync(FILE, "utf8")) as { byDays?: Record<string, SavedDigest> }).byDays ?? {};
  } catch {
    /* première génération */
  }
  byDays[String(clampDays(days))] = payload;
  Bun.write(FILE, JSON.stringify({ version: 1, byDays }, null, 2)).catch((err) =>
    console.error("[digest] écriture impossible:", (err as Error).message),
  );
}

export interface DigestResult {
  digest: Digest;
  text: string;
  model: string;
  costUsd: number;
  inTokens: number;
  outTokens: number;
  savedAt: string;
}

/** Rédige le récapitulatif avec le modèle rapide et l'enregistre. */
export async function generateDigest(days: number, settings: Settings, signal?: AbortSignal): Promise<DigestResult> {
  const requested = clampDays(days);
  const digest = digestSince(requested);
  if (!digest.totals.shows) {
    throw Object.assign(new Error("Aucune émission archivée sur cette période."), { status: 404 });
  }
  const { llm } = await getModels();
  const model = settings.llmModelFast || settings.llmModel;
  const prompt = digestPrompt(digest, settings.locale);
  // JSON forcé + marge de tokens : les modèles qui « réfléchissent » dépensent
  // sinon tout le budget avant d'écrire, et la réponse revient vide.
  const res = await chat({
    key: settings.openrouterKey,
    model,
    system: prompt.system,
    user: prompt.user,
    json: true,
    maxTokens: 3000,
    temperature: 0.6,
    signal,
    models: llm,
  });
  const parsed = extractJson(res.text);
  const text = (typeof parsed?.recap === "string" ? parsed.recap : res.text).trim();
  if (!text) {
    throw new OrError(502, `Le modèle « ${model} » n'a rien écrit (budget de tokens épuisé par son raisonnement). Choisis un modèle rapide plus direct dans Réglages → Modèles.`);
  }
  const savedAt = new Date().toISOString();
  saveDigest(requested, { at: savedAt, days: requested, text, model, costUsd: res.costUsd, shows: digest.totals.shows });
  return { digest, text, model, costUsd: res.costUsd, inTokens: res.inTokens, outTokens: res.outTokens, savedAt };
}
