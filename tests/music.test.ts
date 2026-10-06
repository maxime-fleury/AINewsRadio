/**
 * Fond musical d'attente : le contrat entre les identifiants d'ambiance, les
 * pistes livrées et les extensions acceptées. Le réglage `musicFolder` laisse
 * l'auditeur brancher son propre dossier, on vérifie donc aussi le filtrage des
 * noms de fichiers et le type MIME déduit — c'est ce que sert /api/music/file.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { musicReport } from "../src/routes";
import { DEFAULT_SETTINGS, isMusicFile, isMusicMood, musicMime, musicMoodFile, MUSIC_MOODS } from "../src/config";

describe("fond musical — réglages et pistes", () => {
  test("seules les ambiances connues sont acceptées", () => {
    for (const mood of MUSIC_MOODS) expect(isMusicMood(mood.id)).toBe(true);
    expect(isMusicMood("aucun")).toBe(true);
    for (const junk of ["", " ", "Electro", "electro ", "techno", "0", 42, null, undefined, {}, []]) {
      expect(isMusicMood(junk)).toBe(false);
    }
  });

  test("chaque ambiance pointe sur la piste livrée du même nom", () => {
    for (const mood of MUSIC_MOODS) expect(musicMoodFile(mood.id)).toBe(`bed-${mood.id}.mp3`);
    expect(musicMoodFile("aucun")).toBeNull();
  });

  test("le fond musical d'attente est actif par défaut, sans dossier imposé", () => {
    expect(DEFAULT_SETTINGS.musicMood).toBe("ambient");
    expect(DEFAULT_SETTINGS.musicFolder).toBe("");
  });

  test("seuls les fichiers audio sont retenus, fichiers cachés compris", () => {
    for (const name of ["mon son.mp3", "titre.ogg", "bed.MP3", "piste.m4a", "x.flac", "y.aac", "z.wav"]) {
      expect(isMusicFile(name)).toBe(true);
    }
    for (const name of ["notes.txt", "pochette.jpg", ".cache.mp3", "sans-extension", ""]) {
      expect(isMusicFile(name)).toBe(false);
    }
  });

  test("le dossier serveur liste uniquement les fichiers audio réels, avec des URL échappées", () => {
    const folder = mkdtempSync(join(tmpdir(), "radio-music-test-"));
    try {
      writeFileSync(join(folder, "été & jazz.MP3"), "test");
      writeFileSync(join(folder, "piste.ogg"), "test");
      writeFileSync(join(folder, "notes.txt"), "test");
      writeFileSync(join(folder, ".cache.mp3"), "test");
      mkdirSync(join(folder, "pas-une-piste.mp3"));
      const report = musicReport({ musicMood: "ambient", musicFolder: folder });
      expect(report.source).toBe("folder");
      expect(report.tracks).toHaveLength(2);
      const names = report.tracks.map(url => new URL(url, "http://localhost").searchParams.get("name")).sort();
      expect(names).toEqual(["piste.ogg", "été & jazz.MP3"].sort());
      expect(musicReport({ musicMood: "aucun", musicFolder: folder }).tracks).toEqual([]);
      expect(musicReport({ musicMood: "ambient", musicFolder: join(folder, "absent") }).error).toBe("unreadable");
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  test("le type MIME suit l'extension", () => {
    expect(musicMime("mon son.mp3")).toBe("audio/mpeg");
    expect(musicMime("bed.OGG")).toBe("audio/ogg");
    expect(musicMime("titre.m4a")).toBe("audio/mp4");
    expect(musicMime("notes.txt")).toBe("application/octet-stream");
    expect(musicMime("sans-extension")).toBe("application/octet-stream");
  });
});
