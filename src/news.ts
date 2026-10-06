/**
 * News collection: RSS/Atom parsing (Google News search + curated feeds),
 * de-duplication and an optional lightweight article reader.
 */
import { XMLParser } from "fast-xml-parser";
import { FEED_PRESETS, isFrontPage, LOCALES, themeFor, type FeedPreset, type Locale } from "./config";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36 AINewsRadio/1.0";
const MAX_PER_FEED = 12;

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  summary: string;
  feed: string;
  /** Language of the source feed: used to keep the bulletin in one language. */
  lang: Locale;
  /** Filled in by the deep reader when enabled. */
  body?: string;
  image?: string | null;
  /** Nombre de médias qui racontent la même histoire (1 = sujet isolé). */
  dupes?: number;
}

export interface FeedReport {
  label: string;
  url: string;
  kind: "google-news" | "feed";
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
}

export interface NewsBundle {
  query: string;
  items: NewsItem[];
  reports: FeedReport[];
  ms: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};

export function stripHtml(input: unknown): string {
  const s = String(input ?? "");
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePoint(Number(dec)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

function codePoint(value: number): string {
  try {
    return Number.isFinite(value) && value > 0 ? String.fromCodePoint(value) : " ";
  } catch {
    return " ";
  }
}

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object") {
    const t = (node as Record<string, unknown>)["#text"];
    if (t != null) return String(t);
  }
  return "";
}

function attrOf(node: unknown, attr: string): string {
  if (node && typeof node === "object") {
    const v = (node as Record<string, unknown>)[`@_${attr}`];
    if (v != null) return String(v);
  }
  return "";
}

function isoDate(value: unknown): string | null {
  const s = textOf(value) || String(value ?? "");
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Publisher name. Feeds are inconsistent here: Google News puts the publisher in
 * <source>, while others use <source> for photo credits ("© John Doe, AP").
 * Falls back to the link's domain, then to the feed name.
 */
function publisherOf(sourceNode: unknown, url: string, feedLabel: string): string {
  const raw = stripHtml(textOf(sourceNode));
  if (raw && !/^©|^\(c\)|photo|associated press|afp$|reuters$/i.test(raw) && raw.length <= 42) return raw;
  const host = attrOf(sourceNode, "url") || url;
  const domain = host.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  if (domain && domain.includes(".")) return domain;
  return feedLabel;
}

function pickLink(node: Record<string, unknown>): string {
  const direct = textOf(node.link);
  if (direct.startsWith("http")) return direct;
  for (const l of asArray(node.link as unknown)) {
    if (typeof l === "string" && l.startsWith("http")) return l;
    const href = attrOf(l, "href");
    if (href.startsWith("http")) return href;
  }
  const guid = textOf(node.guid);
  if (guid.startsWith("http")) return guid;
  return "";
}

export function parseFeedXml(xml: string, feedLabel: string, feedLang: Locale = "fr"): NewsItem[] {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml) as Record<string, any>;
  } catch {
    return [];
  }
  const channel = doc?.rss?.channel ?? doc?.feed ?? doc?.["rdf:RDF"]?.channel;
  if (!channel) return [];
  const rawItems = asArray(channel.item ?? channel.entry);
  const out: NewsItem[] = [];
  for (const raw of rawItems.slice(0, MAX_PER_FEED)) {
    const node = raw as Record<string, unknown>;
    const title = stripHtml(textOf(node.title));
    const url = pickLink(node);
    if (!title || !url) continue;
    out.push({
      title,
      url,
      source: publisherOf(node.source, url, feedLabel),
      publishedAt: isoDate(node.pubDate ?? node.published ?? node.updated ?? node["dc:date"]),
      summary: stripHtml(textOf(node.description ?? node.summary ?? node["content:encoded"])).slice(0, 600),
      feed: feedLabel,
      lang: feedLang,
      image: attrOf(node["media:content"], "url") || attrOf(node["media:thumbnail"], "url") || null,
    });
  }
  return out;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

async function fetchText(url: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { signal: withTimeout(signal, timeoutMs), headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml, */*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

export function googleNewsUrl(query: string, locale: Locale): string {
  const l = LOCALES[locale];
  const q = query.trim() || "actualité";
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${l.hl}&gl=${l.gl}&ceid=${l.ceid}`;
}

export function resolveFeeds(ids: string[], custom: { label: string; url: string }[]): FeedPreset[] {
  const byId = new Map(FEED_PRESETS.map((f) => [f.id, f]));
  const picked = ids.map((id) => byId.get(id)).filter((f): f is FeedPreset => !!f);
  for (const c of custom) picked.push({ id: `custom:${c.url}`, label: c.label || c.url, url: c.url, lang: "fr", topic: "custom" });
  return picked;
}

const deaccent = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const normalizeKey = (title: string): string => deaccent(title).replace(/[^a-z0-9]+/g, " ").trim().slice(0, 70);

const STOPWORDS = new Set(["les", "des", "une", "pour", "avec", "dans", "sur", "aux", "the", "and", "for", "with", "actualite", "actu"]);

/** Query terms: a known theme brings its own keyword set, else the words themselves. */
export function queryTerms(query: string): string[] {
  const theme = themeFor(query);
  if (theme) return theme.keywords.map(deaccent);
  return deaccent(query)
    .replace(/[^a-z0-9&\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/[\s&]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .slice(0, 12);
}

/** The news query a topic maps to (a theme knows the right search terms). */
export function queryForTopic(topic: string): string {
  const theme = themeFor(topic);
  return theme?.query || topic;
}

/**
 * Relevance score: title matches weigh more than summary matches.
 * Ordering only — items that score 0 are kept (last) so nothing is silently lost.
 */
function relevance(item: NewsItem, terms: string[]): number {
  if (!terms.length) return 0;
  const title = deaccent(item.title);
  const body = deaccent(`${item.summary} ${item.source}`);
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 3;
    else if (body.includes(term)) score += 1;
  }
  return score;
}

/**
 * Orders by relevance, then by language (a French bulletin leads with French
 * sources), then by recency.
 */
export function rankByRelevance(items: NewsItem[], query: string, locale: Locale = "fr"): NewsItem[] {
  const terms = queryTerms(query);
  const at = (item: NewsItem) => (item.publishedAt ? Date.parse(item.publishedAt) : 0);
  const sameLang = (item: NewsItem) => (item.lang === locale ? 1 : 0);
  const scored = items.map((item, index) => ({ item, index, score: terms.length ? relevance(item, terms) : 0 }));
  const anyScore = scored.some((s) => s.score > 0);
  return scored
    .sort((a, b) => (anyScore ? b.score - a.score : 0) || sameLang(b.item) - sameLang(a.item) || at(b.item) - at(a.item) || a.index - b.index)
    .map((s) => s.item);
}

export function dedupe(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of items) {
    const key = normalizeKey(item.title) || item.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Mots significatifs d'un titre, pour reconnaître un même sujet chez plusieurs médias.
 *
 * Le regroupement et la mémoire éditoriale comparent chaque candidat à toute
 * l'historique : sans cache, la même normalisation était refaite des milliers de
 * fois par bulletin (254 ms sur une journée pleine). Le résultat est mémoïsé et
 * partagé — il ne faut donc jamais modifier l'ensemble renvoyé.
 */
const termsCache = new Map<string, Set<string>>();
const TERMS_CACHE_MAX = 2000;

export function storyTerms(title: string): Set<string> {
  const cached = termsCache.get(title);
  if (cached) return cached;
  const tokens = deaccent(title)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  const terms = new Set(tokens);
  if (termsCache.size >= TERMS_CACHE_MAX) termsCache.clear();
  termsCache.set(title, terms);
  return terms;
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const term of small) if (big.has(term)) shared += 1;
  return shared >= 3 ? shared / Math.max(1, small.size) : 0;
}

/**
 * Deux titres parlent-ils de la même histoire ? Sert au regroupement des
 * dépêches et à la mémoire éditoriale. Les titres trop courts (moins de trois
 * mots significatifs) retombent sur une comparaison exacte.
 */
export function storySimilar(a: string, b: string, threshold = 0.4): boolean {
  const left = storyTerms(a);
  const right = storyTerms(b);
  if (left.size < 3 || right.size < 3) return deaccent(a).replace(/[^a-z0-9]+/g, " ").trim() === deaccent(b).replace(/[^a-z0-9]+/g, " ").trim();
  return overlapRatio(left, right) >= threshold;
}

/**
 * Regroupe les dépêches qui racontent la MÊME histoire : plusieurs médias, un
 * seul sujet à l'antenne. Le représentant est le premier de la liste (donc le
 * mieux classé) ; les autres sont comptés dans `dupes` pour peser sur l'ordre
 * final (un sujet couvert par quatre titres passe devant un fait divers isolé).
 * Doit être appelé après le classement par pertinence.
 */
export function dedupeByStory(items: NewsItem[], threshold = 0.4): NewsItem[] {
  const clusters: { item: NewsItem; terms: Set<string> }[] = [];
  const out: NewsItem[] = [];
  for (const item of items) {
    const terms = storyTerms(item.title);
    const match = terms.size >= 3 ? clusters.find((cluster) => overlapRatio(cluster.terms, terms) >= threshold) : undefined;
    if (match) {
      match.item.dupes = (match.item.dupes ?? 1) + 1;
      continue;
    }
    const keeper: NewsItem = { ...item, dupes: 1 };
    clusters.push({ item: keeper, terms });
    out.push(keeper);
  }
  return out;
}

/** Le sujet couvert par plusieurs médias remonte : c'est le signal le plus fiable. */
export function sharpenOrder(items: NewsItem[], query: string, locale: Locale = "fr"): NewsItem[] {
  const terms = queryTerms(query);
  const at = (item: NewsItem) => (item.publishedAt ? Date.parse(item.publishedAt) : 0);
  const weight = (item: NewsItem) => relevance(item, terms) + Math.min(3, (item.dupes ?? 1) - 1) * 1.5;
  return [...items].sort((a, b) => weight(b) - weight(a) || (b.lang === locale ? 1 : 0) - (a.lang === locale ? 1 : 0) || at(b) - at(a));
}

export function sortByRecency(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return tb - ta;
  });
}

/** Fetches one feed and reports timing/errors instead of throwing. */
async function collectFeed(
  feed: { label: string; url: string; kind: "google-news" | "feed"; lang?: Locale },
  signal?: AbortSignal,
): Promise<{ report: FeedReport; items: NewsItem[] }> {
  const started = Date.now();
  try {
    const xml = await fetchText(feed.url, signal, feed.kind === "google-news" ? 12000 : 9000);
    const items = parseFeedXml(xml, feed.label, feed.lang ?? "fr");
    return {
      items,
      report: { label: feed.label, url: feed.url, kind: feed.kind, ok: true, count: items.length, ms: Date.now() - started },
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    return {
      items: [],
      report: { label: feed.label, url: feed.url, kind: feed.kind, ok: false, count: 0, ms: Date.now() - started, error: (err as Error).message },
    };
  }
}

/**
 * Collects news for a query: Google News RSS search (relevance) + the selected
 * feeds (recency), merged and de-duplicated.
 */
export async function searchNews(opts: {
  query: string;
  /** Label used to rank the results (a theme label beats the raw query). */
  rankQuery?: string;
  locale: Locale;
  feeds: { id: string; label: string; url: string; lang?: Locale }[];
  useGoogleNews: boolean;
  signal?: AbortSignal;
}): Promise<NewsBundle> {
  const started = Date.now();
  const targets: { label: string; url: string; kind: "google-news" | "feed"; lang?: Locale }[] = [];
  const q = opts.query.trim();
  if (opts.useGoogleNews) {
    const front = isFrontPage(q);
    targets.push({
      label: front ? "Google News — à la une" : `Google News — « ${q} »`,
      url: googleNewsUrl(front ? "" : q, opts.locale),
      kind: "google-news",
      lang: opts.locale,
    });
  }
  for (const f of opts.feeds) targets.push({ label: f.label, url: f.url, kind: "feed", lang: f.lang ?? opts.locale });

  const settled = await Promise.all(targets.map((t) => collectFeed(t, opts.signal)));
  const items = dedupe(settled.flatMap((s) => s.items));
  const rankQuery = opts.rankQuery || q;
  // Un même sujet revient souvent dans plusieurs médias : on le garde une fois.
  const stories = dedupeByStory(rankByRelevance(items, rankQuery, opts.locale));
  return {
    query: q,
    items: sharpenOrder(stories, rankQuery, opts.locale),
    reports: settled.map((s) => s.report),
    ms: Date.now() - started,
  };
}

const searchCache = new Map<string, { at: number; bundle: NewsBundle }>();

/** Refresh sources independently from segment duration; never cache failed/empty searches. */
export async function cachedSearchNews(opts: Parameters<typeof searchNews>[0], intervalSec: number): Promise<{ bundle: NewsBundle; cached: boolean }> {
  const key = JSON.stringify([opts.query, opts.rankQuery, opts.locale, opts.feeds, opts.useGoogleNews]);
  const found = searchCache.get(key);
  if (found && Date.now() - found.at < intervalSec * 1000) return { bundle: structuredClone(found.bundle), cached: true };
  const bundle = await searchNews(opts);
  opts.signal?.throwIfAborted();
  if (bundle.items.length && bundle.reports.some(r => r.ok)) {
    if (searchCache.size >= 40) searchCache.delete(searchCache.keys().next().value!);
    searchCache.set(key, { at: Date.now(), bundle: structuredClone(bundle) });
  }
  return { bundle, cached: false };
}

const BOILERPLATE = /notifications?|cookies?|s'abonner|abonnez-vous|newsletter|vous pouvez changer d'avis|accept all|gérer mes choix|consent/i;

/** Best-effort article reader: returns null when the page is unusable. */
export async function fetchArticleText(url: string, signal?: AbortSignal): Promise<string | null> {
  // Google News links bounce through a consent wall that answers 400 — not worth the round trip.
  if (url.includes("news.google.com")) return null;
  try {
    const res = await fetch(url, {
      signal: withTimeout(signal, 8000),
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    const html = (await res.text()).slice(0, 400_000);
    const body = html
      .replace(/<(script|style|noscript|nav|header|footer|aside|form|svg)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ");
    const paragraphs = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripHtml(m[1]));
    const text = paragraphs
      .filter((p) => p.length > 60 && !BOILERPLATE.test(p))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 200 ? text.slice(0, 1800) : null;
  } catch {
    return null;
  }
}

/**
 * Enriches the most promising items with article bodies, in parallel, best effort.
 * Direct publisher links are read first: Google News ones are behind a consent wall.
 */
export async function deepRead(items: NewsItem[], limit: number, signal?: AbortSignal): Promise<NewsItem[]> {
  const readable = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.url.includes("news.google.com"))
    .slice(0, limit);
  const bodies = await Promise.all(readable.map(({ item }) => fetchArticleText(item.url, signal)));
  const byIndex = new Map<number, string>();
  readable.forEach(({ index }, i) => {
    const body = bodies[i];
    if (body) byIndex.set(index, body);
  });
  return items.map((item, index) => {
    const body = byIndex.get(index);
    return body ? { ...item, body } : item;
  });
}
