import { describe, expect, test } from "bun:test";
import { WaitingMusic } from "../public/js/waiting-music.js";

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
  const handlers = new Map<string, () => void>();
  const played: string[] = [];
  const released: string[] = [];
  const changed: (string | null)[] = [];
  const errors: string[] = [];
  const audio = {
    src: "", volume: 0, loop: true,
    addEventListener: (name: string, fn: () => void) => handlers.set(name, fn),
    play: async () => { played.push(audio.src); }, pause: () => {},
    removeAttribute: () => { audio.src = ""; },
  };
  const tracks = ["A", "B", "C"].map(id => ({ id, name: id, open: () => ({ url: id, release: () => released.push(id) }) }));
  const player = new WaitingMusic({ audio, tracks: async () => tracks, volume: () => 0.3, random: () => 0,
    changed: (name: string | null) => changed.push(name), error: (message: string) => errors.push(message) });
  return { audio, tracks, player, played, released, changed, errors, fire: (event: string) => handlers.get(event)?.() };
}

describe("musique d’attente aléatoire", () => {
  test("enchaîne les pistes sans répétition immédiate puis libère les URL à l’arrêt", async () => {
    const f = fixture();
    await f.player.start();
    expect(f.audio.loop).toBe(false);
    expect(f.played).toEqual(["A"]);
    expect(f.audio.volume).toBe(0.3);
    f.fire("ended"); await flush();
    expect(f.played).toEqual(["A", "B"]);
    expect(f.released).toEqual(["A"]);
    f.player.stop();
    expect(f.released).toEqual(["A", "B"]);
    expect(f.audio.src).toBe("");
    expect(f.changed.at(-1)).toBeNull();
    f.fire("ended"); await flush();
    expect(f.played).toHaveLength(2);
    await f.player.start();
    expect(f.played.at(-1)).toBe("A");
    f.player.stop();
  });

  test("un arrêt pendant le chargement rejette la réponse tardive", async () => {
    const f = fixture();
    let resolve: (value: any) => void = () => {};
    f.player.tracks = () => new Promise(r => { resolve = r; });
    const pending = f.player.start();
    f.player.stop();
    resolve(f.tracks); await pending;
    expect(f.played).toEqual([]);
    expect(f.player.active).toBe(false);
  });

  test("un fichier illisible est retiré et les erreurs restent bornées", async () => {
    const f = fixture();
    await f.player.start();
    for (let i = 0; i < 3; i++) { f.fire("error"); await flush(); }
    expect(f.played).toEqual(["A", "B", "C"]);
    expect(f.audio.src).toBe("");
    f.fire("error"); await flush();
    expect(f.played).toHaveLength(3);
    f.player.stop();
  });

  test("un refus d’autoplay est signalé sans relance infinie", async () => {
    const f = fixture();
    f.audio.play = async () => { throw new Error("autoplay blocked"); };
    await f.player.start();
    expect(f.player.active).toBe(false);
    expect(f.errors).toEqual(["autoplay blocked"]);
    expect(f.released).toEqual(["A"]);
  });

  test("aucune piste : pas de lecture ; un appel start répété ne double pas la lecture", async () => {
    const f = fixture();
    f.player.tracks = async () => [];
    await f.player.start();
    expect(f.played).toEqual([]);
    f.player.stop();
    f.player.tracks = async () => [f.tracks[0]];
    await Promise.all([f.player.start(), f.player.start()]);
    expect(f.played).toEqual(["A"]);
    f.player.stop();
  });
});
