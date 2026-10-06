/**
 * Archives every produced segment on disk, one folder per day:
 *   shows/2026-10-05/03-14-22.mp3
 *   shows/2026-10-05/03-14-22.json   (transcript, speakers, sources, coûts)
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SHOWS_DIR, SHOWS_PATH, themeFor, type Settings } from "./config";
import type { Segment } from "./radio";
import type { AudioBytes } from "./tts";

const pad = (n: number) => String(n).padStart(2, "0");

export interface ArchiveResult {
  dir: string;
  file: string;
  relative: string;
}

const root = SHOWS_PATH;

export function showsRoot(): string {
  return root;
}

/** Filesystem-safe slug used inside the file name. */
export function slugify(value: string, maxLength = 48): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
}

/** What the file name says about the content: theme (or question) + nature. */
export function archiveSlug(segment: Segment): string {
  const theme = themeFor(segment.topic);
  const kind = segment.kind === "question" ? "question" : segment.kind === "debate" ? "debat" : "bulletin";
  const label = segment.kind === "news" ? theme?.id || segment.topic : segment.question || segment.title;
  const slug = slugify(label) || "sans-sujet";
  return `${slug}_${kind}`;
}

/**
 * Writes the MP3 and its transcript sidecar. Both writes are awaited: the caller
 * reports the archive path to the UI, so returning before the bytes reached the
 * disk let Replay list a show it could not read yet (and a failed write became
 * an unhandled rejection instead of a logged error).
 */
export async function archiveSegment(segment: Segment, audio: AudioBytes, settings: Settings): Promise<ArchiveResult | null> {
  if (!settings.archive) return null;
  try {
    const when = new Date(segment.createdAt);
    const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
    const time = `${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
    const stamp = `${time}_${archiveSlug(segment)}`;
    const dir = join(root, day);
    mkdirSync(dir, { recursive: true });
    let base = stamp;
    for (let i = 2; existsSync(join(dir, `${base}.mp3`)); i++) base = `${stamp}-${i}`;
    const file = join(dir, `${base}.mp3`);
    await Bun.write(file, audio);
    await Bun.write(
      join(dir, `${base}.json`),
      JSON.stringify(
        {
          date: segment.createdAt,
          kind: segment.kind,
          knowledge: segment.knowledge,
          title: segment.title,
          topic: segment.topic,
          question: segment.question,
          searchQuery: segment.searchQuery,
          speakers: segment.speakers,
          turns: segment.turns,
          transcript: segment.transcript,
          // Timings mot à mot (Edge TTS) : la page Replay s'aligne dessus.
          words: segment.words,
          durationSec: segment.estimatedSeconds,
          sources: segment.sources,
          reports: segment.reports,
          llm: segment.llm,
          tts: segment.tts,
          audio: `${base}.mp3`,
        },
        null,
        2,
      ),
    );
    // Chemin affiché dans l'interface : toujours en slashes, même sous Windows.
    return { dir, file, relative: `${SHOWS_DIR}/${day}/${base}.mp3` };
  } catch (err) {
    console.error("[archive] échec de l'archivage:", (err as Error).message);
    return null;
  }
}
