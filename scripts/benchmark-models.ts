import { mkdirSync } from "node:fs";
import { loadSettings, getSettings } from "../src/settings";
import { getModels, chat } from "../src/openrouter";
import { compare } from "../src/tts";

loadSettings();
const settings = getSettings();
const { llm, tts } = await getModels();
const text = "Bonjour Alex. Aujourd'hui, on explore les trous noirs : comment se forment-ils, et pourquoi la lumière ne peut-elle pas en sortir ?";
const shortlist = tts.filter(m => m.per1k >= 0 && m.per1k <= 0.011).slice(0, 5);
const rounds = [];
mkdirSync("reports", { recursive: true });
for (let round = 0; round < 2; round++) {
  const rows = await compare(text, shortlist.map(m => `or:${m.id}`), settings, AbortSignal.timeout(60000), round === 0);
  const publicRows = [];
  for (const row of rows) {
    const { audio, ...metrics } = row;
    let sample: string | undefined;
    if (audio) {
      sample = `reports/${row.model.replace(/[^a-z0-9]+/gi, "-")}.mp3`;
      await Bun.write(sample, Buffer.from(audio.split(",")[1], "base64"));
    }
    publicRows.push({ ...metrics, sample });
  }
  rounds.push(publicRows);
  await Bun.write("reports/model-benchmark.json", JSON.stringify({ measuredAt: new Date().toISOString(), text, rounds }, null, 2));
  console.log(JSON.stringify({ round: round + 1, rows: publicRows }, null, 2));
}
const started = performance.now();
try {
  const result = await chat({ key: settings.openrouterKey, model: "tencent/hy3", system: "Écris un dialogue radio en français. Réponds en JSON avec title, turns (speaker, text), usedSources (vide).", user: 'Alex demande comment se forme un trou noir. Lila est curieuse et Marcel analytique. 4 répliques alternées, 70 mots maximum, aucun chiffre inventé.', json: true, maxTokens: 900, models: llm, signal: AbortSignal.timeout(60000) });
  const report = { ms: Math.round(performance.now() - started), ...result };
  const file = await Bun.file("reports/model-benchmark.json").json();
  await Bun.write("reports/model-benchmark.json", JSON.stringify({ ...file, hy3: report }, null, 2));
  console.log("Hy3", JSON.stringify(report));
} catch (err) {
  console.error("Hy3:", (err as Error).message);
  process.exitCode = 1;
}
