/**
 * Page Replay : liste les émissions archivées (shows/AAAA-MM-JJ/…), affiche leur
 * transcript et les réécoute. Le surlignage mot à mot s'appuie sur les timings
 * enregistrés dans le .json (Edge TTS), sinon sur une estimation.
 */
import { api } from "./api.js";
import { applyI18n, getLocale, setLocale, t } from "./i18n.js";
import { prepareSegment, tokenIndexAt } from "./transcript.js";

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const localeTag = () => (getLocale() === "fr" ? "fr-FR" : "en-GB");

const fmtTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

const fmtCost = (usd) => {
  const value = Number(usd) || 0;
  if (value === 0) return t("replay.free");
  return getLocale() === "fr" ? `${value.toFixed(5).replace(".", ",")} $` : `$${value.toFixed(5)}`;
};

const fmtSize = (bytes) => {
  const mb = (Number(bytes) || 0) / 1e6;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} ${t("replay.size")}`;
};

const fmtDay = (day) => {
  const date = new Date(`${day}T12:00:00`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString(localeTag(), { weekday: "long", day: "numeric", month: "long" });
};

function toast(message, kind = "primary") {
  const el = document.createElement("div");
  el.className = "toast align-items-center border-0 show mb-2";
  el.innerHTML = `<div class="d-flex"><div class="toast-body"><i class="bi bi-${kind === "danger" ? "exclamation-triangle" : "info-circle"}"></i> ${esc(message)}</div>
    <button class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 7000);
}

const audio = $("replayAudio");
audio.volume = 0.95;

const S = {
  days: [],
  day: "",
  shows: [],
  filter: "all",
  search: "",
  playing: null, // { show, prepared, tokenEls, sentenceEls, index, sentenceIndex }
  selected: null,
};

/* ─────────────────────────── liste ─────────────────────────── */

function visibleShows() {
  const needle = S.search.trim().toLowerCase();
  return S.shows.filter((show) => {
    if (S.filter !== "all" && show.kind !== S.filter) return false;
    if (!needle) return true;
    const haystack = [show.title, show.topic, show.question, show.searchQuery, ...show.sources.map((s) => `${s.source} ${s.title}`)]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

function renderDays() {
  $("dayCount").textContent = String(S.days.length);
  $("dayRow").innerHTML = S.days
    .map((entry) => {
      const date = new Date(`${entry.day}T12:00:00`);
      const short = Number.isNaN(date.getTime())
        ? entry.day
        : date.toLocaleDateString(localeTag(), { day: "2-digit", month: "2-digit" });
      return `<button class="chip${entry.day === S.day ? " active" : ""}" data-day="${esc(entry.day)}" title="${esc(fmtDay(entry.day))}">
        <i class="bi bi-calendar-event"></i> ${esc(short)} <span class="rm">${entry.count}</span>
      </button>`;
    })
    .join("") || `<p class="muted-note">${t("replay.noArchives")}</p>`;
  $("dayRow").querySelectorAll("[data-day]").forEach((chip) => {
    chip.addEventListener("click", () => void load(chip.dataset.day));
  });
}

function showCard(show) {
  const active = S.playing?.show?.id === show.id;
  const kindClass = show.kind === "question" ? "question" : show.kind === "debate" ? "debate" : "news";
  const speakerBadges = show.speakers
    .map((speaker, index) => `<span class="stage-chip sp${index % 2}">${esc(speaker.name)}${speaker.voice ? ` · ${esc(speaker.voice.replace("Neural", "").split("-").pop())}` : ""}</span>`)
    .join("");
  return `
  <article class="news-card show-card${active ? " active" : ""}" data-show="${esc(show.id)}">
    <div class="nc-head">
      <span class="tag ${kindClass}">${esc(t(`news.kind.${show.kind === "news" ? "news" : show.kind}`))}</span>
      <span>${esc(show.clock || "")}</span>
      <span class="ms-auto">${show.durationSec ? `${Math.round(show.durationSec)}s` : "—"} · ${fmtSize(show.sizeBytes)}</span>
    </div>
    <div class="nc-title">${esc(show.title || show.file)}</div>
    ${show.question ? `<div class="search-line"><i class="bi bi-patch-question"></i> ${esc(show.question)}</div>` : ""}
    <div class="search-line"><i class="bi bi-search"></i> ${esc(show.searchQuery || show.topic || "—")}${show.sourceCount ? ` · ${t("transcript.sources", { n: show.sourceCount })}` : ""}</div>
    <div class="stage-chips">${speakerBadges}<span class="stage-chip">${t("news.replies", { n: show.turns.length })}</span><span class="stage-chip">${fmtCost(show.costUsd)}</span></div>
    <div class="d-flex gap-2 mt-2">
      <button class="btn btn-glass btn-sm" data-play="${esc(show.id)}"><i class="bi bi-play-fill"></i> ${active ? esc(t("replay.nowPlaying")) : esc(t("replay.listenAgain"))}</button>
      <button class="btn btn-glass btn-sm" data-open="${esc(show.id)}"><i class="bi bi-card-text"></i> ${esc(t("replay.transcript"))}</button>
      <a class="btn btn-glass btn-sm" href="${esc(show.url)}" download title="${esc(t("replay.download"))}"><i class="bi bi-download"></i> MP3</a>
      <button class="btn btn-glass btn-sm text-danger ms-auto" data-del="${esc(show.id)}" title="${esc(t("replay.delete.title"))}"><i class="bi bi-trash3"></i></button>
    </div>
  </article>`;
}

function renderList() {
  const list = visibleShows();
  $("showList").innerHTML = list.length
    ? list.map(showCard).join("")
    : S.shows.length
      ? `<p class="muted-note">${t("replay.filter.empty")}</p>`
      : `<p class="muted-note">${t("replay.emptyDay")}</p>`;
  $("showList").querySelectorAll("[data-play]").forEach((button) => {
    button.addEventListener("click", () => {
      const show = S.shows.find((s) => s.id === button.dataset.play);
      if (show) play(show);
    });
  });
  $("showList").querySelectorAll("[data-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const show = S.shows.find((s) => s.id === button.dataset.open);
      if (show) open(show);
    });
  });
  $("showList").querySelectorAll("[data-del]").forEach((button) => {
    button.addEventListener("click", () => void removeShow(button.dataset.del));
  });
}

function renderCounts() {
  const total = S.days.reduce((sum, entry) => sum + entry.count, 0);
  $("replayCount").textContent = String(total);
  $("replaySize").textContent = fmtSize(S.shows.reduce((sum, show) => sum + show.sizeBytes, 0));
}

/** Supprime une archive du disque (MP3 + JSON) après confirmation. */
async function removeShow(id) {
  const show = S.shows.find((s) => s.id === id);
  if (!show) return;
  const label = show.title || show.file;
  if (!confirm(t("replay.deleteConfirm", { title: label }))) return;
  try {
    const data = await api.deleteShow(show.day, show.file);
    if (S.playing?.show?.id === id) {
      audio.pause();
      audio.removeAttribute("src");
      S.playing = null;
      S.selected = null;
      $("pbTitle").textContent = t("replay.none.selected");
      $("pbSub").textContent = t("replay.select");
    }
    S.days = data.days ?? S.days;
    S.day = data.day ?? S.day;
    S.shows = data.shows ?? [];
    renderDays();
    renderList();
    renderCounts();
    toast(t("replay.deleted", { title: label }));
  } catch (err) {
    toast(err.message, "danger");
  }
}

async function load(day) {
  try {
    const data = await api.shows(day);
    S.days = data.days ?? [];
    S.day = data.day ?? "";
    S.shows = data.shows ?? [];
    renderDays();
    renderList();
    renderCounts();
  } catch (err) {
    $("showList").innerHTML = `<p class="muted-note err">${esc(err.message)}</p>`;
    toast(err.message, "danger");
  }
}

/* ─────────────────────────── transcript ─────────────────────────── */

function renderTranscript(show, durationSec = NaN) {
  const prepared = prepareSegment(
    { transcript: show.transcript, turns: show.turns, words: show.words, estimatedSeconds: show.durationSec },
    durationSec,
  );
  const container = $("replayTranscript");
  container.innerHTML = "";
  const tokenEls = [];
  const sentenceEls = [];
  const turnEls = [];
  let currentSentence = -1;
  let currentSpan = null;
  for (const token of prepared.tokens) {
    if (!turnEls[token.turn]) {
      const block = document.createElement("div");
      block.className = `turn sp${token.turn % 2}`;
      const head = document.createElement("div");
      head.className = "turn-head";
      head.textContent = show.turns?.[token.turn]?.name || show.speakers[token.turn % 2]?.name || `Voice ${(token.turn % 2) + 1}`;
      block.appendChild(head);
      const text = document.createElement("div");
      text.className = "turn-text";
      block.appendChild(text);
      container.appendChild(block);
      turnEls[token.turn] = { block, text };
    }
    if (currentSentence !== token.sentence) {
      currentSentence = token.sentence;
      currentSpan = document.createElement("span");
      currentSpan.className = "sentence pending";
      turnEls[token.turn].text.appendChild(currentSpan);
      turnEls[token.turn].text.appendChild(document.createTextNode(" "));
      sentenceEls.push(currentSpan);
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
    tokenEls.push(span);
  }
  const exact = Array.isArray(show.words) && show.words.length > 0;
  return {
    prepared,
    tokenEls,
    sentenceEls,
    turnEls,
    exact,
    index: -1,
    sentenceIndex: -1,
  };
}

function renderSources(show) {
  $("replaySources").innerHTML = show.sources.length
    ? show.sources
        .map(
          (source, index) =>
            `<a class="source-item" href="${esc(source.url)}" target="_blank" rel="noreferrer"><span class="src">${index + 1}. ${esc(source.source || "source")}</span><br>${esc(source.title)}</a>`,
        )
        .join("")
    : `<p class="muted-note">${t("replay.noSources")}</p>`;
}

/** Affiche le transcript sans démarrer la lecture. */
function open(show, view = renderTranscript(show)) {
  S.selected = show;
  renderSources(show);
  $("replayBadges").innerHTML = [
    `<span class="tag ${show.kind === "question" ? "question" : show.kind === "debate" ? "debate" : "news"}">${esc(t(`news.kind.${show.kind === "news" ? "news" : show.kind}`))}</span>`,
    `<span class="tag ${view.exact ? "playing" : "pending"}">${view.exact ? t("transcript.sync.exact") : t("transcript.sync.estimated")}</span>`,
  ].join(" ");
  $("replaySync").textContent = `${show.clock} · ${t("replay.detail", { n: show.turns.length, chars: show.transcript.length })}`;
  $("replayVoices").textContent = show.speakers.map((s) => s.name).join(" + ");
  $("pbTitle").textContent = show.title || show.file;
  $("pbSub").innerHTML = `${esc(t(`news.kind.${show.kind === "news" ? "news" : show.kind}`))} · ${esc(show.searchQuery || show.topic || "")} · ${new Date(show.createdAt ?? Date.now()).toLocaleString(localeTag())}`;
}

/* ─────────────────────────── lecture ─────────────────────────── */

function play(show) {
  const same = S.playing?.show?.id === show.id;
  if (same && !audio.paused) {
    audio.pause();
    return;
  }
  const view = same ? S.playing : renderTranscript(show);
  open(show, view);
  S.playing = { ...view, show };
  if (!same || audio.src !== new URL(show.url, location.href).href) {
    audio.src = show.url;
    audio.currentTime = 0;
  }
  audio.play().catch((err) => toast(t("replay.playFailed", { message: err.message }), "danger"));
  renderList();
}

function step(delta) {
  const list = visibleShows().length ? visibleShows() : S.shows;
  const current = S.playing?.show ?? S.selected;
  if (!list.length) return;
  const index = current ? list.findIndex((show) => show.id === current.id) : -1;
  const next = list[(index + delta + list.length) % list.length];
  if (next) play(next);
}

function updateHighlight() {
  const cur = S.playing;
  if (!cur) return;
  const index = tokenIndexAt(cur.prepared.tokens, audio.currentTime * 1000);
  if (index !== cur.index) {
    if (cur.index >= 0) cur.tokenEls[cur.index].classList.replace("active", "spoken");
    if (index >= 0) {
      cur.tokenEls[index].classList.remove("spoken");
      cur.tokenEls[index].classList.add("active");
    }
    const turnIndex = index >= 0 ? cur.prepared.tokens[index].turn : -1;
    cur.turnEls.forEach((turn, i) => turn && turn.block.classList.toggle("active", i === turnIndex));
    cur.index = index;
  }
  const sentenceIndex = index >= 0 ? cur.prepared.tokens[index].sentence : 0;
  if (sentenceIndex !== cur.sentenceIndex) {
    cur.sentenceEls.forEach((el, i) => {
      el.className = `sentence ${i < sentenceIndex ? "done" : i === sentenceIndex ? "active" : "pending"}`;
    });
    const el = cur.sentenceEls[sentenceIndex];
    if (el) {
      const container = $("replayTranscript");
      container.scrollTop = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
    }
    cur.sentenceIndex = sentenceIndex;
  }
  $("pbCur").textContent = fmtTime(audio.currentTime);
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    $("pbDur").textContent = fmtTime(audio.duration);
    $("pbSeek").value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  }
}

function loop() {
  if (S.playing && !audio.paused) updateHighlight();
  requestAnimationFrame(loop);
}

/* ─────────────────────────── événements ─────────────────────────── */

let lastVolume = 0.95;

function renderVolume() {
  $("pbVolume").value = String(audio.volume);
  $("pbMuteIcon").className = `bi ${audio.volume === 0 ? "bi-volume-mute" : audio.volume < 0.5 ? "bi-volume-down" : "bi-volume-up"}`;
  $("pbMute").setAttribute("aria-pressed", String(audio.volume === 0));
}

function wire() {
  $("refreshBtn").addEventListener("click", () => void load(S.day));
  $("showSearch").addEventListener("input", () => {
    S.search = $("showSearch").value;
    renderList();
  });
  $("kindFilter").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    S.filter = button.dataset.filter;
    $("kindFilter").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === button));
    renderList();
  });

  $("pbPlay").addEventListener("click", () => {
    if (!S.playing && !S.selected) {
      const first = visibleShows()[0];
      if (first) play(first);
      return;
    }
    if (!S.playing && S.selected) play(S.selected);
    else if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
  $("pbBack").addEventListener("click", () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
  $("pbFwd").addEventListener("click", () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15); });
  $("pbPrev").addEventListener("click", () => step(-1));
  $("pbNext").addEventListener("click", () => step(1));
  $("pbSeek").addEventListener("input", () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = (Number($("pbSeek").value) / 1000) * audio.duration;
  });
  $("pbSpeed").addEventListener("change", () => {
    audio.playbackRate = Number($("pbSpeed").value) || 1;
  });
  $("pbVolume").addEventListener("input", () => {
    audio.volume = Number($("pbVolume").value);
    if (audio.volume > 0) lastVolume = audio.volume;
    renderVolume();
  });
  $("pbMute").addEventListener("click", () => {
    if (audio.volume > 0) lastVolume = audio.volume;
    audio.volume = audio.volume > 0 ? 0 : lastVolume;
    renderVolume();
  });

  audio.addEventListener("play", () => {
    $("pbIcon").className = "bi bi-pause-fill";
    renderList();
  });
  audio.addEventListener("pause", () => {
    $("pbIcon").className = "bi bi-play-fill";
    renderList();
  });
  audio.addEventListener("loadedmetadata", () => {
    if (!S.playing) return;
    $("pbSeek").disabled = false;
    $("pbDur").textContent = fmtTime(audio.duration);
    // La durée réelle affine l'estimation quand l'archive n'a pas de timings.
    const at = audio.currentTime;
    const view = renderTranscript(S.playing.show, audio.duration);
    S.playing = { ...S.playing, ...view, show: S.playing.show };
    audio.currentTime = at;
  });
  audio.addEventListener("ended", () => {
    if (S.shows.length > 1) step(1);
    else {
      $("pbIcon").className = "bi bi-play-fill";
      renderList();
    }
  });
  audio.addEventListener("error", () => toast(t("replay.fileMissing"), "danger"));

  document.addEventListener("keydown", (event) => {
    const tag = document.activeElement?.tagName;
    if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY"].includes(tag) || document.activeElement?.isContentEditable) return;
    if (event.code === "Space") {
      event.preventDefault();
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    }
    if (event.key === "ArrowRight" && event.shiftKey) step(1);
    if (event.key === "ArrowLeft" && event.shiftKey) step(-1);
  });
}

/** La page Replay suit la langue de l'émission sans charger tout /api/state. */
async function applyLocale() {
  const { locale } = await api.locale().catch(() => ({ locale: "fr" }));
  setLocale(locale);
  applyI18n(document);
  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.classList.toggle("active", button.dataset.lang === locale);
  });
}

async function boot() {
  await applyLocale();
  wire();
  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.addEventListener("click", async () => {
      const next = button.dataset.lang;
      if (next === getLocale()) return;
      await api.saveSettings({ locale: next }).catch(() => {});
      setLocale(next);
      applyI18n(document);
      document.querySelectorAll("[data-lang]").forEach((other) => other.classList.toggle("active", other.dataset.lang === next));
      renderDays();
      renderList();
      renderCounts();
      if (S.selected) open(S.selected);
    });
  });
  requestAnimationFrame(loop);
  await load();
  const params = new URLSearchParams(location.search);
  const wanted = params.get("show");
  if (wanted) {
    const show = S.shows.find((s) => s.id === wanted) ?? (await api.shows(wanted.split("/")[0])).shows.find((s) => s.id === wanted);
    if (show) play(show);
  }
}

void boot();
