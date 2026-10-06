/**
 * Mémoire éditoriale de la journée : une histoire déjà passée à l'antenne ne
 * revient pas dans un bulletin suivant. L'historique vit dans
 * `.data/played.json` et garde quelques jours, pour les récapitulatifs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config";
import { storySimilar } from "./news";

const FILE = join(DATA_DIR, "played.json");
const KEEP_DAYS = 3;
const MAX_ENTRIES = 400;
const DAY_MS = 86_400_000;

export interface PlayedStory {
  title: string;
  topic: string;
  at: string;
}

let stories: PlayedStory[] = [];

const localDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function storyDay(story: PlayedStory): string {
  const date = new Date(story.at);
  return Number.isNaN(date.getTime()) ? "" : localDay(date);
}

function prune(now = new Date()): void {
  const oldest = now.getTime() - KEEP_DAYS * DAY_MS;
  stories = stories
    .filter((story) => {
      const at = Date.parse(story.at);
      return !!story.title && Number.isFinite(at) && at >= oldest;
    })
    .slice(-MAX_ENTRIES);
}

function persist(): void {
  Bun.write(FILE, JSON.stringify({ version: 1, stories }, null, 2)).catch((err) =>
    console.error("[mémoire] écriture impossible:", (err as Error).message),
  );
}

/** Relit l'historique du disque (au démarrage). */
export function loadMemory(): void {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as { stories?: unknown };
    stories = Array.isArray(raw?.stories)
      ? (raw.stories as unknown[]).filter(
          (entry): entry is PlayedStory =>
            !!entry &&
            typeof entry === "object" &&
            typeof (entry as PlayedStory).title === "string" &&
            typeof (entry as PlayedStory).at === "string",
        )
      : [];
  } catch {
    stories = [];
  }
  prune();
}

/** Histoires déjà passées à l'antenne aujourd'hui. */
export function playedToday(now = new Date()): PlayedStory[] {
  const day = localDay(now);
  return stories.filter((story) => storyDay(story) === day);
}

/**
 * Sépare une liste d'articles en « encore neufs » et « déjà traités ».
 * Fonction pure : la mémoire est passée en paramètre (testable sans disque).
 */
export function partitionAgainst<T extends { title: string }>(
  items: T[],
  played: PlayedStory[],
  threshold = 0.4,
): { fresh: T[]; skipped: number } {
  const known = played.filter((story) => story.title);
  const fresh = items.filter((item) => !known.some((story) => storySimilar(story.title, item.title, threshold)));
  return { fresh, skipped: items.length - fresh.length };
}

/** Sélectionne les sujets encore neufs, d'après la mémoire de la journée. */
export function partitionFresh<T extends { title: string }>(items: T[]): { fresh: T[]; skipped: number } {
  return partitionAgainst(items, playedToday());
}

/**
 * Le sujet a-t-il déjà été traité à l'antenne ? La mémoire garde le sujet de
 * chaque passage, y compris ceux qui n'ont aucune source : sans ça, une réponse
 * de culture générale ne restait jamais en mémoire et le même sujet revenait
 * toute la journée.
 *
 * `played` est injectable pour rester testable sans disque, comme partitionAgainst.
 */
export function topicAiredToday(topic: string, played: PlayedStory[] = playedToday()): boolean {
  return aired(played, topic);
}

/**
 * Sujet de rechange pour une rotation : une puce de l'auditeur qui n'est ni le
 * sujet en cours ni un sujet déjà passé aujourd'hui. `null` si tout a déjà été
 * traité — dans ce cas mieux vaut un point de situation qu'une rotation à vide.
 */
export function nextFreshTopic(topics: string[], current: string, played: PlayedStory[] = playedToday()): string | null {
  for (const raw of topics) {
    const topic = raw?.trim();
    if (!topic || storySimilar(topic, current) || aired(played, topic)) continue;
    return topic;
  }
  return null;
}

/** Un sujet a-t-il été traité dans cette liste d'histoires ? */
function aired(played: PlayedStory[], topic: string): boolean {
  const needle = topic?.trim();
  if (!needle) return false;
  return played.some((story) => !!story.topic && storySimilar(story.topic, needle));
}

/** Enregistre les sujets réellement traités à l'antenne. */
export function markPlayed(entries: { title: string; topic: string }[], now = new Date()): number {
  const day = localDay(now);
  let added = 0;
  for (const entry of entries) {
    const title = entry.title?.trim();
    if (!title) continue;
    if (stories.some((story) => storyDay(story) === day && storySimilar(story.title, title))) continue;
    stories.push({ title, topic: entry.topic, at: now.toISOString() });
    added += 1;
  }
  if (added) {
    prune(now);
    persist();
  }
  return added;
}

/**
 * Retire une histoire précise de la mémoire : elle pourra revenir à l'antenne.
 * Clé volontairement stricte (titre exact + horodatage exact), pour qu'un clic
 * dans la liste ne puisse pas effacer une autre histoire par ressemblance.
 */
export function forgetStory(title: string, at: string, now = new Date()): number {
  const { kept, removed } = removeStory(stories, title, at);
  if (!removed) return 0;
  stories = kept;
  prune(now);
  persist();
  return removed;
}

/**
 * Fonction pure : la liste et la clé sont passées en paramètre (testable sans
 * disque), comme partitionAgainst.
 */
export function removeStory(list: PlayedStory[], title: string, at: string): { kept: PlayedStory[]; removed: number } {
  const needle = title?.trim();
  const stamp = at?.trim();
  if (!needle || !stamp) return { kept: list, removed: 0 };
  const kept = list.filter((story) => !(story.title === needle && story.at === stamp));
  return { kept, removed: list.length - kept.length };
}

/** Combien d'histoires en mémoire, et combien pour aujourd'hui. */
export function memorySummary(now = new Date()): { today: number; total: number } {
  return { today: playedToday(now).length, total: stories.length };
}

/** Vide la mémoire (tout l'historique). */
export function clearMemory(): number {
  const count = stories.length;
  stories = [];
  persist();
  return count;
}
