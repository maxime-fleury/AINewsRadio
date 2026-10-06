import { api } from "./api.js";
import { RadioEngine, costProjection } from "./engine.js";
import { applyI18n, count, getLocale, setLocale, t } from "./i18n.js";
import { prepareSegment, tokenIndexAt } from "./transcript.js";
import { WaitingMusic } from "./waiting-music.js";

/* ─────────────────────────── utilitaires ─────────────────────────── */

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Le séparateur décimal suit la langue : 0,0012 $ en français, $0.0012 en anglais. */
const decimalPoint = () => (getLocale() === "fr" ? "," : ".");

const fmtTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

const fmtCost = (usd) => {
  const value = Number(usd) || 0;
  const money = (digits) => `${value.toFixed(digits).replace(".", decimalPoint())} $`;
  if (value === 0) return getLocale() === "fr" ? "0,0000 $" : "$0.0000";
  if (value < 0.0001) return getLocale() === "fr" ? money(6) : `$${value.toFixed(6)}`;
  return getLocale() === "fr" ? money(4) : `$${value.toFixed(4)}`;
};

const fmtClock = (iso) =>
  new Date(iso).toLocaleTimeString(getLocale() === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const DASH = "—";

function toast(message, kind = "primary") {
  const el = document.createElement("div");
  el.className = `toast align-items-center border-0 show mb-2`;
  el.innerHTML = `<div class="d-flex"><div class="toast-body"><i class="bi bi-${kind === "danger" ? "exclamation-triangle" : "info-circle"}"></i> ${esc(message)}</div>
    <button class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 7000);
}

/* ─────────────────────────── état ─────────────────────────── */

const S = {
  settings: null,
  ready: false,
  loading: false,
  startupError: "",
  voices: [],
  hostsDefaults: [],
  defaultOrVoice: "",
  llmModels: [],
  ttsModels: [],
  presets: { feeds: [], locales: [], cadenceOptions: [], ttsPresets: [], musicMoods: [] },
  stats: { totalCostUsd: 0, segments: 0, audioSeconds: 0 },
  sessionStats: { totalCostUsd: 0, audioSeconds: 0 },
  memory: { today: 0, total: 0 },
  played: [], // histoires réellement passées à l'antenne aujourd'hui
  llmAllModels: [],
  status: "idle", // idle | working | playing | paused
  queue: [],
  cards: new Map(),
  current: null,
  activeTopic: null,
  filter: "all",
  selectedModel: null,
};

const audio = new Audio();
audio.preload = "auto";
audio.volume = 0.9;

/** Dernier niveau non nul, pour que la sourdine le rende tel quel au retour. */
let lastVolume = 0.9;

/**
 * Applique le volume général à toutes les pistes : la voix, l'annonce, le jingle
 * et le fond musical. Le fond garde sa proportion sous ce niveau, la sourdine
 * coupe donc aussi la musique (voir bedLevel).
 */
function applyVolume() {
  const requested = Number($("volume").value);
  if (Number.isFinite(requested) && requested > 0) lastVolume = requested;
  audio.volume = Number.isFinite(requested) ? requested : 0.9;
  introAudio.volume = audio.volume;
  if (!musicBed.paused) musicBed.volume = bedLevel(BED_LEVEL);
  if (!jingle.paused) jingle.volume = bedLevel(JINGLE_LEVEL);
  $("muteIcon").className = `bi ${audio.volume === 0 ? "bi-volume-mute" : audio.volume < 0.5 ? "bi-volume-down" : "bi-volume-up"}`;
  $("muteBtn").setAttribute("aria-pressed", String(audio.volume === 0));
}

/* ─────────────────────────── statut & file ─────────────────────────── */

function setStatus(status) {
  S.status = status;
  const pill = $("statusPill");
  pill.className = "status-pill";
  const labels = {
    idle: t("console.status.idle"),
    working: t("console.status.working"),
    playing: t("console.status.playing"),
    paused: t("console.status.paused"),
  };
  let text = labels[status];
  if (status === "playing") pill.classList.add("live");
  if (status === "working") pill.classList.add("working");
  if (status === "paused") pill.classList.add("paused");
  if (status === "paused") text = t("console.status.pausedNote");
  $("statusText").textContent = text;
  const consoleState = $("consoleState");
  if (consoleState) consoleState.textContent = text;
  $("playIcon").className = `bi ${status === "playing" || status === "working" ? "bi-pause-fill" : "bi-play-fill"}`;
  $("playBtn").setAttribute("aria-label", t(status === "playing" || status === "working" ? "welcome.pause" : status === "paused" ? "welcome.resume" : "welcome.play"));
  $("eq").classList.toggle("on", status === "playing");
  $("askHint").classList.toggle("text-secondary", status !== "idle");
  renderListeningState();
}

/** Un seul rendu pour l'accueil, les capacités et les commandes du lecteur. */
function renderListeningState() {
  const ready = S.ready;
  const running = S.status === "playing" || S.status === "working";
  const hasAudio = !!engine.current && !!S.current;
  const empty = !S.current;
  $("listenWelcome").hidden = !empty;
  $("transcript").classList.toggle("d-none", empty);
  $("welcomeTopic").textContent = S.activeTopic ?? S.settings?.topic ?? DASH;
  $("welcomePlay").disabled = !ready;
  $("playBtn").disabled = !ready;
  $("welcomePlayLabel").textContent = t(!ready ? "welcome.loading" : running ? "welcome.pause" : S.status === "paused" ? "welcome.resume" : "welcome.play");
  $("welcomePlay").querySelector("i").className = `bi ${running ? "bi-pause-fill" : "bi-play-fill"}`;
  $("welcomeNote").textContent = S.startupError ? "" : t(!ready ? "welcome.loading" : running ? "welcome.preparing" : "welcome.note");
  $("startupError").hidden = !S.startupError;
  $("startupErrorText").textContent = S.startupError;
  $("startupRetry").disabled = S.loading;
  $("stopBtn").disabled = !ready || !(running || engine.current || engine.queue.length || engine.requests.length);
  $("skipBtn").disabled = !ready || !engine.current;
  for (const id of ["backBtn", "fwdBtn"]) $(id).disabled = !hasAudio;
  for (const id of ["radioMode", "topicInput", "topicApply", "cadenceQuick", "questionTiming", "questionInput", "conversationClear", "musicChoose"]) $(id).disabled = !ready;
  $("searchInterval").disabled = !ready || S.settings?.radioMode === "explore";
  $("askBtn").disabled = !ready || !$("questionInput").value.trim();
  $("debateBtn").disabled = !ready || !S.settings?.hasKey || S.settings?.hostCount !== 2;    const hint = !ready ? "welcome.loading" : !S.settings.hasKey ? "ask.needsKey" : S.settings.hostCount !== 2 ? "ask.debate.needsDuo" : "ask.hint";
  $("askHint").textContent = t(hint);
  if (empty && ready && !running) {
    $("nowSub").textContent = `${S.settings.topic} · ${t(`live.mode.${S.settings.radioMode}`)}`;
  }
}

function renderQueue() {
  $("queueDepth").textContent = String(S.queue.length);
  const items = [];
  if (S.current) items.push({ segment: S.current.segment, current: true });
  S.queue.forEach((segment) => items.push({ segment, current: false }));
  $("queueList").innerHTML = items
    .map(
      ({ segment, current }) =>
        `<div class="queue-item${current ? " current" : ""}"><span>${current ? '<i class="bi bi-broadcast"></i> ' : ""}${esc(segment.title).slice(0, 46)}</span><span>${segment.estimatedSeconds ? `${Math.round(segment.estimatedSeconds)}s` : "…"}</span></div>`,
    )
    .join("");
  const engine = S.settings?.ttsProvider === "local" ? "TTS : Chatterbox V3 local" :
    S.settings?.ttsProvider === "openrouter"
      ? `TTS : ${esc(S.settings.ttsModel.split("/").pop())}`
      : `TTS : Edge · ${esc((S.settings?.ttsVoice || "").replace("Neural", ""))}`;
  $("engineLabel").innerHTML = engine;
}

function renderStages(stages, prefix = "") {
  if (!stages?.length) return;
  $("stageLine").innerHTML =
    (prefix ? `<span class="stage">${esc(prefix)}</span>` : "") +
    stages.map((s) => `<span class="stage">${esc(s.name)} ${(s.ms / 1000).toFixed(1)}s${s.detail ? ` · ${esc(String(s.detail).slice(0, 46))}` : ""}</span>`).join("");
}

function addStat(segment) {
  S.stats.segments += 1;
  const cost = (segment.llm?.costUsd ?? 0) + (segment.tts?.costUsd ?? 0);
  S.stats.totalCostUsd += cost;
  S.sessionStats.totalCostUsd += cost;
  S.sessionStats.audioSeconds += segment.estimatedSeconds || 0;
  S.stats.audioSeconds += segment.estimatedSeconds || 0;
  if (segment.archive) S.stats.archiveCount = (S.stats.archiveCount ?? 0) + 1;
  renderStats();
}

function renderStats() {
  $("costTotal").textContent = fmtCost(S.stats.totalCostUsd);
  $("statSegments").textContent = String(S.stats.segments);
  $("statMinutes").textContent = `${(S.stats.audioSeconds / 60).toFixed(1)} ${getLocale() === "fr" ? "min" : "min"}`;
  const projection = costProjection(S.sessionStats);
  $("costRate").textContent = projection ? `${fmtCost(projection.perMinute)}/min · ${fmtCost(projection.perHour)}/h` : t("stat.rate.pending");
  const badge = $("archiveBadge");
  if (badge) badge.textContent = String(S.stats.archiveCount ?? 0);
}

/* ─────────────────────────── colonne news ─────────────────────────── */

function buildCard(segment) {
  const card = document.createElement("article");
  card.className = "news-card";
  card.dataset.kind = segment.kind;
  card.dataset.id = segment.id;
  card.innerHTML = cardInner(segment);
  card.addEventListener("click", (event) => {
    const play = event.target.closest("[data-play]");
    if (play) {
      event.preventDefault();
      engine.replay(S.cards.get(segment.id)?.segment ?? segment);
    }
  });
  return card;
}

function cardInner(segment) {
  const kindLabel = t(`news.kind.${segment.kind === "news" ? "news" : segment.kind}`);
  const kindClass = segment.kind === "question" ? "question" : segment.kind === "debate" ? "debate" : "news";
  const statusTag =
    segment.status === "ready"
      ? `<span class="tag news" style="background:rgba(74,222,128,.14);color:#86efac;border-color:rgba(74,222,128,.3)">${t("news.ready")}</span>`
      : `<span class="tag pending">${t("news.pending")}</span>`;
  const reports = (segment.reports || [])
    .map((r) => `<span class="feed-report${r.ok ? "" : " err"}" title="${esc(r.url)}">${esc(r.label.slice(0, 22))} ${r.ok ? r.count : "✕"}</span>`)
    .join("");
  const sources = (segment.sources || [])
    .map(
      (s, i) =>
        `<a class="source-item" href="${esc(s.url)}" target="_blank" rel="noreferrer"><span class="src">${i + 1}. ${esc(s.source)}${s.publishedAt ? ` · ${fmtClock(s.publishedAt)}` : ""}</span><br>${esc(s.title)}</a>`,
    )
    .join("");
  const stages = (segment.stages || []).map((s) => `<span class="stage-chip">${esc(s.name)} ${(s.ms / 1000).toFixed(1)}s</span>`).join("");
  const ttsBadge = segment.tts
    ? `<span class="stage-chip">${esc(segment.tts.provider === "edge" ? t("news.edge") : segment.tts.model)} · ${count("transcript.voices", segment.tts.voices?.length ?? 1)} · ${segment.tts.exactTimings ? t("news.timings.exact") : t("news.timings.estimated")} · ${fmtCost(segment.tts.costUsd)}</span>`
    : "";
  const speakersBadge = (segment.turns ?? []).length
    ? `<span class="stage-chip">${esc([...new Set((segment.turns ?? []).map((turn) => turn.name))].join(" + "))} · ${count("news.replies", segment.turns.length)}</span>`
    : "";
  const llmBadge = segment.knowledge
    ? `<span class="stage-chip">${t("news.knowledge")} · ${esc(segment.llm?.model.split("/").pop() ?? "LLM")} · ${fmtCost(segment.llm?.costUsd ?? 0)}</span>`
    : segment.llm?.used ? `<span class="stage-chip">${esc(segment.llm.model.split("/").pop())} · ${segment.llm.inTokens + segment.llm.outTokens} tok · ${fmtCost(segment.llm.costUsd)}</span>` : `<span class="stage-chip">${t("news.noLlm")}</span>`;
  return `
    <div class="nc-head">
      <span class="tag ${kindClass}">${kindLabel}</span>
      ${statusTag}
      <span class="ms-auto">${fmtClock(segment.createdAt)}${segment.estimatedSeconds ? ` · ${Math.round(segment.estimatedSeconds)}s` : ""}</span>
    </div>
    <div class="nc-title">${esc(segment.title || DASH)}</div>
    ${segment.question ? `<div class="search-line"><i class="bi bi-patch-question"></i> ${esc(segment.question)}</div>` : ""}
    <div class="search-line"><i class="bi bi-${segment.knowledge ? "lightbulb" : "search"}"></i> ${esc(segment.searchQuery || DASH)}${segment.knowledge ? ` · ${t("news.noWire")}` : segment.sources?.length ? ` ${t("news.kept", { n: segment.sources.length })}` : ""}</div>
    <div class="feed-reports">${reports}</div>
    ${sources ? `<div class="sources">${sources}</div>` : `<p class="muted-note">${segment.knowledge ? t("news.noSources.memory") : t("news.noSources")}</p>`}
    <div class="stage-chips">${stages}${segment.rotatedFrom ? `<span class="stage-chip">${t("news.rotated", { from: segment.rotatedFrom, topic: segment.topic })}</span>` : ""}${segment.recycled ? `<span class="stage-chip">${t("news.recycle", { n: segment.recycled })}</span>` : ""}${speakersBadge}${llmBadge}${ttsBadge}</div>
    ${segment.archive ? `<div class="archive-line"><i class="bi bi-archive"></i> <code>${esc(segment.archive)}</code></div>` : ""}
    ${segment.audioUrl ? `<button class="btn btn-glass btn-sm mt-2 w-100" data-play="1"><i class="bi bi-play-fill"></i> ${t("news.replay")}</button>` : ""}
  `;
}

function upsertCard(segment) {
  const existing = S.cards.get(segment.id);
  if (existing) {
    existing.element.innerHTML = cardInner(segment);
    S.cards.set(segment.id, { ...existing, segment });
    return existing.element;
  }
  const element = buildCard(segment);
  S.cards.set(segment.id, { element, segment });
  if (S.cards.size > 300) {
    const oldest = S.cards.entries().next().value;
    if (oldest) { oldest[1].element.remove(); S.cards.delete(oldest[0]); }
  }
  const list = $("newsList");
  list.querySelector(".muted-note")?.remove();
  list.prepend(element);
  applyFilter();
  return element;
}

function applyFilter() {
  let visible = 0;
  S.cards.forEach(({ element, segment }) => {
    const show = S.filter === "all" || segment.kind === S.filter;
    element.style.display = show ? "" : "none";
    if (show) visible += 1;
  });
  $("newsCount").textContent = String(S.cards.size);
  const list = $("newsList");
  let empty = list.querySelector(".empty-note");
  if (!empty) {
    empty = document.createElement("p");
    empty.className = "muted-note empty-note";
    empty.style.display = "none";
    list.appendChild(empty);
  }
  empty.textContent = S.cards.size ? t("news.filter.empty") : t("news.empty");
  empty.style.display = visible ? "none" : "";
}

function highlightCard(id) {
  S.cards.forEach(({ element }, key) => element.classList.toggle("active", key === id));
  const active = S.cards.get(id);
  if (active) active.element.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* ─────────────────────────── transcript ─────────────────────────── */

function renderTranscript(segment, durationSec = NaN) {
  const prepared = prepareSegment(segment, durationSec);
  const container = $("transcript");
  container.innerHTML = "";
  const sentenceEls = [];
  const turnEls = [];
  let currentSentence = null;
  let currentSpan = null;
  const speakers = segment.speakers ?? [];
  const tokenEls = prepared.tokens.map((token) => {
    // One block per reply, coloured by speaker, so a dialogue reads as a dialogue.
    if (!turnEls[token.turn]) {
      const block = document.createElement("div");
      block.className = `turn sp${token.turn % 2}`;
      const head = document.createElement("div");
      head.className = "turn-head";
      const speaker = segment.turns?.[token.turn]?.name || speakers[token.turn % 2]?.name || `Voice ${(token.turn % 2) + 1}`;
      head.textContent = speaker;
      block.appendChild(head);
      const text = document.createElement("div");
      text.className = "turn-text";
      block.appendChild(text);
      container.appendChild(block);
      turnEls[token.turn] = { block, text };
    }
    if (currentSentence !== token.sentence) {
      currentSentence = token.sentence;
      const p = document.createElement("span");
      p.className = "sentence pending";
      const holder = turnEls[token.turn].text;
      holder.appendChild(p);
      holder.appendChild(document.createTextNode(" "));
      sentenceEls.push(p);
      currentSpan = p;
    }
    const span = document.createElement("span");
    span.className = "token";
    span.textContent = token.text;
    span.title = t("transcript.token.title");
    span.addEventListener("click", () => {
      if (Number.isFinite(audio.duration)) audio.currentTime = Math.max(0, token.startMs / 1000);
    });
    currentSpan.appendChild(span);
    currentSpan.appendChild(document.createTextNode(" "));
    return span;
  });
  S.current = {
    segment,
    ...prepared,
    tokenEls,
    sentenceEls,
    turnEls,
    index: -1,
    sentenceIndex: -1,
    startedAt: performance.now(),
  };
  $("nowTitle").textContent = segment.title || DASH;
  const voiceLabel = segment.tts
    ? segment.tts.provider === "edge"
      ? (segment.tts.voices ?? []).map((v) => v.replace(/Neural$/, "").split("-").pop()).join(" + ") || "Edge"
      : segment.tts.model.split("/").pop()
    : "";
  $("nowSub").innerHTML =
    `${t(`news.kind.${segment.kind === "news" ? "news" : segment.kind}`)} · ${esc(segment.searchQuery || "")}` +
    (voiceLabel ? ` · ${esc(voiceLabel)}` : "");
  const badges = [];
  if (segment.tts) badges.push(`<span class="tag ${segment.tts.exactTimings ? "playing" : "pending"}">${segment.tts.exactTimings ? t("transcript.sync.exact") : t("transcript.sync.estimated")}</span>`);
  if (segment.sources?.length) badges.push(`<span class="tag news">${count("transcript.sources", segment.sources.length)}</span>`);
  const voices = new Set((segment.tts?.voices ?? []).map((v) => v.replace(/Neural$/, "").split("-").pop()));
  if (voices.size) badges.push(`<span class="tag pending">${[...voices].join(" + ")}</span>`);
  $("nowBadges").innerHTML = badges.join(" ");
  $("syncInfo").innerHTML = segment.tts
    ? `${segment.tts.provider === "edge" ? "Edge TTS" : segment.tts.provider === "local" ? "Chatterbox local" : "OpenRouter"} · ${count("transcript.voices", segment.tts.voices?.length ?? 1)} · ${t("transcript.synthesis", { n: (segment.tts.ms / 1000).toFixed(1) })} · ${t("transcript.chars", { n: segment.tts.charCount })} · ${fmtCost(segment.tts.costUsd)}`
    : "—";
  $("seekBar").disabled = false;
  renderListeningState();
}

function updateHighlight() {
  const cur = S.current;
  if (!cur) return;
  const ms = audio.currentTime * 1000;
  const index = tokenIndexAt(cur.tokens, ms);
  if (index !== cur.index) {
    if (cur.index >= 0) cur.tokenEls[cur.index].classList.replace("active", "spoken");
    if (index >= 0) {
      const el = cur.tokenEls[index];
      el.classList.remove("spoken");
      el.classList.add("active");
    }
    cur.index = index;
  }
  const sentenceIndex = index >= 0 ? cur.tokens[index].sentence : 0;
  if (sentenceIndex !== cur.sentenceIndex) {
    if (cur.sentenceIndex >= 0 && cur.sentenceEls[cur.sentenceIndex]) cur.sentenceEls[cur.sentenceIndex].className = "sentence done";
    cur.sentenceEls.forEach((el, i) => {
      if (i < sentenceIndex) el.className = "sentence done";
      else if (i === sentenceIndex) el.className = "sentence active";
      else el.className = "sentence pending";
    });
    const el = cur.sentenceEls[sentenceIndex];
    if (el) {
      const container = $("transcript");
      container.scrollTop = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
    }
    cur.sentenceIndex = sentenceIndex;
  }
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    $("seekBar").value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    $("durTime").textContent = fmtTime(audio.duration);
  }
  $("curTime").textContent = fmtTime(audio.currentTime);
}

function loop() {
  if (S.status === "playing" && !audio.paused) updateHighlight();
  requestAnimationFrame(loop);
}

/* ─────────────────────────── lecture ─────────────────────────── */

function unloadAudio(stopWaiting = true) {
  if (stopWaiting) stopMusicBed();
  stopJingle();
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  S.current = null;
  $("seekBar").disabled = true;
  $("seekBar").value = "0";
  $("curTime").textContent = $("durTime").textContent = "0:00";
  $("nowBadges").replaceChildren();
  $("syncInfo").textContent = t("transcript.none");
  renderListeningState();
}

const introAudio = new Audio();
introAudio.volume = 0.9;

/* Fond musical d'attente : il ne joue que lorsque le tampon est vide, sous
   l'annonce parlée, et s'arrête dès qu'un segment démarre. Les pistes viennent
   de public/music/ (voir GET /api/music) et ne sont jamais mélangées à l'audio
   archivé : la musique reste donc purement locale à la lecture. */
const musicBed = new Audio();
let browserMusic = [];
let browserMusicFolder = "";
let waitingTrackName = "";
const waitingMusic = new WaitingMusic({
  audio: musicBed,
  volume: () => bedLevel(BED_LEVEL),
  tracks: async signal => {
    if (S.settings?.musicMood === "aucun") return [];
    if (browserMusic.length) return browserMusic.map(file => ({
      id: file.webkitRelativePath || file.name, name: file.name,
      open: () => { const url = URL.createObjectURL(file); return { url, release: () => URL.revokeObjectURL(url) }; },
    }));
    const res = await fetch("/api/music", { signal });
    if (!res.ok) throw new Error(t("music.loadError"));
    const data = await res.json();
    return (data.tracks ?? []).map(url => ({
      id: url, name: new URL(url, location.href).searchParams.get("name") || decodeURIComponent(url.split("/").pop()),
      open: () => ({ url }),
    }));
  },
  changed: name => { waitingTrackName = name || ""; renderMusicLibrary(); },
  error: message => toast(t("music.playError", { message }), "danger"),
});

function renderMusicLibrary() {
  $("musicLibraryInfo").textContent = browserMusic.length
    ? t("music.browser.selected", { n: browserMusic.length, folder: browserMusicFolder }) : t("music.browser.none");
  $("musicClear").hidden = !browserMusic.length;
  $("musicNow").textContent = waitingTrackName ? t("music.now", { name: waitingTrackName }) : "";
}

/** L'attente est celle de l'antenne, pas celle d'un appel TTS individuel. */
function updateWaitingMusic(e) {
  if (e.running && !e.current && S.settings?.musicMood !== "aucun") void waitingMusic.start();
  else waitingMusic.stop();
}

function stopMusicBed() { waitingMusic.stop(); }

/* Jingle d'ouverture : la signature sonore de la station, synthétisée par
   scripts/make-jingle.ts (aucun échantillon téléchargé). Il marque le début d'une
   *émission* — premier passage après un démarrage, ou après un changement de
   sujet — et non chaque passage : toutes les minutes, il ne serait plus qu'un tic.
   Comme le fond, il suit le volume général et le réglage « aucune musique ». */
const JINGLE_URL = "/jingle/start.mp3";
const JINGLE_LEVEL = 0.5; // un peu plus présent que le fond : c'est une signature
const BED_LEVEL = 0.34;
const jingle = new Audio(JINGLE_URL);
jingle.preload = "auto";
jingle.volume = 0;
let jingleArmed = false;
let jingleReady = true;
jingle.addEventListener("error", () => { jingleReady = false; }); // fichier absent : on n'insiste pas

/**
 * Niveau réel d'un fond : il suit le volume général (donc la sourdine coupe
 * aussi la musique, ce qu'un niveau fixe ne faisait pas).
 */
function bedLevel(level) {
  const master = Number($("volume").value);
  return Math.max(0, Math.min(1, (Number.isFinite(master) ? master : 0.9) * level));
}

/** Une émission va commencer : le prochain passage en attente s'ouvrira sur le jingle. */
function armJingle() { jingleArmed = true; }

/** Coupe le jingle (arrêt, pause) ; le prochain démarrage le reprendra au début. */
function stopJingle() {
  if (jingle.paused) return;
  jingle.pause();
  jingle.currentTime = 0;
}

/**
 * Joue le jingle s'il est armé. Renvoie une promesse résolue quand il a fini (ou
 * tout de suite si rien ne joue) : l'annonce parlée et le décompte démarrent
 * après lui, pour ne pas se superposer à la musique.
 */
function playJingle(signal) {
  if (!jingleArmed || !jingleReady) return Promise.resolve();
  jingleArmed = false;
  if ((S.settings?.musicMood ?? "ambient") === "aucun") return Promise.resolve();
  jingle.currentTime = 0;
  jingle.volume = bedLevel(JINGLE_LEVEL);
  jingle.play()?.catch(() => {}); // lecture refusée : l'émission continue sans jingle
  return new Promise((resolve) => {
    const done = () => { cleanup(); resolve(); };
    const cleanup = () => {
      clearTimeout(timer);
      jingle.removeEventListener("ended", done);
      jingle.removeEventListener("error", done);
      signal?.removeEventListener("abort", done);
    };
    // Filet de sécurité : si le navigateur n'émet pas `ended` (durée inconnue),
    // la transition ne doit pas rester bloquée sur le jingle.
    const timer = setTimeout(done, ((jingle.duration || 6) + 0.4) * 1000);
    jingle.addEventListener("ended", done, { once: true });
    jingle.addEventListener("error", done, { once: true });
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

/** Le choix de musique a changé : on oublie la piste retenue et on coupe le fond. */
function resetMusicBed() {
  stopMusicBed();
}

/** Ligne « histoires passées à l'antenne aujourd'hui » des réglages. */
function renderMemoryInfo() {
  const el = $("memoryInfo");
  if (el) el.innerHTML = t("sources.memory", { today: S.memory?.today ?? 0, total: S.memory?.total ?? 0 });
  renderMemoryList();
}

/**
 * La liste des histoires du jour, la plus récente en tête : c'est elle qui permet
 * d'oublier un seul sujet plutôt que toute la mémoire. Ce que le bouton envoie,
 * c'est la clé exacte renvoyée par le serveur (titre + horodatage).
 */
function renderMemoryList() {
  const list = $("memoryList");
  if (!list) return;
  const rows = [...(S.played ?? [])].reverse();
  const count = $("memoryCount");
  if (count) count.textContent = String(rows.length);
  list.innerHTML = rows.length
    ? rows.map((story) => `
        <li class="memory-row">
          <span class="memory-topic" title="${esc(story.topic || DASH)}">${esc(story.topic || DASH)}</span>
          <span class="memory-title" title="${esc(story.title)}">${esc(story.title)}</span>
          <span class="memory-time">${esc(fmtClock(story.at))}</span>
          <button class="memory-forget" type="button" data-title="${esc(story.title)}" data-at="${esc(story.at)}" title="${esc(t("sources.memory.forget"))}" aria-label="${esc(t("sources.memory.forget"))}"><i class="bi bi-x-lg"></i></button>
        </li>`).join("")
    : `<li class="memory-empty">${esc(t("sources.memory.listEmpty"))}</li>`;
}

/**
 * Affiche ce que le serveur a réellement trouvé (dossier choisi ou ambiances
 * livrées) : c'est le seul retour utile quand on saisit un chemin de dossier.
 */
async function refreshMusicInfo() {
  let report = { tracks: [], source: "none", folder: "" };
  try {
    const res = await fetch("/api/music");
    if (res.ok) report = await res.json();
  } catch {
    return report; // serveur muet : on laisse le texte précédent
  }
  const n = Array.isArray(report.tracks) ? report.tracks.length : 0;
  const dir = `<code>${esc(report.folder || "public/music")}</code>`;
  $("musicInfo").innerHTML =
    report.error === "unreadable" ? t("music.info.unreadable", { dir })
    : report.source === "none" ? t("music.info.none")
    : n === 0 ? t("music.info.empty", { dir })
    : t(report.source === "folder" ? "music.info.folder" : "music.info.builtin", { n, dir });
  return report;
}

async function cycleIntro(segment, signal) {
  unloadAudio(false);
  $("nowTitle").textContent = t("play.upNext", { title: segment.title });
  $("nowSub").textContent = t("play.intro");
  // La musique personnelle comble déjà l'attente : pas de jingle par-dessus.
  if (!waitingMusic.active) await playJingle(signal);
  if (signal.aborted) return;
  updateWaitingMusic(engine);
  const start = performance.now();
  const announcementController = new AbortController();
  let url = null;
  const tick = setInterval(() => { $("countdown").textContent = t("play.intro.tick", { n: Math.max(0, Math.ceil((10000 - (performance.now() - start)) / 1000)) }); }, 100);
  const cleanup = () => { stopJingle(); announcementController.abort(); introAudio.pause(); introAudio.removeAttribute("src"); clearInterval(tick); $("countdown").textContent = ""; if (url) URL.revokeObjectURL(url); };
  signal.addEventListener("abort", cleanup, { once: true });
  const announcement = (async () => {
    const res = await fetch("/api/tts/intro", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: segment.title, topic: segment.topic }), signal: AbortSignal.any([signal, announcementController.signal, AbortSignal.timeout(9000)]) });
    if (!res.ok) throw new Error(t("play.intro.failed"));
    const blob = await res.blob();
    if (signal.aborted || performance.now() - start >= 10000) return;
    url = URL.createObjectURL(blob);
    introAudio.src = url;
    await introAudio.play();
  })().catch(err => { if (!signal.aborted) toast(err.message, "danger"); });
  try {
    await new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 10000);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    // Observe all async errors without letting a slow Edge response delay the fixed 10-second gate.
    void announcement;
  } finally { cleanup(); signal.removeEventListener("abort", cleanup); }
}

/** Dernière position annoncée à la mémoire éditoriale (on n'envoie que ce qui avance). */
let memoryReport = { id: null, chars: 0 };

const engine = new RadioEngine({

  request: () => ({ mode: "news", topic: S.activeTopic ?? S.settings?.topic, prefetch: S.settings?.prefetch ?? 3 }),
  build: async (req, signal) => {
    const { segment: planned } = await api.plan(req, signal);
    signal.throwIfAborted();
    upsertCard(planned);
    renderStages(planned.stages, req.mode);
    $("generationInfo").textContent = engine.warming
      ? t("console.gen.warmingSyn", { n: engine.queue.length, max: Math.max(1, S.settings?.prefetch ?? 3) })
      : t("console.gen.synth");
    const introController = new AbortController();
    const introSignal = AbortSignal.any([signal, introController.signal]);
    let announced = false;
    const announceWhenEmpty = () => {
      if (!announced && engine.running && !engine.current && !engine.queue.length && !introController.signal.aborted) {
        announced = true;
        void cycleIntro(planned, introSignal).catch(err => { if (!introSignal.aborted) toast(err.message, "danger"); });
      }
    };
    announceWhenEmpty();
    const monitor = setInterval(announceWhenEmpty, 250);
    try {
      const { segment: ready } = await api.render(planned.id, signal);
      signal.throwIfAborted();
      upsertCard(ready);
      addStat(ready);
      renderStages(ready.stages, req.mode);
      return ready;
    } catch (err) {
      const card = S.cards.get(planned.id)?.element;
      if (card) { const tag = card.querySelector(".tag.pending"); if (tag) tag.textContent = signal.aborted ? t("news.cancelled") : t("news.failed"); }
      throw err;
    } finally { clearInterval(monitor); introController.abort(); }
  },
  play: (segment, restart) => {
    if (restart) {
      introAudio.pause();
      stopMusicBed();
      audio.src = segment.audioUrl;
      renderTranscript(segment);
      highlightCard(segment.id);
    }
    const src = audio.src;
    audio.play().catch(err => {
      if (engine.running && audio.src === src && err.name !== "AbortError") {
        toast(t("play.blocked", { message: err.message }), "danger");
        engine.pause();
      }
    });
  },
  pause: () => { audio.pause(); stopMusicBed(); stopJingle(); },
  stop: unloadAudio,
  progress: (segment, complete) => {
    if (S.current?.segment.id !== segment.id) return 0;
    const listened = audio.played.length && audio.played.start(0) < 0.25 ? audio.played.end(0) * 1000 : 0;
    if (complete && listened >= (audio.duration - 0.3) * 1000) return segment.transcript.length;
    return S.current.tokens.filter(t => t.endMs <= listened + 100).at(-1)?.end ?? 0;
  },
  heard: (segment, chars, complete) => {
    // C'est le serveur qui décide à partir de quel seuil une histoire compte comme
    // entendue : on lui transmet la position atteinte à chaque progression, et pas
    // seulement quand le passage est allé au bout.
    const previous = memoryReport.id === segment.id ? memoryReport.chars : 0;
    if (!complete && chars <= previous) return; // rien de nouveau depuis le dernier envoi
    memoryReport = { id: segment.id, chars };
    if (chars <= 0) return;
    void api.played(segment.id, chars, complete)
      .then(res => {
        if (res.memory) S.memory = res.memory;
        if (res.played) S.played = res.played; // la liste du jour suit la mémoire
        renderMemoryInfo();
      })
      .catch(err => toast(t("play.memoryError", { message: err.message }), "danger"));
  },
  state: e => {
    S.queue = e.queue;
    setStatus(e.running ? e.current && !e.needsIntro ? "playing" : "working" : e.current || e.requests.length || e.queue.length ? "paused" : "idle");
    renderQueue();
    $("generationInfo").textContent = e.warming && e.running
      ? t("console.gen.warming", { n: e.queue.length, max: Math.max(1, S.settings?.prefetch ?? 3) })
      : e.job
        ? t("console.gen.preparing", { what: e.job.req.question || e.job.req.topic })
        : e.timer ? t("console.gen.retry") : t("console.gen.idle");
    $("priorityInfo").textContent = e.requests.length
      ? t("console.priority", { n: e.requests.length, what: e.requests[0].question || e.requests[0].topic })
      : t("console.priority.none");
    $("conversationInfo").textContent = t("console.conversation", { n: e.conversation.length });
    if (!e.running && !e.current && !e.requests.length) {
      $("nowTitle").textContent = t("console.idle");
      $("nowSub").textContent = t("console.empty");
    }
    renderListeningState();
    updateWaitingMusic(e);
  },
  error: message => toast(message, "danger"),
});

function pausePlayback() { engine.pause(); }
function resumePlayback() {
  if (!S.settings) return;
  // Reprise au milieu d'un passage : pas de jingle. Antenne à l'arrêt : on ouvre l'émission.
  if (!engine.current) armJingle();
  engine.start();
}
function stopPlayback() { engine.stop(); }
function skip() { if (S.settings) engine.skip(); }

/* ─────────────────────────── chips & question ─────────────────────────── */

function renderChips() {
  const row = $("chipRow");
  const topics = S.settings?.chips ?? [];
  row.innerHTML = "";
  topics.forEach((topic) => {
    const chip = document.createElement("button");
    chip.className = `chip${topic === S.settings.topic ? " active" : ""}`;
    chip.innerHTML = `<i class="bi bi-broadcast"></i> ${esc(topic)}`;
    chip.title = S.status === "playing" ? t("topic.chip.title.playing") : t("topic.chip.title.idle");
    chip.setAttribute("aria-pressed", String(topic === S.settings.topic));
    chip.addEventListener("click", () => selectTopic(topic));
    row.appendChild(chip);
  });
  const add = document.createElement("button");
  add.className = "chip add";
  add.innerHTML = `<i class="bi bi-plus-lg"></i> ${esc(t("topic.chip.add"))}`;
  add.addEventListener("click", () => {
    const input = $("newChip");
    const tab = document.querySelector('[data-bs-target="#tab-sources"]');
    tab?.click();
    bootstrap.Offcanvas.getOrCreateInstance($("settings")).show();
    input?.focus();
  });
  row.appendChild(add);

  const editor = $("chipEditor");
  editor.innerHTML = "";
  topics.forEach((topic) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `${esc(topic)} <i class="bi bi-x-lg rm"></i>`;
    chip.querySelector(".rm").addEventListener("click", () => {
      patchSettings({ chips: topics.filter((t) => t !== topic) });
    });
    editor.appendChild(chip);
  });
}

function selectTopic(topic) {
  if (!S.ready) return;
  S.activeTopic = topic;
  S.settings.topic = topic;
  armJingle(); // nouveau sujet = nouvelle émission : elle s'ouvrira sur le jingle
  engine.changeTopic();
  renderChips();
  void patchSettings({ topic });
  toast(t("topic.active", { topic, when: t(engine.current ? "topic.when.after" : "topic.when.next") }));
}

async function ask() {
  if (!S.ready) return;
  const input = $("questionInput");
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  engine.enqueue({ mode: "question", question, topic: S.activeTopic ?? S.settings.topic }, S.settings.questionTiming === "now");
}

/**
 * Débat contradictoire : la question saisie (ou le sujet sélectionné) devient un
 * débat entre les deux présentateurs, l'auditeur en modérateur.
 */
async function startDebate() {
  if (!S.ready) return;
  const input = $("questionInput");
  const question = input.value.trim();
  const topic = S.settings?.topic ?? "";
  if (!S.settings?.hasKey) {
    toast(t("ask.debate.needsKey"), "danger");
    return;
  }
  if (S.settings?.hostCount === 1) {
    toast(t("ask.debate.needsDuo"), "danger");
    return;
  }
  if (!question && !topic) {
    toast(t("ask.debate.needsSubject"), "danger");
    return;
  }
  input.value = "";
  engine.enqueue({ mode: "debate", question: question || undefined, topic }, S.settings.questionTiming === "now");
}

/* ─────────────────────────── réglages ─────────────────────────── */

/**
 * La langue de l'émission est aussi celle de l'interface : quand elle change,
 * on réapplique le dictionnaire puis on redessine ce qui est construit en JS
 * (cartes, réglages, compteurs) pour qu'aucun texte ne reste dans l'ancienne langue.
 */
function applyLocale(locale) {
  setLocale(locale);
  applyI18n(document);
  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.classList.toggle("active", button.dataset.lang === locale);
    button.setAttribute("aria-pressed", String(button.dataset.lang === locale));
  });
  const select = $("localeSelect");
  if (select && select.value !== locale) select.value = locale;
}

async function patchSettings(patch) {
  try {
    const res = await api.saveSettings(patch);
    S.settings = res.settings;
    if (patch.locale) applyLocale(patch.locale);
    if (["llmModel", "ttsProvider", "ttsModel"].some(key => key in patch)) {
      S.sessionStats = { totalCostUsd: 0, audioSeconds: 0 };
      renderStats();
      engine.changeTopic();
    }
    // /api/voices renvoie { locale, voices } : ne stocker que le tableau.
    if (patch.locale) S.voices = (await api.voices(patch.locale)).voices ?? [];
    syncControls();
    renderChips();
    renderListeningState();
    applyFilter();
    S.cards.forEach(({ element, segment }) => { element.innerHTML = cardInner(segment); });
    // emit() repasse par le rendu d'état : statut, file et libellés d'activité
    // sont réécrits dans la nouvelle langue.
    engine.emit();
    renderStats();
    void refreshState();
  } catch (err) {
    toast(err.message, "danger");
  }
}

function renderLlmSelect() {
  const select = $("llmSelect");
  const current = S.settings.llmModel;
  select.innerHTML = S.llmModels
    .map((m) => {
      const price = m.free ? t("models.free") : `${m.inPerM.toFixed(3)}$/M in · ${m.outPerM.toFixed(2)}$/M out`;
      return `<option value="${esc(m.id)}"${m.id === current ? " selected" : ""}>${esc(m.name)} — ${price}</option>`;
    })
    .join("");
  const model = S.llmModels.find((m) => m.id === current);
  $("llmPrice").innerHTML = model
    ? `${esc(model.id)} · ${model.ctx ? `${Math.round(model.ctx / 1000)}k` : "?"} tokens · in ${model.inPerM.toFixed(3)} $/M · out ${model.outPerM.toFixed(2)} $/M${model.free ? ` · <strong>${t("models.free")}</strong>` : ""}`
    : t("models.llm.missing");
}

async function loadLlmModels(q = "") {
  const data = await api.models("llm", q);
  S.llmModels = data.llm;
  if (S.selectedModel && !S.llmModels.some(m => m.id === S.selectedModel.id)) S.llmModels.unshift(S.selectedModel);
  // La liste complète sert au sélecteur de modèle rapide, jamais filtrée par la recherche.
  if (!q && data.llm.length) S.llmAllModels = data.llm;
  renderLlmSelect();
  renderFastSelect();
}

/** Modèle des tâches rapides : requête de recherche, récapitulatifs. */
function renderFastSelect() {
  const select = $("llmSelectFast");
  if (!select) return;
  const models = S.llmAllModels.length ? S.llmAllModels : S.llmModels;
  const current = S.settings?.llmModelFast ?? "";
  select.innerHTML =
    `<option value=""${current ? "" : " selected"}>${esc(t("models.fast.same"))}</option>` +
    models
      .map((m) => {
        const price = m.free ? t("models.free") : `${m.outPerM.toFixed(2)}$/M out`;
        return `<option value="${esc(m.id)}"${m.id === current ? " selected" : ""}>${esc(m.name)} — ${price}</option>`;
      })
      .join("");
  const model = models.find((m) => m.id === current);
  $("llmFastPrice").innerHTML = model
    ? `${esc(model.id)} · out ${model.outPerM.toFixed(2)} $/M${model.free ? ` · <strong>${t("models.free")}</strong>` : ""} — ${t("models.fast.used")}`
    : t("models.fast.none");
}

function renderTtsModels() {
  const select = $("ttsModel");
  if (!select) return;
  select.innerHTML = S.ttsModels
    .map((m) => {
      const price = m.free ? t("models.free") : `${m.per1k.toFixed(5)}$/1k${m.approximate ? " ≈" : ""}`;
      const mark = m.id === S.settings.ttsModel ? " selected" : "";
      return `<option value="${esc(m.id)}"${mark}>${esc(m.name)} — ${price}</option>`;
    })
    .join("");
  $("ttsFallbackModel").innerHTML = `<option value="">${esc(t("tts.fallbackEdge"))}</option>` + S.ttsModels.map(m => `<option value="${esc(m.id)}">${esc(m.name)} — ${m.free ? t("models.free") : `${m.per1k.toFixed(5)} $/1k car.`}</option>`).join("");
  $("ttsFallbackModel").value = S.settings.ttsFallbackModel;
  const model = S.ttsModels.find((m) => m.id === S.settings.ttsModel);
  $("ttsPrice").innerHTML = model
    ? `${model.billed === "char" ? "char" : model.billed === "token" ? "audio token (est.)" : "per second"} · ≈ ${model.per1k.toFixed(5)} $ / 1k chars · ${model.voices.length} ${getLocale() === "fr" ? "voix" : "voices"}${model.free ? ` · <strong>${t("models.free")}</strong>` : ""}`
    : "";
}

function renderVoiceSelects() {
  const model = S.ttsModels.find((m) => m.id === S.settings.ttsModel);
  $("voiceInfo").innerHTML =
    S.settings.ttsProvider === "edge"
      ? t("tts.voicesAvailable", { n: edgeVoices().length })
      : t("tts.voicesModel", { n: (model?.voices ?? []).length });
}

/* ─────────────── équipe (présentateurs + auditeur) ─────────────── */

const edgeVoices = () => (Array.isArray(S.voices) ? S.voices : []);

function voiceOptions() {
  if (S.settings?.ttsProvider === "local") return [{ id: "host-1", label: t("tts.localRef1.label") }, { id: "host-2", label: t("tts.localRef2.label") }];
  if (S.settings?.ttsProvider === "edge") return edgeVoices().map((v) => ({ id: v.id, label: v.label }));
  const model = S.ttsModels.find((m) => m.id === S.settings.ttsModel);
  return (model?.voices ?? []).map((id) => ({ id, label: id }));
}

const personaTemplates = () => S.presets.personaTemplates ?? [];

/** Voix correspondant au genre du gabarit dans la langue courante. */
function suggestVoice(gender) {
  const marker = gender === "F" ? /\(F\)$/ : /\(H\)$/;
  const defaults = S.hostsDefaults ?? [];
  const list = edgeVoices();
  // Les voix par défaut de la langue sont ordonnées [féminine, masculine].
  const preferred = gender === "F" ? defaults[0]?.voice : defaults[1]?.voice;
  if (preferred && list.some((voice) => voice.id === preferred && marker.test(voice.label))) return preferred;
  return list.find((voice) => marker.test(voice.label))?.id || preferred || list[0]?.id || "";
}

function templateForHost(host) {
  const match = personaTemplates().find((tpl) => tpl[S.settings.locale]?.persona && tpl[S.settings.locale].persona === host.persona);
  return match?.id ?? "";
}

/**
 * Deux présentateurs ne peuvent pas partager la même voix : on décale le second
 * sur une autre voix du même genre quand c'est possible.
 */
function ensureDistinctVoices(hosts) {
  if (S.settings.ttsProvider !== "edge" || hosts.length < 2) return hosts;
  const list = edgeVoices();
  if (!list.length || hosts[0].voice !== hosts[1].voice) return hosts;
  const label = list.find((v) => v.id === hosts[1].voice)?.label ?? "";
  const marker = /\(F\)$/.test(label) ? /\(F\)$/ : /\(H\)$/.test(label) ? /\(H\)$/ : null;
  const alternative = list.find((v) => v.id !== hosts[0].voice && (!marker || marker.test(v.label)));
  if (alternative) hosts[1] = { ...hosts[1], voice: alternative.id };
  return hosts;
}

/** Applique un gabarit à un présentateur : prénom, personnalité et voix. */
function applyTemplate(index, templateId) {
  const template = personaTemplates().find((tpl) => tpl.id === templateId);
  const hosts = (S.settings.hosts ?? []).map((host) => ({ ...host }));
  if (!template) {
    patchSettings({ hosts });
    return;
  }
  const localized = template[S.settings.locale] ?? template.fr;
  hosts[index] = {
    name: localized.name,
    persona: localized.persona,
    voice: S.settings.ttsProvider === "edge" ? suggestVoice(template.gender) : hosts[index].voice,
  };
  patchSettings({ hosts: ensureDistinctVoices(hosts) });
  toast(t("voice.tpl.applied", { name: localized.name, label: template.label }));
}

function renderHostsEditor() {
  const hosts = S.settings.hosts ?? [];
  const count = S.settings.hostCount === 1 ? 1 : 2;
  $("hostCountGroup").querySelectorAll("[data-count]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.count) === count);
  });
  const options = voiceOptions();
  $("hostsEditor").innerHTML = hosts
    .map(
      (host, index) => `
      <div class="host-card sp${index}${index >= count ? " disabled" : ""}" data-host="${index}">
        <div class="host-title"><span class="swatch"></span> ${esc(t("voice.host", { n: index + 1 }))}${index >= count ? ` ${esc(t("voice.host.off"))}` : ""}</div>
        <select class="form-select form-select-sm mb-2" data-field="template">
          <option value="">${esc(templateForHost(host) ? t("voice.template.placeholder") : t("voice.template.custom"))}</option>
          ${personaTemplates()
            .map((tpl) => `<option value="${esc(tpl.id)}"${tpl.id === templateForHost(host) ? " selected" : ""}>${esc(tpl.label)}</option>`)
            .join("")}
        </select>
        <input class="form-control form-control-sm mb-2" data-field="name" value="${esc(host.name)}" placeholder="${esc(t("voice.host.name"))}" />
        <select class="form-select form-select-sm mb-2" data-field="voice">
          ${options.map((option) => `<option value="${esc(option.id)}"${option.id === host.voice ? " selected" : ""}>${esc(option.label)}</option>`).join("")}
        </select>
        <textarea class="form-control form-control-sm" data-field="persona" rows="2" placeholder="${esc(t("voice.host.persona"))}">${esc(host.persona)}</textarea>
      </div>`,
    )
    .join("");
  $("hostsEditor").querySelectorAll("[data-field]").forEach((input) => {
    const apply = () => {
      const index = Number(input.closest("[data-host]").dataset.host);
      if (input.dataset.field === "template") {
        if (input.value) applyTemplate(index, input.value);
        return;
      }
      const next = (S.settings.hosts ?? []).map((host, i) => (i === index ? { ...host, [input.dataset.field]: input.value } : { ...host }));
      patchSettings({ hosts: next });
    };
    input.addEventListener("change", apply);
    if (input.dataset.field === "template") input.addEventListener("input", apply);
  });
}

/* ─────────────── gabarits persos : création, édition, import/export ─────────────── */

const customTemplates = () => S.presets.customTemplates ?? [];
let editingTemplateId = "";

/** Le serveur renvoie toujours la liste fusionnée (fournis + persos). */
function applyTemplates(data) {
  if (Array.isArray(data.personaTemplates)) S.presets.personaTemplates = data.personaTemplates;
  if (Array.isArray(data.templates ?? data.customTemplates)) S.presets.customTemplates = data.templates ?? data.customTemplates;
  if (Array.isArray(data.customTemplates)) S.settings.customTemplates = data.customTemplates;
  editingTemplateId = customTemplates().some((tpl) => tpl.id === editingTemplateId) ? editingTemplateId : "";
  renderTemplateList();
  renderHostsEditor();
}

function renderTemplateList() {
  const list = customTemplates();
  $("templateCount").textContent = String(list.length);
  if (!list.length) {
    $("templateList").innerHTML = `<p class="muted-note">${t("voice.templates.empty")}</p>`;
    return;
  }
  $("templateList").innerHTML = list
    .map((tpl) => {
      const localized = tpl[S.settings.locale] ?? tpl.fr ?? {};
      const other = S.settings.locale === "fr" ? tpl.en : tpl.fr;
      return `
      <div class="template-item${tpl.id === editingTemplateId ? " editing" : ""}" data-tpl="${esc(tpl.id)}">
        <div class="ti-head">
          <span class="swatch sp${tpl.gender === "H" ? 1 : 0}"></span>
          <strong>${esc(localized.name || other?.name || tpl.label)}</strong>
          <span class="ti-label">${esc(tpl.label)}</span>
          <span class="ms-auto"></span>
          <button class="btn btn-link btn-sm p-0" data-act="use" data-host="0" title="${esc(t("voice.tpl.use", { n: 1 }))}">${esc(t("voice.tpl.useShort", { n: 1 }))}</button>
          <button class="btn btn-link btn-sm p-0" data-act="use" data-host="1" title="${esc(t("voice.tpl.use", { n: 2 }))}">${esc(t("voice.tpl.useShort", { n: 2 }))}</button>
          <button class="btn btn-link btn-sm p-0" data-act="edit">${esc(t("voice.tpl.edit"))}</button>
          <button class="btn btn-link btn-sm p-0 text-danger" data-act="del">${esc(t("voice.tpl.del"))}</button>
        </div>
        <div class="ti-persona">${esc((localized.persona || other?.persona || "").slice(0, 220))}</div>
      </div>`;
    })
    .join("");
  $("templateList").querySelectorAll("[data-act]").forEach((button) => {
    const id = button.closest("[data-tpl]").dataset.tpl;
    button.addEventListener("click", () => {
      const template = customTemplates().find((tpl) => tpl.id === id);
      if (!template) return;
      if (button.dataset.act === "use") applyTemplate(Number(button.dataset.host), id);
      else if (button.dataset.act === "edit") editTemplate(template);
      else void removeTemplate(template);
    });
  });
}

function editTemplate(template) {
  editingTemplateId = template.id;
  $("tplLabel").value = template.label ?? "";
  $("tplGender").value = template.gender === "H" ? "H" : "F";
  $("tplNameFr").value = template.fr?.name ?? "";
  $("tplPersonaFr").value = template.fr?.persona ?? "";
  $("tplNameEn").value = template.en?.name ?? "";
  $("tplPersonaEn").value = template.en?.persona ?? "";
  $("tplState").innerHTML = t("voice.tpl.editing", { label: `<strong>${esc(template.label)}</strong>`, id: `<code>${esc(template.id)}</code>` });
  $("tplSaveBtn").innerHTML = `<i class="bi bi-bookmark-check"></i> ${esc(t("voice.tpl.update"))}`;
  renderTemplateList();
}

function resetTemplateForm() {
  editingTemplateId = "";
  ["tplLabel", "tplNameFr", "tplPersonaFr", "tplNameEn", "tplPersonaEn"].forEach((id) => {
    $(id).value = "";
  });
  $("tplGender").value = "F";
  $("tplState").textContent = t("voice.tpl.none");
  $("tplSaveBtn").innerHTML = `<i class="bi bi-bookmark-plus"></i> ${esc(t("voice.tpl.save"))}`;
  renderTemplateList();
}

async function saveTemplate() {
  const label = $("tplLabel").value.trim();
  const fr = { name: $("tplNameFr").value.trim(), persona: $("tplPersonaFr").value.trim() };
  const en = { name: $("tplNameEn").value.trim(), persona: $("tplPersonaEn").value.trim() };
  if (!fr.name && !en.name) {
    toast(t("voice.tpl.needsName"), "danger");
    return;
  }
  const button = $("tplSaveBtn");
  button.disabled = true;
  try {
    const data = await api.saveTemplate({ id: editingTemplateId || undefined, label: label || fr.name || en.name, gender: $("tplGender").value, fr, en });
    applyTemplates(data);
    resetTemplateForm();
    toast(t("voice.tpl.saved", { label: data.template.label, n: data.templates.length }));
  } catch (err) {
    toast(err.message, "danger");
  } finally {
    button.disabled = false;
  }
}

async function removeTemplate(template) {
  try {
    const data = await api.deleteTemplate(template.id);
    applyTemplates(data);
    if (editingTemplateId === template.id) resetTemplateForm();
    toast(t("voice.tpl.deleted", { label: template.label }));
  } catch (err) {
    toast(err.message, "danger");
  }
}

async function importTeam(file) {
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const data = await api.importTeam(payload);
    await refreshState();
    const counts = [`${data.imported.hosts} ${getLocale() === "fr" ? "présentateur(s)" : "host(s)"}`];
    if (data.imported.listener) counts.push(getLocale() === "fr" ? "l'auditeur" : "the listener");
    if (data.imported.templates) counts.push(`${data.imported.templates} ${getLocale() === "fr" ? "gabarit(s)" : "template(s)"}`);
    $("teamState").innerHTML = `<i class="bi bi-check2-circle"></i> ${esc(t("team.imported", { what: counts.join(", ") }))}`;
    toast(t("team.imported.short", { what: counts.join(", ") }));
  } catch (err) {
    toast(t("team.importFailed", { message: err.message }), "danger");
  }
}

/* ─────────────── catalogue de thèmes ─────────────── */

function renderThemeCatalog(filter = "") {
  const needle = filter.trim().toLowerCase();
  const themes = (S.presets.themes ?? []).filter((theme) => {
    if (!needle) return true;
    return `${theme.label} ${theme.group} ${theme.query} ${theme.keywords.join(" ")}`.toLowerCase().includes(needle);
  });
  const groups = (S.presets.themeGroups ?? []).filter((group) => themes.some((theme) => theme.group === group));
  $("themeCatalog").innerHTML =
    groups
      .map(
        (group) => `<div>
          <div class="theme-group-title">${esc(group)}</div>
          <div class="theme-chips">${themes
            .filter((theme) => theme.group === group)
            .map(
              (theme) =>
                `<span class="theme-chip${(S.settings.chips ?? []).includes(theme.label) ? " on" : ""}" data-theme="${esc(theme.label)}" title="Recherche : ${esc(theme.query)}">${esc(theme.label)}</span>`,
            )
            .join("")}</div>
        </div>`,
      )
      .join("") || `<p class="muted-note">${t("sources.themes.empty")}</p>`;
  $("themeCatalog").querySelectorAll("[data-theme]").forEach((chip) => {
    chip.addEventListener("click", () => void addTheme(chip.dataset.theme));
  });
}

async function addTheme(label) {
  const chips = (S.settings.chips ?? []).includes(label) ? S.settings.chips : [...(S.settings.chips ?? []), label];
  await patchSettings({ chips });
  selectTopic(label);
  renderThemeCatalog($("themeSearch").value);
}

function syncControls() {
  const s = S.settings;
  for (const id of ["radioMode", "questionTiming"]) $(id).value = s[id];
  $("searchInterval").value = String(s.searchIntervalSec);
  $("searchInterval").disabled = s.radioMode === "explore";
  $("topicInput").value = S.activeTopic ?? s.topic;
  $("ttsFallback").checked = s.ttsFallback;
  for (const id of ["humor", "disagreement", "technicality", "replyLength", "addressFrequency"]) $(id).value = String(s[id]);
  $("keyState").innerHTML = s.hasKey ? t("models.key.saved", { hint: esc(s.keyHint) }) : t("models.key.none");
  $("llmSearch").placeholder = t("models.llm.placeholder");
  $("llmSelect").value = s.llmModel;
  $("ttsProvider").value = s.ttsProvider;
  $("ttsSpeed").value = String(s.ttsSpeed);
  $("ttsSpeedLabel").textContent = `${s.ttsSpeed.toFixed(2)}×`;
  $("localBlock").classList.toggle("d-none", s.ttsProvider !== "local");
  $("localExaggeration").value = String(s.localExaggeration);
  $("edgeBlock").classList.toggle("d-none", s.ttsProvider !== "edge");
  $("orBlock").classList.toggle("d-none", s.ttsProvider !== "openrouter");
  $("cadenceSelect").value = String(s.cadenceSec);
  $("cadenceQuick").value = String(s.cadenceSec);
  $("maxSources").value = String(s.maxSources);
  $("prefetch").value = String(s.prefetch);
  $("localeSelect").value = s.locale;
  $("googleNews").checked = s.useGoogleNews;
  $("deepRead").checked = s.deepRead;
  $("styleNote").value = s.styleNote ?? "";
  $("archive").checked = !!s.archive;
  $("knowledge").checked = s.knowledgeFallback !== false;
  $("newsMemory").checked = s.newsMemory !== false;
  $("musicMood").innerHTML = (S.presets.musicMoods ?? []).map((id) => `<option value="${esc(id)}">${esc(t(`music.mood.${id}`))}</option>`).join("");
  $("musicMood").value = s.musicMood ?? "ambient";
  renderMusicLibrary();
  $("musicFolder").value = s.musicFolder ?? "";
  renderMemoryInfo();
  $("archiveInfo").innerHTML = t("sources.archiveInfo", { n: S.stats.archiveCount ?? 0, dir: `<code>${esc(S.presets.showsDir ?? "shows")}</code>` });
  $("listenerName").value = s.listener?.name ?? "";
  $("listenerPersona").value = s.listener?.persona ?? "";
  $("tutoiement").checked = s.tutoiement !== false;
  $("duoPreset").innerHTML =
    `<option value="">${esc(t("voice.duo.placeholder"))}</option>` +
    (S.presets.duoPresets ?? []).map((preset, index) => `<option value="${index}">${esc(preset.label)}</option>`).join("");
  renderHostsEditor();
  renderTemplateList();
  renderThemeCatalog($("themeSearch")?.value ?? "");
  $("feedList").innerHTML = S.presets.feeds
    .map(
      (feed) => `<div class="form-check">
        <input class="form-check-input" type="checkbox" id="feed-${esc(feed.id)}" data-feed="${esc(feed.id)}" ${s.feeds.includes(feed.id) ? "checked" : ""}>
        <label class="form-check-label small" for="feed-${esc(feed.id)}">${esc(feed.label)}</label>
        <span class="form-text d-block">${esc(feed.url)}</span>
      </div>`,
    )
    .join("");
  $("feedList").querySelectorAll("[data-feed]").forEach((input) => {
    input.addEventListener("change", () => {
      const picked = [...$("feedList").querySelectorAll("[data-feed]")].filter((i) => i.checked).map((i) => i.dataset.feed);
      patchSettings({ feeds: picked });
    });
  });
  $("customFeedList").innerHTML = (s.customFeeds ?? [])
    .map((f) => `<div class="d-flex justify-content-between align-items-center"><span>${esc(f.label)} <code class="small">${esc(f.url)}</code></span></div>`)
    .join("");
  renderLlmSelect();
  renderFastSelect();
  renderTtsModels();
  renderVoiceSelects();
  // Le libellé du moteur dépend des réglages : il était peint avant leur
  // chargement et restait donc sur « Edge » pour un moteur OpenRouter ou local.
  renderQueue();
  $("usageGrid").innerHTML = [
    [t("usage.hosts"), `${s.hostCount === 1 ? t("usage.hosts.one") : t("usage.hosts.two")} · ${(s.hosts ?? []).map((h) => h.name).join(" + ")}`],
    [t("usage.listener"), s.listener?.name ?? "—"],
    [t("usage.cost"), fmtCost(S.stats.totalCostUsd)],
    [t("usage.perMin"), costProjection(S.sessionStats) ? fmtCost(costProjection(S.sessionStats).perMinute) : t("usage.after1min")],
    [t("usage.perHour"), costProjection(S.sessionStats) ? fmtCost(costProjection(S.sessionStats).perHour) : t("usage.after1min")],
    [t("usage.segments"), `${S.stats.segments ?? 0}`],
    [t("usage.audio"), `${((S.stats.audioSeconds ?? 0) / 60).toFixed(1)} min`],
    [t("usage.news"), `${((S.stats.newsMs ?? 0) / 1000).toFixed(0)} s`],
    [t("usage.script"), `${((S.stats.scriptMs ?? 0) / 1000).toFixed(0)} s`],
    [t("usage.tts"), `${((S.stats.ttsMs ?? 0) / 1000).toFixed(0)} s`],
    [t("usage.costLlm"), fmtCost(S.stats.llmCostUsd ?? 0)],
    [t("usage.costTts"), fmtCost(S.stats.ttsCostUsd ?? 0)],
    [t("usage.archived"), `${S.stats.archiveCount ?? 0}`],
  ]
    .map(([k, v]) => `<div class="usage-cell"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join("");
}

/* ─────────────────────────── comparateur TTS ─────────────────────────── */

async function runCompare() {
  const body = $("compareBody");
  body.innerHTML = `<tr><td colspan="6" class="text-secondary"><span class="spinner-border spinner-border-sm"></span> ${esc(t("compare.running"))}</td></tr>`;
  try {
    const data = await api.compare($("compareText").value.trim(), [], true);
    const cheapest = data.rows.filter(r => r.ok).sort((a, b) => a.costPer1k - b.costPer1k || a.ms - b.ms)[0];
    body.innerHTML = data.rows
      .map((r) => {
        if (!r.ok) {
          return `<tr><td>${esc(r.label)}</td><td colspan="5" class="err">${esc(r.error || t("compare.fail"))}</td></tr>`;
        }
        const win = r === cheapest ? " winner" : "";
        return `<tr>
          <td class="${win}">${esc(r.label)}${r.free ? ` <span class="tag playing">${esc(t("models.free"))}</span>` : ""}</td>
          <td class="small">${esc(r.voice)}</td>
          <td class="text-end">${r.ms} ms</td>
          <td class="text-end">${(r.bytes / 1024).toFixed(0)} ${getLocale() === "fr" ? "ko" : "kB"}</td>
          <td class="text-end${win}">${r.costPer1k === 0 ? "0" : r.costPer1k.toFixed(5)}${r.approximate ? " ≈" : ""} $</td>
          <td class="text-end"><button class="btn btn-glass btn-sm" data-audio="${esc(r.candidate)}"><i class="bi bi-play-fill"></i></button></td>
        </tr>`;
      })
      .join("");
    body.querySelectorAll("[data-audio]").forEach((button) => {
      button.addEventListener("click", () => {
        const row = data.rows.find((r) => r.candidate === button.dataset.audio);
        if (row?.audio) new Audio(row.audio).play();
      });
    });
    const cheapestOk = data.rows.filter((r) => r.ok).sort((a, b) => a.costPer1k - b.costPer1k)[0];
    $("compareNote").textContent = cheapestOk
      ? t("compare.note", {
          n: data.rows.length,
          len: data.text.length,
          label: cheapestOk.label,
          cost: cheapestOk.costPer1k === 0 ? t("models.free") : `${cheapestOk.costPer1k.toFixed(5)} $ / 1k chars`,
        })
      : t("compare.none");
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" class="err">${esc(err.message)}</td></tr>`;
  }
}

/* ─────────────────────────── amorçage ─────────────────────────── */

async function refreshState() {
  const data = await api.state();
  S.settings = data.settings;
  applyLocale(data.settings.locale);
  S.selectedModel = data.models.llmModel;
  if (S.activeTopic) S.settings.topic = S.activeTopic;
  S.stats = data.stats;
  S.presets = {
    feeds: data.feeds,
    locales: data.locales,
    cadenceOptions: data.cadenceOptions,
    ttsPresets: data.ttsPresets,
    customTemplates: data.customTemplates ?? [],
    themes: data.themes,
    themeGroups: data.themeGroups,
    hostDefaults: data.hostDefaults,
    personaTemplates: data.personaTemplates,
    duoPresets: data.duoPresets,
    showsDir: data.showsDir,
    musicMoods: data.musicMoods ?? [],
  };
  S.stats.archiveCount = data.archivedOnDisk ?? data.archivedCount;
  S.memory = data.memory ?? { today: 0, total: 0 };
  S.played = Array.isArray(data.played) ? data.played : [];
  S.voices = Array.isArray(data.voices) ? data.voices : [];
  S.hostsDefaults = data.hostDefaults?.[data.settings.locale] ?? [];
  S.defaultOrVoice = data.defaultOpenRouterVoice;
  if (data.cadenceOptions?.length) {
    const options = data.cadenceOptions.map((n) => `<option value="${n}">${n >= 60 ? `${n / 60} min` : `${n} s`}</option>`).join("");
    $("cadenceSelect").innerHTML = options;
    $("cadenceQuick").innerHTML = options;
  }
  $("localeSelect").innerHTML = data.locales.map((l) => `<option value="${l.id}">${esc(l.label)}</option>`).join("");
  $("localeSelect").value = data.settings.locale;
  if (data.history?.length) {
    [...data.history].reverse().forEach((segment) => upsertCard(segment));
  }
  renderStats();
  syncControls();
  void refreshMusicInfo();
  renderChips();
  // Peint aussi la file et les libellés d'activité, qui dépendent des réglages.
  engine.emit();
  if (!$("compareText").value) {
    $("compareText").value =
      S.settings.locale === "fr"
        ? "Le trafic est dense sur la ligne B, et la météo annonce des averses en fin de journée."
        : "Traffic is heavy on the metro, and showers are expected later today.";
  }
  return data;
}

async function checkLocalTts() {
  try {
    const data = await fetch("/api/tts/local").then(r => r.json());
    $("localTtsState").textContent = data.ready
      ? `Chatterbox V3 ${getLocale() === "fr" ? "prêt" : "ready"} · ${data.gpu || data.device} · ${data.voices.filter(v => v.reference).length}/2 ${getLocale() === "fr" ? "références" : "references"}`
      : data.error || (getLocale() === "fr" ? "Chargement des poids V3 en cours…" : "Loading V3 weights…");
  } catch (err) { $("localTtsState").textContent = err.message; }
}

function wireEvents() {
  // Bascule FR/EN : elle pilote l'interface ET le réglage « langue de l'émission ».
  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.lang;
      if (!S.settings || next === S.settings.locale) return;
      void patchSettings({ locale: next });
    });
  });
  $("localCheck").addEventListener("click", checkLocalTts);
  $("localExaggeration").addEventListener("change", () => patchSettings({ localExaggeration: Number($("localExaggeration").value) }));
  [1, 2].forEach(index => $("voiceRef" + index).addEventListener("change", async () => {
    const file = $("voiceRef" + index).files?.[0];
    if (!file) return;
    try {
      const res = await fetch(`/api/tts/local/voices/host-${index}`, { method: "PUT", body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || "Import vocal impossible.");
      toast(t("tts.localRefSaved", { n: index }));
      void checkLocalTts();
    } catch (err) { toast(err.message, "danger"); }
  }));
  $("chipEditorBtn").addEventListener("click", () => document.querySelector('[data-bs-target="#tab-sources"]').click());
  $("startupRetry").addEventListener("click", () => void loadApplication());
  $("welcomePlay").addEventListener("click", () => $("playBtn").click());
  $("questionInput").addEventListener("input", renderListeningState);
  $("topicApply").addEventListener("click", () => { const topic = $("topicInput").value.trim(); if (topic) selectTopic(topic); });
  $("topicInput").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); $("topicApply").click(); } });
  $("radioMode").addEventListener("change", () => { S.settings.radioMode = $("radioMode").value; engine.changeTopic(); void patchSettings({ radioMode: S.settings.radioMode }); });
  $("searchInterval").addEventListener("change", () => patchSettings({ searchIntervalSec: Number($("searchInterval").value) }));
  $("questionTiming").addEventListener("change", () => patchSettings({ questionTiming: $("questionTiming").value }));
  $("conversationClear").addEventListener("click", () => { engine.clearConversation(); engine.changeTopic(); toast(t("console.forget.done")); });
  $("ttsFallback").addEventListener("change", () => patchSettings({ ttsFallback: $("ttsFallback").checked }));
  $("ttsFallbackModel").addEventListener("change", () => patchSettings({ ttsFallbackModel: $("ttsFallbackModel").value }));
  for (const id of ["humor", "disagreement", "technicality", "replyLength", "addressFrequency"]) $(id).addEventListener("change", () => patchSettings({ [id]: Number($(id).value) }));
  $("playBtn").addEventListener("click", () => {
    if (S.status === "playing" || S.status === "working") pausePlayback();
    else resumePlayback();
  });
  $("skipBtn").addEventListener("click", skip);
  $("stopBtn").addEventListener("click", stopPlayback);
  $("seekBar").addEventListener("input", () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = (Number($("seekBar").value) / 1000) * audio.duration;
  });
  $("volume").addEventListener("input", applyVolume);
  $("backBtn").addEventListener("click", () => {
    audio.currentTime = Math.max(0, audio.currentTime - 15);
  });
  $("fwdBtn").addEventListener("click", () => {
    audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15);
  });
  $("liveSpeed").addEventListener("change", () => {
    audio.playbackRate = Number($("liveSpeed").value) || 1;
  });
  $("muteBtn").addEventListener("click", () => {
    // La sourdine retient le niveau d'avant, pour le rendre tel quel au retour.
    if (audio.volume > 0) lastVolume = audio.volume;
    $("volume").value = String(audio.volume > 0 ? 0 : lastVolume);
    applyVolume();
  });

  audio.addEventListener("ended", () => engine.ended());
  audio.addEventListener("error", () => {
    if (audio.getAttribute("src")) engine.audioError(t("play.audioError"));
  });
  // Without word timings, the real duration sharpens the highlight a lot.
  audio.addEventListener("loadedmetadata", () => {
    if (!S.current || S.current.exact || !Number.isFinite(audio.duration)) return;
    const { segment } = S.current;
    const at = audio.currentTime;
    renderTranscript(segment, audio.duration);
    audio.currentTime = at;
  });

  $("askBtn").addEventListener("click", () => void ask());
  $("debateBtn").addEventListener("click", () => void startDebate());
  $("questionInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void ask();
    }
  });

  $("newsFilter").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    S.filter = button.dataset.filter;    $("newsFilter").querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b === button);
      b.setAttribute("aria-pressed", String(b === button));
    });
    applyFilter();
  });

  $("cadenceQuick").addEventListener("change", () => patchSettings({ cadenceSec: Number($("cadenceQuick").value) }));
  $("cadenceSelect").addEventListener("change", () => patchSettings({ cadenceSec: Number($("cadenceSelect").value) }));
  $("localeSelect").addEventListener("change", () => patchSettings({ locale: $("localeSelect").value }));
  $("googleNews").addEventListener("change", () => patchSettings({ useGoogleNews: $("googleNews").checked }));
  $("deepRead").addEventListener("change", () => patchSettings({ deepRead: $("deepRead").checked }));
  $("maxSources").addEventListener("change", () => patchSettings({ maxSources: Number($("maxSources").value) }));
  $("prefetch").addEventListener("change", () => patchSettings({ prefetch: Number($("prefetch").value) }));
  $("styleNote").addEventListener("change", () => patchSettings({ styleNote: $("styleNote").value }));
  $("ttsSpeed").addEventListener("input", () => {
    $("ttsSpeedLabel").textContent = `${Number($("ttsSpeed").value).toFixed(2)}×`;
  });
  $("ttsSpeed").addEventListener("change", () => patchSettings({ ttsSpeed: Number($("ttsSpeed").value) }));

  $("keySaveBtn").addEventListener("click", async () => {
    const key = $("keyInput").value.trim();
    if (!key) return;
    await patchSettings({ openrouterKey: key });
    $("keyInput").value = "";
    toast(t("models.key.done"));
  });
  $("keyCheckBtn").addEventListener("click", async () => {
    try {
      const res = await api.checkKey($("keyInput").value.trim());
      $("keyState").textContent = res.message;
      toast(res.message, res.ok ? "primary" : "danger");
    } catch (err) {
      toast(err.message, "danger");
    }
  });

  let llmTimer = null;
  $("llmSearch").addEventListener("input", () => {
    clearTimeout(llmTimer);
    llmTimer = setTimeout(() => void loadLlmModels($("llmSearch").value.trim()).catch((e) => toast(e.message, "danger")), 280);
  });
  $("llmSelect").addEventListener("change", () => patchSettings({ llmModel: $("llmSelect").value }));
  $("llmSelectFast").addEventListener("change", () => patchSettings({ llmModelFast: $("llmSelectFast").value }));
  $("llmCheap").addEventListener("click", () => {
    const cheapest = [...S.llmModels].filter((m) => !m.free).sort((a, b) => a.outPerM - b.outPerM)[0];
    if (cheapest) {
      patchSettings({ llmModel: cheapest.id });
      toast(t("models.llm.cheapDone", { name: cheapest.name }));
    }
  });
  $("llmFree").addEventListener("click", () => {
    const free = S.llmModels.filter((m) => m.free);
    S.llmModels = free.length ? free : S.llmModels;
    renderLlmSelect();
    toast(t("models.llm.freeCount", { n: S.llmModels.length }));
  });

  $("ttsProvider").addEventListener("change", async () => {
    const provider = $("ttsProvider").value;
    // Keep the hosts' voices coherent: Edge voices and model voices are not interchangeable.
    const hosts = (S.settings.hosts ?? []).map((host, index) => ({
      ...host,
      voice: provider === "local" ? `host-${index + 1}` : provider === "openrouter" ? S.defaultOrVoice || host.voice : S.hostsDefaults?.[index]?.voice ?? edgeVoices()[index]?.id ?? host.voice,
    }));
    await patchSettings({ ttsProvider: provider, hosts });
    if (provider === "local") void checkLocalTts();
  });
  $("ttsModel").addEventListener("change", async () => {
    const model = S.ttsModels.find((m) => m.id === $("ttsModel").value);
    await patchSettings({ ttsModel: $("ttsModel").value });
    if (model) {
      const voice = model.voices.find((v) => /^fr[-_]/i.test(v) || /^en[-_]/i.test(v)) ?? model.voices[0];
      if (voice) patchSettings({ ttsVoice: voice });
    }
  });
  $("hostCountGroup").addEventListener("click", (event) => {
    const button = event.target.closest("[data-count]");
    if (button) patchSettings({ hostCount: Number(button.dataset.count) });
  });
  $("musicChoose").addEventListener("click", () => $("musicDirectory").click());
  $("musicServerSettings").addEventListener("click", () => document.querySelector('[data-bs-target="#tab-sources"]').click());
  $("musicDirectory").addEventListener("change", async () => {
    const files = [...$("musicDirectory").files];
    $("musicDirectory").value = "";
    const audioFiles = files.filter(file => /\.(mp3|ogg|m4a|wav|flac|aac)$/i.test(file.name) && !file.name.startsWith("."));
    if (!audioFiles.length) { toast(t("music.browser.empty"), "danger"); return; }
    browserMusic = audioFiles;
    browserMusicFolder = audioFiles[0].webkitRelativePath.split("/")[0] || t("music.browser.folder");
    resetMusicBed();
    renderMusicLibrary();
    if (S.settings.musicMood === "aucun") await patchSettings({ musicMood: "ambient" });
    updateWaitingMusic(engine);
  });
  $("musicClear").addEventListener("click", () => {
    browserMusic = [];
    browserMusicFolder = "";
    resetMusicBed();
    renderMusicLibrary();
    updateWaitingMusic(engine);
  });
  $("musicMood").addEventListener("change", async () => {
    resetMusicBed();
    await patchSettings({ musicMood: $("musicMood").value });
    const report = await refreshMusicInfo();
    toast(t("music.changed.mood", { mood: t(`music.mood.${$("musicMood").value}`), n: report.tracks?.length ?? 0 }));
  });
  $("musicFolder").addEventListener("change", async () => {
    resetMusicBed();
    await patchSettings({ musicFolder: $("musicFolder").value.trim() });
    const report = await refreshMusicInfo();
    const n = report.tracks?.length ?? 0;
    if (report.error === "unreadable") toast(t("music.info.unreadable", { dir: report.folder }), "danger");
    else toast(t("music.changed.folder", { n, dir: report.folder || "public/music" }));
  });
  $("archive").addEventListener("change", () => patchSettings({ archive: $("archive").checked }));
  $("knowledge").addEventListener("change", () => patchSettings({ knowledgeFallback: $("knowledge").checked }));
  $("newsMemory").addEventListener("change", () => patchSettings({ newsMemory: $("newsMemory").checked }));
  // Oublier une seule histoire : le bouton porte la clé exacte (titre + horodatage).
  $("memoryList").addEventListener("click", async (event) => {
    const button = event.target.closest(".memory-forget");
    if (!button) return;
    const { title, at } = button.dataset;
    try {
      const res = await api.forgetStory(title, at);
      S.memory = res.memory ?? S.memory;
      S.played = res.played ?? (S.played ?? []).filter((story) => !(story.title === title && story.at === at));
      syncControls();
      toast(t("sources.memory.forgot", { title }));
    } catch (err) {
      toast(err.message, "danger");
    }
  });
  $("memoryClearBtn").addEventListener("click", async () => {
    try {
      const res = await api.clearMemory();
      S.memory = res.memory ?? { today: 0, total: 0 };
      S.played = res.played ?? [];
      syncControls();
      toast(t("sources.memoryCleared", { n: res.cleared }));
    } catch (err) {
      toast(err.message, "danger");
    }
  });
  $("themeSearch").addEventListener("input", () => renderThemeCatalog($("themeSearch").value));
  ["listenerName", "listenerPersona"].forEach((id) => {
    $(id).addEventListener("change", () => {
      const name = $("listenerName").value.trim() || S.settings.listener?.name || "";
      patchSettings({ listener: { name, persona: $("listenerPersona").value.trim() } });
    });
  });
  $("tutoiement").addEventListener("change", () => patchSettings({ tutoiement: $("tutoiement").checked }));
  $("tplSaveBtn").addEventListener("click", () => void saveTemplate());
  $("tplResetBtn").addEventListener("click", () => resetTemplateForm());
  $("teamImportBtn").addEventListener("click", () => $("teamImportFile").click());
  $("teamImportFile").addEventListener("change", () => {
    const file = $("teamImportFile").files?.[0];
    $("teamImportFile").value = "";
    if (file) void importTeam(file);
  });
  $("duoPreset").addEventListener("change", () => {
    const preset = (S.presets.duoPresets ?? [])[Number($("duoPreset").value)];
    if (!preset) return;
    const next = (S.settings.hosts ?? []).map((host) => ({ ...host }));
    preset.templateIds.forEach((id, index) => {
      const template = personaTemplates().find((tpl) => tpl.id === id);
      if (!template) return;
      const localized = template[S.settings.locale] ?? template.fr;
      next[index] = {
        name: localized.name,
        persona: localized.persona,
        voice: S.settings.ttsProvider === "edge" ? suggestVoice(template.gender) : next[index].voice,
      };
    });
    patchSettings({ hosts: ensureDistinctVoices(next), hostCount: 2 });
    $("duoPreset").value = "";
    toast(t("voice.duo.applied", { names: next.map((h) => h.name).join(" & ") }));
  });

  $("previewBtn").addEventListener("click", async () => {
    const button = $("previewBtn");
    button.disabled = true;
    button.innerHTML = `<span class="spinner-border spinner-border-sm"></span> ${esc(t("compare.running"))}`;
    try {
      const url = await api.preview("");
      const player = new Audio(url);
      player.addEventListener("ended", () => URL.revokeObjectURL(url));
      await player.play();
    } catch (err) {
      toast(err.message, "danger");
    } finally {
      button.disabled = false;
      button.innerHTML = `<i class="bi bi-play-circle"></i> ${esc(t("tts.preview"))}`;
    }
  });

  $("compareRunBtn").addEventListener("click", () => void runCompare());
  $("compareFromTranscript").addEventListener("click", () => {
    const text = S.current?.segment?.transcript;
    if (!text) {
      toast(t("compare.noTranscript"), "danger");
      return;
    }
    $("compareText").value = text.slice(0, 300);
  });

  $("addFeedBtn").addEventListener("click", () => {
    const label = $("customFeedLabel").value.trim();
    const url = $("customFeedUrl").value.trim();
    if (!url.startsWith("http")) {
      toast(t("sources.feedInvalid"), "danger");
      return;
    }
    patchSettings({ customFeeds: [...(S.settings.customFeeds ?? []), { label: label || url, url }] });
    $("customFeedLabel").value = "";
    $("customFeedUrl").value = "";
  });
  $("addChipBtn").addEventListener("click", () => {
    const value = $("newChip").value.trim();
    if (!value) return;
    patchSettings({ chips: [...S.settings.chips, value] });
    $("newChip").value = "";
  });
  $("resetBtn").addEventListener("click", async () => {
    engine.stop();
    await api.reset();
    S.cards.clear();
    $("newsList").innerHTML = `<p class="muted-note">${t("news.empty")}</p>`;
    S.stats = { totalCostUsd: 0, segments: 0, audioSeconds: 0 };
    S.sessionStats = { totalCostUsd: 0, audioSeconds: 0 };
    renderStats();
    syncControls();
    toast(t("usage.reset.done"));
  });

  document.addEventListener("keydown", (event) => {
    const tag = document.activeElement?.tagName;
    if (["TEXTAREA", "INPUT", "SELECT", "BUTTON", "A", "SUMMARY"].includes(tag) || document.activeElement?.isContentEditable) return;
    if (event.code === "Space") {
      event.preventDefault();
      if (S.status === "playing" || S.status === "working") pausePlayback();
      else resumePlayback();
    }
    if (event.key === "ArrowRight" && event.shiftKey) skip();
  });

}

async function loadApplication() {
  if (S.loading) return;
  S.loading = true;
  S.startupError = "";
  renderListeningState();
  try {
    await refreshState();
    S.ready = true;
  } catch (err) {
    S.ready = false;
    S.startupError = t("welcome.error", { message: err.message });
    return;
  } finally {
    S.loading = false;
    renderListeningState();
  }
  if (S.settings.ttsProvider === "local") void checkLocalTts();
  // Un catalogue indisponible ne doit pas empêcher l'écoute avec les réglages chargés.
  try {
    await loadLlmModels("");
    const models = await api.models("tts", "");
    S.ttsModels = models.tts;
    renderTtsModels();
    renderVoiceSelects();
  } catch (err) {
    toast(t("welcome.catalogError", { message: err.message }), "danger");
  }
}

async function boot() {
  applyI18n(document);
  wireEvents();
  setStatus("idle");
  renderQueue();
  requestAnimationFrame(loop);
  await loadApplication();
}

void boot();
