/**
 * Flux podcast des émissions archivées : `/feed.xml` expose les derniers MP3 en
 * enclosures, pour s'abonner depuis un lecteur de podcasts.
 */
import { APP_NAME, type Locale } from "./config";
import { listDays, listShows, type ShowEntry } from "./shows";

/** Assez pour un podcast, assez court pour rester léger. */
const LIMIT = 60;

const xml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const KIND_LABEL: Record<Locale, Record<ShowEntry["kind"], string>> = {
  fr: { news: "Bulletin", question: "Réponse à une question", debate: "Débat" },
  en: { news: "Bulletin", question: "Listener question", debate: "Debate" },
};

function descriptionOf(show: ShowEntry, locale: Locale): string {
  const parts: string[] = [`${KIND_LABEL[locale][show.kind]}.`];
  if (show.question) parts.push(show.question);
  else if (show.topic) parts.push(show.topic);
  if (show.knowledge) parts.push(locale === "fr" ? "Réponse de mémoire (aucune dépêche)." : "Answered from memory.");
  if (show.sourceCount) parts.push(locale === "fr" ? `${show.sourceCount} sources.` : `${show.sourceCount} sources.`);
  const excerpt = show.transcript.replace(/\s+/g, " ").slice(0, 300);
  if (excerpt) parts.push(`${excerpt}…`);
  return parts.join(" ").slice(0, 600);
}

/** Feed RSS 2.0 prêt à servir. Fonction pure : pratique à tester. */
export function renderPodcastFeed(shows: ShowEntry[], origin: string, locale: Locale = "fr"): string {
  const lang = locale === "fr" ? "fr-fr" : "en-us";
  const now = new Date().toUTCString();
  const items = shows
    .slice(0, LIMIT)
    .map((show) => {
      const url = `${origin}/api/shows/${show.day}/${encodeURIComponent(show.file)}`;
      const published = show.createdAt ? new Date(show.createdAt) : null;
      const pubDate = published && !Number.isNaN(published.getTime()) ? published.toUTCString() : now;
      return [
        "    <item>",
        `      <title>${xml(show.title || show.file)}</title>`,
        `      <description>${xml(descriptionOf(show, locale))}</description>`,
        `      <pubDate>${pubDate}</pubDate>`,
        `      <guid isPermaLink="false">${xml(show.id)}</guid>`,
        `      <enclosure url="${xml(url)}" length="${Math.max(0, Math.round(show.sizeBytes))}" type="audio/mpeg" />`,
        `      <itunes:duration>${Math.max(0, Math.round(show.durationSec || 0))}</itunes:duration>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");
  const description =
    locale === "fr"
      ? "Les émissions archivées d'AI News Radio : bulletins, réponses aux questions et débats."
      : "AI News Radio archive: bulletins, listener questions and debates.";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">',
    "  <channel>",
    `    <title>${xml(`${APP_NAME} — replay`)}</title>`,
    `    <link>${xml(origin)}</link>`,
    `    <description>${xml(description)}</description>`,
    `    <language>${lang}</language>`,
    `    <lastBuildDate>${now}</lastBuildDate>`,
    `    <itunes:author>${xml(APP_NAME)}</itunes:author>`,
    '    <itunes:category text="News" />',
    items,
    "  </channel>",
    "</rss>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Dernières émissions archivées, du plus récent au plus ancien. */
export function collectPodcastShows(days = 14): ShowEntry[] {
  const shows: ShowEntry[] = [];
  for (const entry of listDays().slice(0, days)) {
    if (shows.length >= LIMIT) break;
    shows.push(...listShows(entry.day).shows);
  }
  return shows.slice(0, LIMIT);
}

export function buildPodcastFeed(origin: string, locale: Locale = "fr"): { xml: string; count: number } {
  const shows = collectPodcastShows();
  return { xml: renderPodcastFeed(shows, origin, locale), count: shows.length };
}
