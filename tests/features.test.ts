/**
 * Tests des fonctions ajoutées : mémoire éditoriale, prompt de débat,
 * flux podcast et mémoire longue (récapitulatif).
 *   bun test
 */
import { describe, expect, test } from "bun:test";
import { XMLParser } from "fast-xml-parser";
import { DEFAULT_SETTINGS } from "../src/config";
import { summarize } from "../src/digest";
import { renderPodcastFeed } from "../src/feed";
import { answerPrompt, bulletinPrompt, debatePrompt, knowledgePrompt, queryPrompt } from "../src/llm";
import { nextFreshTopic, partitionAgainst, removeStory, topicAiredToday, type PlayedStory } from "../src/memory";
import { storySimilar, type NewsItem } from "../src/news";
import { countsAsHeard, memoryEntriesFor, planSegment } from "../src/radio";
import type { ShowEntry } from "../src/shows";

const HOSTS = [
  { name: "Lila", voice: "fr-FR-DeniseNeural", persona: "optimiste" },
  { name: "Marcel", voice: "fr-FR-HenriNeural", persona: "pessimiste" },
];
const LISTENER = { name: "Alex", persona: "curieux" };

describe("mémoire éditoriale", () => {
  test("deux titres de la même histoire sont reconnus", () => {
    expect(
      storySimilar(
        "Présidentielle au Brésil : Flavio Bolsonaro crée la surprise en devançant Lula au premier tour",
        "Au Brésil, Flavio Bolsonaro devance Lula au premier tour de la présidentielle",
      ),
    ).toBe(true);
    expect(storySimilar("Présidentielle au Brésil : Flavio Bolsonaro devance Lula", "Séisme de magnitude 6 au Japon")).toBe(false);
  });

  test("partitionAgainst écarte les histoires déjà passées, garde les autres", () => {
    const played: PlayedStory[] = [
      { title: "Présidentielle au Brésil : Flavio Bolsonaro devance Lula au premier tour", topic: "Monde", at: new Date().toISOString() },
    ];
    const items = [
      { title: "Au Brésil, Flavio Bolsonaro devance Lula au second tour" },
      { title: "Une nouvelle fusée européenne réussit son décollage" },
    ];
    const { fresh, skipped } = partitionAgainst(items, played);
    expect(skipped).toBe(1);
    expect(fresh.length).toBe(1);
    expect(fresh[0].title).toContain("fusée");
  });

  test("oublier une histoire ne touche qu'elle, même avec un voisin très ressemblant", () => {
    const played: PlayedStory[] = [
      { title: "Trous noirs en mémoire", topic: "les trous noirs", at: "2026-10-06T01:34:41.000Z" },
      { title: "Les trous noirs en mémoire", topic: "les trous noirs", at: "2026-10-06T01:34:47.000Z" },
    ];
    // Clé stricte : titre exact + horodatage exact, donc le voisin ressemblant reste.
    const { kept, removed } = removeStory(played, "Trous noirs en mémoire", "2026-10-06T01:34:41.000Z");
    expect(removed).toBe(1);
    expect(kept.map((story) => story.title)).toEqual(["Les trous noirs en mémoire"]);
    // Horodatage différent : rien à oublier (on n'efface pas par ressemblance).
    expect(removeStory(played, "Trous noirs en mémoire", "2026-10-06T09:00:00.000Z").removed).toBe(0);
    expect(removeStory(played, "   ", "2026-10-06T01:34:41.000Z").removed).toBe(0);
    expect(removeStory(played, "Trous noirs en mémoire", "").removed).toBe(0);
  });

  test("un sujet sans dépêche reste en mémoire, et la rotation propose une autre puce", () => {
    const played: PlayedStory[] = [
      // Réponse de mémoire : aucune source, c'est le sujet qui porte la mémoire.
      { title: "Trous noirs en soirée", topic: "les trous noirs", at: new Date().toISOString() },
      { title: "Titres — À la une", topic: "À la une", at: new Date().toISOString() },
    ];
    expect(topicAiredToday("les trous noirs", played)).toBe(true);
    expect(topicAiredToday("IA & tech", played)).toBe(false);
    // Ni le sujet en cours, ni une puce déjà passée aujourd'hui.
    expect(nextFreshTopic(["les trous noirs", "À la une", "Monde", "IA & tech"], "les trous noirs", played)).toBe("Monde");
    // Tout a déjà été traité : pas de rotation à vide.
    expect(nextFreshTopic(["À la une"], "À la une", played)).toBeNull();
    expect(nextFreshTopic([], "les trous noirs", played)).toBeNull();
  });

  test("un sujet sans dépêche déjà passé fait basculer le bulletin sur une autre puce", async () => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/models")) return Response.json({ data: [] });
      if (!String(url).includes("/chat/completions")) throw new Error("Requête inattendue pendant le test : " + url);
      // Réponse de mémoire : le script arrive sans dépêche ni source.
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              title: "Trous noirs, autre angle",
              turns: [{ speaker: "Lila", text: "On repart du sujet demandé, sans relire les dépêches." }, { speaker: "Marcel", text: "Voilà un nouveau passage pour Alex." }],
              usedSources: [],
            }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      });
    }) as typeof fetch;
    try {
      const settings = {
        ...DEFAULT_SETTINGS,
        openrouterKey: "test-key",
        radioMode: "explore" as const,
        chips: ["les trous noirs", "Monde"],
        newsMemory: true,
      };
      const services = {
        models: async () => ({ llm: [], tts: [], fetchedAt: 0 }),
        topicAiredToday: (topic: string) => topic === "les trous noirs",
        nextFreshTopic: () => "Monde",
      };
      const rotated = await planSegment({ mode: "news", topic: "les trous noirs" }, settings, undefined, services);
      expect(rotated.rotatedFrom).toBe("les trous noirs");
      expect(rotated.topic).toBe("Monde");
      expect(rotated.stages.some((s) => s.name === "rotation de sujet")).toBe(true);

      // Sujet encore neuf : le bulletin garde le sujet demandé.
      const kept = await planSegment({ mode: "news", topic: "les trous noirs" }, settings, undefined, {
        ...services,
        topicAiredToday: () => false,
      });
      expect(kept.rotatedFrom).toBeUndefined();
      expect(kept.topic).toBe("les trous noirs");
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });
});

describe("prompt de débat", () => {
  const prompt = debatePrompt({
    topic: "IA & tech",
    question: "Faut-il réguler les modèles d'IA ?",
    items: [],
    locale: "fr",
    hosts: HOSTS,
    listener: LISTENER,
    tutoiement: true,
    cadenceSec: 90,
    styleNote: "",
    knowledge: true,
  });

  test("les rôles, le modérateur et l'alternance sont imposés", () => {
    expect(prompt.user).toContain("DÉBAT CONTRADICTOIRE");
    expect(prompt.user).toContain("Lila");
    expect(prompt.user).toContain("Marcel");
    expect(prompt.user).toContain("Alex");
    expect(prompt.user).toContain("alternance stricte");
    expect(prompt.user).toContain("modérateur");
    expect(prompt.user).toContain("de mémoire");
    expect(prompt.user).toContain('"usedSources": []');
  });

  test("les règles d'antenne restent en place (pas de média, pas d'heure)", () => {
    expect(prompt.system).toContain("ne nommes JAMAIS un média");
    expect(prompt.system).toContain("NI l'heure NI la date");
  });
});

describe("bulletin — point de situation", () => {
  const base = {
    items: [],
    locale: "fr" as const,
    topic: "Monde",
    hosts: HOSTS,
    duo: true,
    listener: LISTENER,
    tutoiement: true,
    cadenceSec: 60,
    maxSources: 5,
    styleNote: "",
  };
  const items = [
    { title: "Une info", url: "https://exemple.fr/a", source: "exemple.fr", publishedAt: null, summary: "", feed: "test", lang: "fr" as const },
  ];

  test("sans sujet recyclé, aucune consigne de répétition", () => {
    expect(bulletinPrompt({ ...base, items }).user).not.toContain("DÉJÀ été diffusés");
  });

  test("avec des sujets déjà traités, le modèle doit l'annoncer sobrement", () => {
    const user = bulletinPrompt({ ...base, items, recycledCount: 2 }).user;
    expect(user).toContain("DÉJÀ été diffusés");
    expect(user).toContain("depuis notre dernier point");
  });
});

describe("flux podcast", () => {
  const show = (over: Partial<ShowEntry>): ShowEntry => ({
    id: "2026-10-05/09-00-00_ia-tech_bulletin",
    day: "2026-10-05",
    file: "09-00-00_ia-tech_bulletin.mp3",
    title: "Titres — Tech & IA",
    kind: "news",
    knowledge: false,
    topic: "IA & tech",
    searchQuery: "intelligence artificielle",
    createdAt: "2026-10-05T09:00:00.000Z",
    clock: "09:00:00",
    durationSec: 61,
    speakers: [],
    turns: [],
    words: null,
    transcript: "Bonjour & bienvenue <chez nous>.",
    sources: [{ index: 1, title: "Une source", source: "exemple.fr", url: "https://exemple.fr" }],
    reports: [],
    llm: null,
    tts: null,
    sourceCount: 1,
    costUsd: 0,
    url: "/api/shows/2026-10-05/09-00-00_ia-tech_bulletin.mp3",
    sizeBytes: 123_456,
    ...over,
  });

  test("le feed est un RSS valide avec une enclosure par émission", () => {
    const feed = renderPodcastFeed([show({}), show({ id: "2026-10-05/10-00-00_q_question", kind: "question", title: "Question — le climat" })], "http://localhost:3002");
    const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(feed) as Record<string, any>;
    const channel = doc.rss.channel;
    expect(doc.rss["@_version"]).toBe("2.0");
    expect(Array.isArray(channel.item) ? channel.item.length : 1).toBe(2);
    const first = Array.isArray(channel.item) ? channel.item[0] : channel.item;
    expect(first.enclosure["@_type"]).toBe("audio/mpeg");
    expect(first.enclosure["@_length"]).toBe("123456");
    expect(first.enclosure["@_url"]).toBe("http://localhost:3002/api/shows/2026-10-05/09-00-00_ia-tech_bulletin.mp3");
    expect(channel.title).toContain("AI News Radio");
  });

  test("les caractères XML spéciaux sont échappés", () => {
    const feed = renderPodcastFeed([show({ title: "A & B <script>" })], "http://localhost:3002");
    expect(feed).toContain("A &amp; B &lt;script&gt;");
    expect(() => new XMLParser().parse(feed)).not.toThrow();
  });
});

describe("mémoire longue — agrégation", () => {
  const entry = (over: Partial<ShowEntry>): ShowEntry => ({
    id: "x", day: "2026-10-05", file: "x.mp3", title: "Titre", kind: "news", knowledge: false,
    topic: "IA & tech", searchQuery: "q", createdAt: "2026-10-05T09:00:00.000Z", clock: "09:00:00",
    durationSec: 60, speakers: [], turns: [], words: null, transcript: "", reports: [], llm: null, tts: null,
    sourceCount: 0, costUsd: 0, url: "/x.mp3", sizeBytes: 0, sources: [], ...over,
  });

  test("totaux, classements et journées sont cohérents", () => {
    const digest = summarize(
      [
        entry({ day: "2026-10-05", clock: "09:00:00", kind: "news", topic: "IA & tech", durationSec: 60, costUsd: 0.001, sources: [{ index: 1, title: "a", source: "lemonde.fr", url: "https://lemonde.fr" }] }),
        entry({ day: "2026-10-05", clock: "10:00:00", kind: "debate", topic: "Monde", durationSec: 90 }),
        entry({ day: "2026-10-04", clock: "18:00:00", kind: "question", topic: "Santé & épidémies", knowledge: true, durationSec: 30, sources: [{ index: 1, title: "b", source: "lemonde.fr", url: "https://lemonde.fr" }] }),
      ],
      7,
    );
    expect(digest.totals).toMatchObject({ shows: 3, bulletins: 1, questions: 1, debates: 1, fromMemory: 1, durationSec: 180 });
    expect(digest.from).toBe("2026-10-04");
    expect(digest.to).toBe("2026-10-05");
    expect(digest.sources[0]).toEqual({ label: "lemonde.fr", count: 2 });
    expect(digest.topics.map((topic) => topic.label)).toContain("IA & tech");
    expect(digest.byDay[0].day).toBe("2026-10-05");
    expect(digest.byDay[0].shows[0].clock).toBe("10:00:00"); // la plus récente d'abord
    expect(digest.byDay[0].count).toBe(2);
  });
});

describe("prompts bilingues", () => {
  const EN_HOSTS = [
    { name: "Lila", voice: "en-US-JennyNeural", persona: "optimistic" },
    { name: "Marcel", voice: "en-US-GuyNeural", persona: "pessimistic" },
  ];
  const EN_LISTENER = { name: "Alex", persona: "curious" };
  const EN_ITEMS: NewsItem[] = [
    { title: "Rates cut", url: "https://e.com/a", source: "E", publishedAt: "2026-10-05T10:00:00.000Z", summary: "The central bank cut rates.", feed: "E", lang: "en", dupes: 3 },
  ];
  const base = { items: EN_ITEMS, locale: "en" as const, hosts: EN_HOSTS, listener: EN_LISTENER, tutoiement: false, cadenceSec: 60, styleNote: "" };

  /** Un prompt anglais ne doit contenir aucune consigne restée en français. */
  const FRENCH_MARKERS = [
    "Réponds", "Répondez", "mots", "Durée cible", "Structure :", "Voici les sources",
    "à l'antenne", "pose la question", "Résumé:", "Extrait:", "Sujet :", "Consigne de style",
    "Tu écris", "n'invente", "Débat", "Longueur :", "date inconnue", "aucun",
  ];
  // « Sources (3) : » et « title court » : la ponctuation française est le tell le plus fiable.
  const FRENCH_SHAPES = [/\d\s*\)(\s*) :/, /"title": "titre court/, /\{ "title": "titre court/];

  test("aucun prompt anglais ne garde de consigne en français", () => {
    const prompts = {
      query: queryPrompt("Where is inflation heading?", "en"),
      bulletin: bulletinPrompt({ ...base, topic: "Economy", duo: true, maxSources: 3 }),
      answer: answerPrompt({ ...base, question: "Where is inflation heading?", duo: true }),
      debate: debatePrompt({ ...base, topic: "AI", question: "Is AI a bubble?", knowledge: false }),
      knowledge: knowledgePrompt({ topic: "Nuclear", locale: "en", hosts: EN_HOSTS, duo: true, listener: EN_LISTENER, tutoiement: false, cadenceSec: 60, styleNote: "" }),
    };
    const leaks: string[] = [];
    for (const [name, prompt] of Object.entries(prompts)) {
      const text = `${prompt.system}\n${prompt.user}`;
      for (const marker of FRENCH_MARKERS) {
        if (text.includes(marker)) leaks.push(`${name}: « ${marker} »`);
      }
      for (const shape of FRENCH_SHAPES) {
        if (shape.test(text)) leaks.push(`${name}: forme ${shape}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  test("la requête de recherche est bien demandée en anglais", () => {
    const { system, user } = queryPrompt("Où en est l'inflation ?", "en");
    expect(system).toContain("English");
    expect(system).not.toContain("mots-clés");
    expect(user).toContain("Où en est l'inflation ?");
  });

  test("le français reste intact en locale fr", () => {
    const prompt = bulletinPrompt({
      items: [{ ...EN_ITEMS[0], lang: "fr" }], locale: "fr", topic: "Économie", hosts: HOSTS, duo: true,
      listener: LISTENER, tutoiement: true, cadenceSec: 60, maxSources: 3, styleNote: "",
    });
    expect(prompt.system).toContain("Tu es le rédacteur d'un flash radio");
    expect(prompt.user).toContain("Durée cible à l'antenne");
    expect(prompt.user).toContain("Réponds STRICTEMENT en JSON");
  });
});

// Ce que l'auditeur a écouté, et ce qu'on en retient : la règle qui décidait
// autrefois de garder ou non une histoire, sans jamais rien garder en pratique.
describe("seuil d'écoute et mémoire des passages sans source", () => {
  const source = (title: string, index: number) => ({
    index,
    title,
    source: "Le Monde",
    url: `https://example.org/${index}`,
    publishedAt: null,
    feed: "lemonde",
  });

  test("un passage compte dès 60 % écoutés, et pas à 50", () => {
    expect(countsAsHeard(50, 100, false)).toBe(false);
    expect(countsAsHeard(59, 100, false)).toBe(false);
    expect(countsAsHeard(60, 100, false)).toBe(true);
    expect(countsAsHeard(120, 100, false)).toBe(true);
  });

  test("un passage allé au bout compte, mais pas un passage terminé à zéro caractère", () => {
    // Le dernier mot n'atteint jamais le dernier caractère du transcript.
    expect(countsAsHeard(97, 100, true)).toBe(true);
    // Durée inconnue : mieux vaut ne rien mémoriser que mémoriser au hasard.
    expect(countsAsHeard(0, 100, true)).toBe(false);
    expect(countsAsHeard(10, 0, false)).toBe(false);
  });

  test("un passage sans source est mémorisé par son sujet, un passage sourcé par ses histoires", () => {
    expect(memoryEntriesFor({ title: "Trous noirs en mémoire", topic: "les trous noirs", sources: [] })).toEqual([
      { title: "Trous noirs en mémoire", topic: "les trous noirs" },
    ]);
    expect(
      memoryEntriesFor({
        title: "Bulletin — Monde",
        topic: "Monde",
        sources: [source("Une fusée européenne décolle", 0), source("Un séisme au Japon", 1)],
      }),
    ).toEqual([
      { title: "Une fusée européenne décolle", topic: "Monde" },
      { title: "Un séisme au Japon", topic: "Monde" },
    ]);
  });
});
