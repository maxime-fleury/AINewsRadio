import { describe, expect, test } from "bun:test";
import { RadioEngine, costProjection } from "../public/js/engine.js";

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const segment = (id: string, topic = "A") => ({ id, topic, transcript: `Passage ${id}. Une explication nouvelle.`, audioUrl: `/audio/${id}` });
function fixture(prefetch = 1) {
  const jobs: { req: any; signal: AbortSignal; resolve: (value: any) => void; reject: (err: Error) => void }[] = [];
  const played: string[] = [];
  const heard: any[] = [];
  let topic = "A";
  let progress = 0;
  const engine = new RadioEngine({
    build: (req: any, signal: AbortSignal) => new Promise((resolve, reject) => jobs.push({ req, signal, resolve, reject })),
    play: (s: any, restart: boolean) => played.push(`${s.id}:${restart}`),
    pause: () => {}, stop: () => {}, state: () => {}, error: () => {},
    progress: (s: any, complete: boolean) => complete ? s.transcript.length : progress,
    heard: (...args: any[]) => heard.push(args),
    request: () => ({ mode: "news", topic, prefetch }), delay: 1,
  });
  return { engine, jobs, played, heard, topic: (value: string) => { topic = value; }, progress: (value: number) => { progress = value; } };
}

describe("radio scheduler", () => {
  test("stop during generation rejects late completion, restart creates a fresh segment", async () => {
    const f = fixture(0);
    f.engine.start();
    f.engine.stop();
    expect(f.jobs[0].signal.aborted).toBe(true);
    f.jobs[0].resolve(segment("stale"));
    await flush();
    expect(f.played).toEqual([]);
    expect(f.engine.current).toBeNull();
    f.engine.start();
    f.jobs[1].resolve(segment("fresh"));
    await flush();
    expect(f.played).toEqual(["fresh:true"]);
    f.engine.stop();
  });
  test("pause preserves audio and ready queue, no generation until resume", async () => {
    const f = fixture();
    f.engine.start(); f.jobs[0].resolve(segment("one")); await flush();
    f.jobs[1].resolve(segment("two")); await flush();
    f.engine.pause();
    expect(f.engine.queue).toHaveLength(1);
    expect(f.jobs).toHaveLength(2);
    f.engine.start();
    expect(f.played.at(-1)).toBe("one:false");
    f.engine.ended(); await flush();
    expect(f.played.at(-1)).toBe("two:true");
    f.engine.stop(); f.jobs[2]?.resolve(segment("late")); await flush();
  });
  test("topic change discards old prefetch without cutting current audio", async () => {
    const f = fixture();
    f.engine.start(); f.jobs[0].resolve(segment("one")); await flush();
    f.topic("B"); f.engine.changeTopic();
    expect(f.engine.current.id).toBe("one");
    expect(f.jobs[1].signal.aborted).toBe(true);
    f.jobs[1].resolve(segment("old")); await flush();
    expect(f.jobs[2].req.topic).toBe("B");
    f.jobs[2].resolve(segment("new", "B")); await flush();
    f.engine.ended(); await flush();
    expect(f.played).toEqual(["one:true", "new:true"]);
    f.engine.stop(); f.jobs[3]?.resolve(segment("late")); await flush();
  });
  test("three clips warm up, ready clips continue while an answer is built, answer plays next", async () => {
    const f = fixture(3);
    f.engine.start();
    f.jobs[0].resolve(segment("one")); await flush();
    expect(f.played).toEqual([]);
    f.jobs[1].resolve(segment("two")); await flush();
    expect(f.played).toEqual([]);
    f.jobs[2].resolve(segment("three")); await flush();
    expect(f.played).toEqual(["one:true"]);
    f.engine.enqueue({ mode: "question", question: "Pourquoi ?" });
    f.jobs[3].resolve(segment("stale")); await flush();
    expect(f.engine.queue.map((s: any) => s.id)).toEqual(["two", "three"]);
    f.engine.ended(); await flush();
    expect(f.played).toEqual(["one:true", "two:true"]);
    f.jobs[4].resolve(segment("answer")); await flush();
    expect(f.engine.queue.map((s: any) => s.id)).toEqual(["answer", "three"]);
    f.engine.ended(); await flush();
    expect(f.played.at(-1)).toBe("answer:true");
    f.engine.stop(); f.jobs[5]?.resolve(segment("late")); await flush();
  });
  test("question waits for current segment, has priority and preserves heard context", async () => {
    const f = fixture();
    f.engine.start(); f.jobs[0].resolve(segment("one")); await flush();
    f.progress(12);
    f.engine.enqueue({ mode: "question", question: "Pourquoi ?", topic: "A" });
    f.jobs[1].resolve(segment("abandoned")); await flush();
    expect(f.jobs[2].req.context[0].text).toBe(segment("one").transcript.slice(0, 12));
    expect(f.jobs[2].req.question).toBe("Pourquoi ?");
    f.jobs[2].resolve(segment("answer")); await flush();
    expect(f.played).toEqual(["one:true"]);
    f.engine.ended(); await flush();
    expect(f.played).toEqual(["one:true", "answer:true"]);
    expect(f.heard.some(x => x[2] === true)).toBe(true);
    f.engine.stop(); f.jobs[3]?.resolve(segment("late")); await flush();
  });
  test("immediate question interrupts and pause never resumes from late completion", async () => {
    const f = fixture();
    f.engine.start(); f.jobs[0].resolve(segment("one")); await flush();
    f.engine.enqueue({ mode: "question", question: "Maintenant" }, true);
    expect(f.engine.current).toBeNull();
    f.jobs[1].resolve(segment("old")); await flush();
    f.engine.pause(); f.jobs[2].resolve(segment("answer")); await flush();
    expect(f.played).toEqual(["one:true"]);
    expect(f.engine.running).toBe(false);
    f.engine.stop();
  });
  test("audio error retries, three consecutive failures stop the loop", async () => {
    const f = fixture(0);
    f.engine.start(); f.jobs[0].resolve(segment("one")); await flush();
    f.engine.audioError("broken");
    await Bun.sleep(10);
    expect(f.jobs).toHaveLength(2);
    f.jobs[1].reject(new Error("failed")); await flush(); await Bun.sleep(10);
    f.jobs[2].reject(new Error("failed again")); await flush();
    expect(f.engine.running).toBe(false);
    expect(f.jobs).toHaveLength(3);
    f.engine.stop();
  });
  test("ten-second transition is cancellable and does not restart after Stop", async () => {
    const f = fixture(0);
    const transitions: { signal: AbortSignal; resolve: () => void }[] = [];
    f.engine.beforePlay = (_s: any, signal: AbortSignal) => new Promise<void>(resolve => transitions.push({ signal, resolve }));
    f.engine.start(); f.jobs[0].resolve(segment("one")); await flush();
    expect(f.played).toEqual([]);
    expect(f.engine.needsIntro).toBe(true);
    f.engine.pause();
    expect(transitions[0].signal.aborted).toBe(true);
    transitions[0].resolve(); await flush();
    expect(f.played).toEqual([]);
    f.engine.start(); transitions[1].resolve(); await flush();
    expect(f.played).toEqual(["one:true"]);
    f.engine.ended(); f.jobs[1].resolve(segment("two")); await flush();
    f.engine.stop(); transitions[2].resolve(); await flush();
    expect(f.played).toEqual(["one:true"]);
  });
  test("a topic change during the intro cancels the old segment", async () => {
    const f = fixture(0);
    let finish: () => void = () => {};
    f.engine.beforePlay = (_s: any, signal: AbortSignal) => new Promise<void>(resolve => { finish = resolve; expect(signal.aborted).toBe(false); });
    f.engine.start(); f.jobs[0].resolve(segment("one")); await flush();
    f.topic("B"); f.engine.changeTopic(); finish(); await flush();
    expect(f.played).toEqual([]);
    expect(f.jobs[1].req.topic).toBe("B");
    f.engine.stop(); f.jobs[1].resolve(segment("late")); await flush();
  });
  test("la mémoire reçoit la position atteinte, et l'état du passage", async () => {
    const f = fixture(0);
    f.engine.start(); f.jobs[0].resolve(segment("one")); await flush();
    f.progress(5);
    f.engine.capture();
    expect(f.heard.at(-1)[1]).toBe(5);
    expect(f.heard.at(-1)[2]).toBe(false); // coupé : c'est le serveur qui applique le seuil
    f.engine.ended(); await flush();
    expect(f.heard.at(-1)[1]).toBe(segment("one").transcript.length);
    expect(f.heard.at(-1)[2]).toBe(true); // allé au bout
    f.engine.stop();
  });
  test("context is bounded and does not contain prefetched but unheard audio", async () => {
    const f = fixture(0);
    for (let i = 0; i < 9; i++) {
      f.engine.replay(segment(String(i))); f.progress(10); f.engine.capture(true);
    }
    expect(f.engine.context()).toHaveLength(6);
    expect(f.engine.context()[0].id).toBe("3");
    f.engine.clearConversation(); expect(f.engine.conversation).toEqual([]);
    f.engine.stop();
  });
});

describe("cost projection", () => {
  test("waits for one minute and includes both generation costs", () => {
    expect(costProjection({ audioSeconds: 59, totalCostUsd: 0.1 })).toBeNull();
    expect(costProjection({ audioSeconds: 60, totalCostUsd: 0.01 })).toEqual({ perMinute: 0.01, perHour: 0.6 });
    expect(costProjection({ audioSeconds: 120, totalCostUsd: 0.04 })).toEqual({ perMinute: 0.02, perHour: 1.2 });
    expect(costProjection({ audioSeconds: 120, totalCostUsd: 0 })).toEqual({ perMinute: 0, perHour: 0 });
  });
});
