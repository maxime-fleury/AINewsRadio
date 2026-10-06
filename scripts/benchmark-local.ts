import { mp3DurationMs } from "../src/tts";
const text = "Bonjour Alex. On continue notre émission : un trou noir se forme quand une étoile massive s’effondre.";
const rounds = [];
for (let index = 0; index < 2; index++) {
  const start = performance.now();
  const res = await fetch("http://127.0.0.1:8765/audio/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: text, language: "fr", voice: "host-1" }), signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(await res.text());
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ms = Math.round(performance.now() - start);
  const durationMs = Math.round(mp3DurationMs(bytes));
  await Bun.write(`reports/chatterbox-fr-${index + 1}.mp3`, bytes);
  rounds.push({ ms, durationMs, realTimeFactor: ms / durationMs, costUsd: 0, bytes: bytes.length });
  await Bun.write("reports/chatterbox-benchmark.json", JSON.stringify({ model: "chatterbox-multilingual-v3", gpu: "RTX 4060 Ti 16GB", text, rounds }, null, 2));
  console.log(rounds.at(-1));
}
