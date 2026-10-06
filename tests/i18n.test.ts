/**
 * Tests de non-régression sur les correctifs de fiabilité et sur l'interface
 * bilingue (dictionnaire, bascule, interpolation).
 *   bun test
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { archiveSegment, showsRoot } from "../src/archive";
import type { Segment } from "../src/radio";
import type { AudioBytes } from "../src/tts";
import { DEFAULT_SETTINGS } from "../src/config";
import { dictionaryKeys, getLocale, setLocale, t } from "../public/js/i18n.js";

/** Un segment minimal : l'archive n'a besoin que de ces champs. */
const fakeSegment = (id: string): Segment =>
  ({
    id,
    kind: "news",
    status: "ready",
    title: "Bulletin test",
    topic: "IA & tech",
    searchQuery: "ia",
    transcript: "Bonjour, ceci est un test.",
    speakers: [{ name: "Lila", voice: "fr-FR-DeniseNeural" }],
    turns: [{ speakerIndex: 0, name: "Lila", start: 0, end: 26 }],
    words: null,
    sources: [],
    reports: [],
    stages: [],
    llm: null,
    tts: null,
    knowledge: false,
    recycled: 0,
    createdAt: new Date().toISOString(),
    audioUrl: null,
    archive: null,
    durationMs: null,
    estimatedSeconds: 1,
  }) as unknown as Segment;

const SILENCE = new Uint8Array([0xff, 0xfb, 0x90, 0x00]) as unknown as AudioBytes;

describe("archive — écriture réellement terminée", () => {
  test("le MP3 et son JSON existent dès que l'appel se résout", async () => {
    const result = await archiveSegment(fakeSegment("t1"), SILENCE, { ...DEFAULT_SETTINGS, archive: true });
    expect(result).not.toBeNull();
    try {
      // Avant correctif, les deux Bun.write n'étaient pas attendus : le chemin
      // était renvoyé alors que le fichier pouvait ne pas (encore) exister.
      const base = result!.file.replace(/\.mp3$/, "");
      expect(existsSync(result!.file)).toBe(true);
      expect(existsSync(`${base}.json`)).toBe(true);
      const saved = JSON.parse(readFileSync(`${base}.json`, "utf8")) as { title: string; transcript: string };
      expect(saved.title).toBe("Bulletin test");
      expect(saved.transcript).toBe("Bonjour, ceci est un test.");
    } finally {
      const base = result!.file.replace(/\.mp3$/, "");
      rmSync(result!.file, { force: true });
      rmSync(`${base}.json`, { force: true });
    }
  });

  test("l'archivage désactivé n'écrit rien", async () => {
    const result = await archiveSegment(fakeSegment("t2"), SILENCE, { ...DEFAULT_SETTINGS, archive: false });
    expect(result).toBeNull();
  });
});

describe("interface bilingue", () => {
  test("les deux langues couvrent exactement les mêmes clés", () => {
    const fr = dictionaryKeys("fr").sort();
    const en = dictionaryKeys("en").sort();
    expect(fr.length).toBeGreaterThan(200);
    const missingInEn = fr.filter((key) => !en.includes(key));
    const missingInFr = en.filter((key) => !fr.includes(key));
    expect({ missingInEn, missingInFr }).toEqual({ missingInEn: [], missingInFr: [] });
  });

  test("aucune traduction n'est vide", () => {
    setLocale("en");
    const empty = dictionaryKeys("en").filter((key) => !t(key));
    setLocale("fr");
    expect(empty).toEqual([]);
  });

  test("un échantillon de clés est réellement traduit en anglais", () => {
    // « Replay » et « Podcast » sont volontairement identiques dans les deux
    // langues : on évite de les mettre dans l'échantillon.
    const sample = [
      "app.tagline", "nav.settings", "console.title", "transcript.empty", "news.empty", "replay.subtitle",
      "digest.title", "play.stop", "settings.tab.models", "sources.locale.hint", "compare.title",
    ];
    setLocale("fr");
    const french = sample.map((key) => t(key));
    setLocale("en");
    const english = sample.map((key) => t(key));
    for (const [index, key] of sample.entries()) {
      expect(english[index]).not.toBe(french[index]);
      expect(english[index]).not.toBe(key);
    }
    setLocale("fr");
  });

  test("l'interpolation remplace les variables", () => {
    setLocale("fr");
    expect(t("news.replies", { n: 4 })).toContain("4");
    expect(t("topic.active", { topic: "IA", when: "bientôt" })).toContain("IA");
    expect(t("topic.active", { topic: "IA", when: "bientôt" })).toContain("bientôt");
    setLocale("en");
    expect(t("news.replies", { n: 4 })).toContain("4");
  });

  test("une clé inconnue retombe sur le français puis sur son nom", () => {
    setLocale("en");
    expect(t("cle.inconnue.du.test")).toBe("cle.inconnue.du.test");
    setLocale("fr");
  });

  test("la langue par défaut est le français et setLocale refuse l'inconnu", () => {
    expect(getLocale()).toBe("fr");
    expect(setLocale("xx")).toBe("fr");
    expect(getLocale()).toBe("fr");
  });
});

describe("contrat HTML de l’interface", () => {
  test("toutes les clés de traduction du HTML existent en FR et EN", () => {
    for (const page of ["index.html", "replay.html", "digest.html"]) {
      const html = readFileSync(new URL(`../public/${page}`, import.meta.url), "utf8");
      const keys = new Set<string>();
      for (const match of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) keys.add(match[1]);
      for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
        for (const pair of match[1].split(",")) keys.add(pair.split(":")[1].trim());
      }
      for (const locale of ["fr", "en"]) {
        const known = dictionaryKeys(locale);
        expect([...keys].filter(key => !known.includes(key))).toEqual([]);
      }
    }
  });

  test("les pages ne contiennent aucun identifiant dupliqué", () => {
    for (const page of ["index.html", "replay.html", "digest.html"]) {
      const html = readFileSync(new URL(`../public/${page}`, import.meta.url), "utf8");
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
      expect(ids.length).toBe(new Set(ids).size);
    }
  });
});

describe("archives — intégrité du dossier", () => {
  test("showsRoot pointe bien sur le dossier du projet", () => {
    expect(showsRoot()).toMatch(/shows$/);
  });
});