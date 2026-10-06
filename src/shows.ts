/**
 * Lecture des émissions archivées : shows/AAAA-MM-JJ/HH-MM-SS_sujet_type.{mp3,json}
 * Sert de base à la page « Replay » (liste du jour, transcript, réécoute).
 */
import { readdirSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { SHOWS_DIR } from "./config";
import { showsRoot } from "./archive";
import type { FeedReport } from "./news";
import type { LlmInfo, TtsInfo } from "./radio";

export interface ShowTurn {
  speakerIndex: number;
  name: string;
  start: number;
  end: number;
}

export interface ShowWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface ShowSource {
  index: number;
  title: string;
  source: string;
  url: string;
}

export interface ShowEntry {
  id: string;
  day: string;
  file: string;
  title: string;
  kind: "news" | "question" | "debate";
  /** Écrit de mémoire par le modèle, sans dépêche. */
  knowledge: boolean;
  topic: string;
  question?: string;
  searchQuery: string;
  createdAt: string | null;
  /** HH:MM:SS extrait du nom de fichier. */
  clock: string;
  durationSec: number;
  sizeBytes: number;
  speakers: { name: string; voice: string }[];
  turns: ShowTurn[];
  words: ShowWord[] | null;
  transcript: string;
  sources: ShowSource[];
  reports: FeedReport[];
  llm: LlmInfo | null;
  tts: TtsInfo | null;
  sourceCount: number;
  costUsd: number;
  url: string;
}

export interface ShowDay {
  day: string;
  count: number;
}

interface CacheEntry {
  mtimeMs: number;
  data: Omit<ShowEntry, "sizeBytes"> | null;
}

const cache = new Map<string, CacheEntry>();
/** Le cache suit les fichiers lus : au-delà, on repart à zéro plutôt que de grossir. */
const CACHE_MAX = 600;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^[A-Za-z0-9_.\-]+\.mp3$/;

export function isValidDay(day: string): boolean {
  return DAY_RE.test(day);
}

export function isValidShowFile(file: string): boolean {
  return FILE_RE.test(file) && !file.includes("..");
}

/** Chemin absolu d'un fichier archivé, ou null si la requête est douteuse. */
export function showPath(day: string, file: string): string | null {
  if (!isValidDay(day) || !isValidShowFile(file)) return null;
  const path = join(showsRoot(), day, file);
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

function clockFromBase(base: string): string {
  const match = base.match(/^(\d{2})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}:${match[2]}:${match[3]}` : "";
}

/** Coût relu d'un bloc d'exécution archivé, tolérant aux fichiers incomplets. */
function costOf(info: { costUsd?: unknown } | null): number {
  const value = Number(info?.costUsd ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function objectOf<T>(value: unknown): T | null {
  return value && typeof value === "object" ? (value as T) : null;
}

function readEntry(day: string, base: string): Omit<ShowEntry, "sizeBytes"> | null {
  const jsonPath = join(showsRoot(), day, `${base}.json`);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(jsonPath).mtimeMs;
  } catch {
    return null;
  }
  const cached = cache.get(jsonPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.data;

  let data: Omit<ShowEntry, "sizeBytes"> | null = null;
  try {
    const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
    const rawSources = Array.isArray(raw.sources) ? (raw.sources as Record<string, unknown>[]) : [];
    const sources: ShowSource[] = rawSources
      .filter((s) => s && typeof s === "object")
      .map((s, index) => ({
        index: Number(s.index ?? index + 1),
        title: String(s.title ?? ""),
        source: String(s.source ?? ""),
        url: String(s.url ?? ""),
      }))
      .filter((s) => s.title || s.url);
    const llm = objectOf<LlmInfo>(raw.llm);
    const tts = objectOf<TtsInfo>(raw.tts);
    const durationSec = Number(raw.durationSec ?? 0);
    data = {
      id: `${day}/${base}`,
      day,
      file: `${base}.mp3`,
      title: String(raw.title ?? base),
      kind: raw.kind === "question" ? "question" : raw.kind === "debate" ? "debate" : "news",
      knowledge: raw.knowledge === true,
      topic: String(raw.topic ?? ""),
      question: raw.question ? String(raw.question) : undefined,
      searchQuery: String(raw.searchQuery ?? ""),
      createdAt: raw.date ? String(raw.date) : null,
      clock: clockFromBase(base),
      durationSec: Number.isFinite(durationSec) ? durationSec : 0,
      speakers: Array.isArray(raw.speakers) ? (raw.speakers as ShowEntry["speakers"]) : [],
      turns: Array.isArray(raw.turns) ? (raw.turns as ShowTurn[]) : [],
      words: Array.isArray(raw.words) ? (raw.words as ShowWord[]) : null,
      transcript: String(raw.transcript ?? ""),
      sources,
      reports: Array.isArray(raw.reports) ? (raw.reports as FeedReport[]) : [],
      llm,
      tts,
      sourceCount: sources.length,
      costUsd: costOf(llm) + costOf(tts),
      url: `/api/shows/${day}/${base}.mp3`,
    };
  } catch {
    data = null;
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(jsonPath, { mtimeMs, data });
  return data;
}

/** Jours disponibles, du plus récent au plus ancien. */
export function listDays(): ShowDay[] {
  try {
    return readdirSync(showsRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && DAY_RE.test(entry.name))
      .map((entry) => {
        let files: string[] = [];
        try {
          files = readdirSync(join(showsRoot(), entry.name));
        } catch {
          /* dossier illisible : on affiche 0 */
        }
        // Une émission n'est rejouable que si son JSON accompagne le MP3 : on ne
        // compte que les paires complètes, sinon le compteur du Replay mentait.
        const names = new Set(files);
        const count = files.filter((f) => f.endsWith(".mp3") && names.has(`${f.slice(0, -4)}.json`)).length;
        return { day: entry.name, count };
      })
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.day.localeCompare(a.day));
  } catch {
    return [];
  }
}

/** Émissions d'un jour (la plus récente d'abord). */
export function listShows(day?: string): { days: ShowDay[]; day: string; shows: ShowEntry[] } {
  const days = listDays();
  // Un jour demandé mais absent (dernière émission supprimée) retombe sur le plus récent.
  const target = day && days.some((entry) => entry.day === day) ? day : days[0]?.day ?? "";
  if (!target) return { days, day: "", shows: [] };
  let files: string[] = [];
  try {
    files = readdirSync(join(showsRoot(), target)).filter((f) => f.endsWith(".mp3"));
  } catch {
    return { days, day: target, shows: [] };
  }
  const shows: ShowEntry[] = [];
  for (const file of files) {
    const base = file.replace(/\.mp3$/, "");
    const entry = readEntry(target, base);
    if (!entry) continue;
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(join(showsRoot(), target, file)).size;
    } catch {
      /* fichier disparu entre-temps */
    }
    shows.push({ ...entry, sizeBytes });
  }
  return { days, day: target, shows: shows.sort((a, b) => b.id.localeCompare(a.id)) };
}

export function showsDirLabel(): string {
  return SHOWS_DIR;
}

/**
 * Supprime une émission archivée (MP3 + JSON) et, si le dossier du jour devient
 * vide, le dossier lui-même. Renvoie null quand le fichier n'existe pas.
 */
export function deleteShow(day: string, file: string): { day: string; file: string; id: string } | null {
  const path = showPath(day, file);
  if (!path) return null;
  const base = file.replace(/\.mp3$/, "");
  const jsonPath = join(showsRoot(), day, `${base}.json`);
  try {
    rmSync(path, { force: true });
    rmSync(jsonPath, { force: true });
  } catch (err) {
    console.error("[shows] suppression impossible:", (err as Error).message);
    return null;
  }
  cache.delete(jsonPath);
  try {
    rmdirSync(join(showsRoot(), day));
  } catch {
    /* le dossier du jour contient encore des émissions */
  }
  return { day, file, id: `${day}/${base}` };
}
