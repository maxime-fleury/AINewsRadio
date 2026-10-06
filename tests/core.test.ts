/**
 * Tests unitaires des fonctions critiques (aucun réseau, aucun disque) :
 * regroupement des dépêches, prompts, slug d'archive et alignement du transcript.
 *   bun test
 */
import { describe, expect, test } from "bun:test";
import { slugify } from "../src/archive";
import { enforceDuo, extractJson, normalizeSpoken, planFromModel, splitScriptBetweenHosts } from "../src/llm";
import { dedupeByStory, rankByRelevance, type NewsItem } from "../src/news";
import { buildTokens, prepareSegment, tokenIndexAt, alignWords } from "../public/js/transcript.js";

const HOSTS = [
  { name: "Lila", voice: "fr-FR-DeniseNeural", persona: "optimiste" },
  { name: "Marcel", voice: "fr-FR-HenriNeural", persona: "pessimiste" },
];

const item = (title: string, source: string): NewsItem => ({
  title,
  url: `https://${source}/article`,
  source,
  publishedAt: "2026-10-05T10:00:00.000Z",
  summary: "",
  feed: "test",
  lang: "fr",
});

describe("news — regroupement des mêmes histoires", () => {
  const stories = [
    item("Présidentielle au Brésil : Flavio Bolsonaro crée la surprise en devançant Lula au premier tour", "s.france24.com"),
    item("Présidentielle au Brésil : Flavio Bolsonaro devance Lula et l'affrontera au second tour", "lemonde.fr"),
    item("Au Brésil, Flavio Bolsonaro devance Lula au premier tour de la présidentielle", "france24.com"),
    item("Alerte près de la base de Fairford : les États-Unis retirent leurs bombardiers", "ouest-france.fr"),
  ];

  test("les dépêches d'une même histoire fusionnent, les autres restent séparées", () => {
    const out = dedupeByStory(stories);
    expect(out.length).toBe(2);
    expect(out[0].dupes).toBe(3);
    expect(out[1].title).toContain("Fairford");
  });

  test("la pertinence classe le sujet demandé en tête", () => {
    const ranked = rankByRelevance([...stories].reverse(), "Brésil", "fr");
    expect(ranked[0].title).toContain("Brésil");
  });
});

describe("llm — dialogue", () => {
  test("planFromModel garde l'alternance et filtre les sources hors bornes", () => {
    const plan = planFromModel(
      JSON.stringify({
        title: "Titre",
        turns: [
          { speaker: "Lila", text: "Bonjour Alex, voici l'essentiel." },
          { speaker: "Marcel", text: "Attends, Lila, je nuance." },
        ],
        usedSources: [3, 1, 9, 1],
      }),
      3,
      HOSTS,
      true,
    );
    expect(plan.turns.map((turn) => turn.speakerIndex)).toEqual([0, 1]);
    expect(plan.usedSources).toEqual([3, 1]);
  });

  test("un monologue est redistribué sur les deux voix", () => {
    const mono = enforceDuo(
      [
        { speakerIndex: 0, name: "Lila", text: "Première info." },
        { speakerIndex: 0, name: "Lila", text: "Deuxième info." },
      ],
      HOSTS,
      true,
    );
    expect(mono.map((turn) => turn.speakerIndex)).toEqual([0, 1]);
  });

  test("un script d'une seule voix est découpé par phrases", () => {
    const turns = splitScriptBetweenHosts("Un. Deux. Trois.", HOSTS, true);
    expect(turns.length).toBe(2);
    expect(turns[0].text).toBe("Un. Deux.");
    expect(turns[1].text).toBe("Trois.");
  });

  test("extractJson lit le JSON encadré ou noyé dans du texte", () => {
    expect(extractJson('```json\n{"title":"ok"}\n```')?.title).toBe("ok");
    expect(extractJson('Voici le script : {"turns":[]} — voilà.')?.turns).toEqual([]);
  });

  test("normalizeSpoken retire markdown et emoji", () => {
    const spoken = normalizeSpoken("**Salut** 🙃 à tous");
    expect(spoken).toContain("Salut");
    expect(spoken).not.toContain("*");
    expect(spoken).not.toContain("🙃");
  });
});

describe("archive — slug de fichier", () => {
  test("accents, espaces et majuscules", () => {
    expect(slugify("Science & découvertes")).toBe("science-decouvertes");
    expect(slugify("Dernière info")).toBe("derniere-info");
    expect(slugify("")).toBe("");
  });
});

describe("transcript — alignement mot à mot", () => {
  test("buildTokens garde phrases et mots", () => {
    const { tokens, sentences } = buildTokens("Bonjour Alex. Ça va ?");
    expect(tokens.length).toBe(5);
    expect(sentences.length).toBe(2);
  });

  test("alignWords recolle un mot coupé en deux (« start-up »)", () => {
    const { tokens } = buildTokens("Le start-up décolle.");
    const aligned = alignWords(tokens, [
      { text: "Le", startMs: 0, endMs: 200 },
      { text: "start", startMs: 200, endMs: 400 },
      { text: "up", startMs: 400, endMs: 600 },
      { text: "décolle.", startMs: 600, endMs: 1000 },
    ]);
    expect(aligned).toBe(true);
    expect(tokens[1].startMs).toBe(200);
    expect(tokens[1].endMs).toBe(600);
    expect(tokens[0].startMs).toBeLessThanOrEqual(tokens[1].startMs);
  });

  test("prepareSegment étale la durée sur les mots, tokenIndexAt suit la timeline", () => {
    const { tokens } = prepareSegment(
      { transcript: "Un deux trois quatre.", turns: [], words: null, estimatedSeconds: 4 },
      4,
    );
    expect(tokens.length).toBe(4);
    expect(tokenIndexAt(tokens, -5)).toBe(-1);
    expect(tokenIndexAt(tokens, 999_999)).toBe(3);
    expect(tokenIndexAt(tokens, tokens[2].startMs)).toBe(2);
  });
});
