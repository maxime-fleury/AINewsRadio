import { APP_NAME, PORT_RANGE } from "./config";
import { loadMemory, memorySummary } from "./memory";
import { getModels } from "./openrouter";
import { hydrateHistory, loadStats } from "./radio";
import { ensureModelDefaults, handleApi, serveStatic } from "./routes";
import { getSettings, loadSettings } from "./settings";
import { edgeVoices } from "./tts";

loadSettings();
const settings = getSettings();
// Compteurs cumulés + dernières émissions : la console repart là où on l'avait laissée.
loadStats();
const restored = hydrateHistory();
loadMemory();
const memory = memorySummary();

async function fetchHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    const api = await handleApi(req, url);
    if (api) return api;
    const asset = await serveStatic(url.pathname, req.method);
    if (asset) return asset;
    return new Response("404 — rien ici. Essayez /", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (err) {
    console.error(`[server] ${req.method} ${url.pathname}:`, err);
    return new Response(`500 — ${(err as Error).message}`, { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

/**
 * Starts on 3000 by default and walks up to 3600 when something else owns the
 * port. `PORT=3002 bun run dev` forces one port (useful when several instances
 * or other projects share the machine).
 */
function startServer() {
  const forced = Number(process.env.PORT);
  const ports = Number.isInteger(forced) && forced > 0
    ? [forced]
    : Array.from({ length: PORT_RANGE[1] - PORT_RANGE[0] + 1 }, (_, index) => PORT_RANGE[0] + index);
  for (const port of ports) {
    try {
      return Bun.serve({
        port,
        hostname: process.env.HOST ?? "127.0.0.1",
        // Long LLM + TTS round trips need more than Bun's 10s default.
        idleTimeout: 180,
        fetch: fetchHandler,
      });
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (!/in use|EADDRINUSE/i.test(message)) throw err;
    }
  }
  return null;
}

const server = startServer();
if (!server) {
  const forced = Number(process.env.PORT);
  console.error(Number.isInteger(forced) && forced > 0
    ? `Port ${forced} déjà occupé — arrêt.`
    : `Aucun port libre entre ${PORT_RANGE[0]} et ${PORT_RANGE[1]} — arrêt.`);
  process.exit(1);
}

const url = `http://localhost:${server.port}`;
console.log(`
  🔮  ${APP_NAME}
  ─────────────────────────────────────────────
  Antenne: ${url}
  Clé OpenRouter: ${settings.openrouterKey ? "configurée" : "absente (mode titres bruts)"}
  Voix: ${settings.ttsProvider === "edge" ? `Edge TTS · ${settings.ttsVoice}` : `OpenRouter · ${settings.ttsModel}`}
  Cadence: ${settings.cadenceSec}s   Locale: ${settings.locale}
  Historique: ${restored ? `${restored} émission(s) rechargée(s) depuis les archives` : "vide (aucune archive)"}
  Mémoire: ${memory.total} histoire(s) en mémoire${memory.today ? `, dont ${memory.today} aujourd'hui` : ""}
  ─────────────────────────────────────────────
`);

// Warm the model catalogue and the voice list so the first "play" is fast.
void (async () => {
  try {
    const { llm, tts } = await getModels();
    await ensureModelDefaults();
    console.log(`  catalogue: ${llm.length} modèles texte, ${tts.length} modèles TTS`);
  } catch (err) {
    console.error("[boot] catalogue indisponible:", (err as Error).message);
  }
  try {
    const voices = await edgeVoices(getSettings().locale);
    console.log(`  voix Edge disponibles: ${voices.length}`);
  } catch (err) {
    console.error("[boot] voix indisponibles:", (err as Error).message);
  }
})();
