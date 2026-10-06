/**
 * Page Récap : agrège les émissions archivées sur une période (sujets, médias,
 * volume) et fait rédiger la rétrospective par le modèle rapide.
 */
import { api } from "./api.js";
import { applyI18n, getLocale, setLocale, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const localeTag = () => (getLocale() === "fr" ? "fr-FR" : "en-GB");

const fmtCost = (usd) => {
  const value = Number(usd) || 0;
  if (value === 0) return getLocale() === "fr" ? "0,0000 $" : "$0.0000";
  const digits = value < 0.0001 ? 6 : 4;
  return getLocale() === "fr" ? `${value.toFixed(digits).replace(".", ",")} $` : `$${value.toFixed(digits)}`;
};

const fmtDay = (day) => {
  const date = new Date(`${day}T12:00:00`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(localeTag(), { weekday: "long", day: "numeric", month: "long" });
};

function toast(message, kind = "primary") {
  const el = document.createElement("div");
  el.className = "toast align-items-center border-0 show mb-2";
  el.innerHTML = `<div class="d-flex"><div class="toast-body"><i class="bi bi-${kind === "danger" ? "exclamation-triangle" : "info-circle"}"></i> ${esc(message)}</div>
    <button class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 7000);
}

const kindOf = (kind) => ({
  label: t(`news.kind.${kind === "news" ? "news" : kind}`),
  cls: kind === "question" ? "question" : kind === "debate" ? "debate" : "news",
});

const S = { days: 7, digest: null, saved: null };

function renderStats() {
  const totals = S.digest?.totals;
  if (!totals) return;
  $("digestShows").textContent = String(totals.shows);
  $("digestMinutes").textContent = `${Math.round(totals.durationSec / 60)} min`;
  $("digestCost").textContent = fmtCost(totals.costUsd);
  $("digestRange").textContent = S.digest.from ? `${S.digest.from} → ${S.digest.to}` : "—";
  $("digestStats").innerHTML = [
    [t("digest.shows"), `${totals.shows}`],
    [t("digest.bulletins"), `${totals.bulletins}`],
    [t("digest.questions"), `${totals.questions}`],
    [t("digest.debates"), `${totals.debates}`],
    [t("digest.fromMemory"), `${totals.fromMemory}`],
    [t("digest.duration"), `${Math.round(totals.durationSec / 60)} min`],
    [t("digest.sources"), `${totals.sources}`],
    [t("digest.cost"), fmtCost(totals.costUsd)],
  ]
    .map(([k, v]) => `<div class="usage-cell"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join("");
}

function renderRank(target, rows, empty) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  $(target).innerHTML = rows.length
    ? rows
        .map(
          (row) =>
            `<div class="rank-row"><span>${esc(row.label)}</span><span class="rank-bar"><i style="width:${Math.round((row.count / max) * 100)}%"></i></span><span>${row.count}</span></div>`,
        )
        .join("")
    : `<p class="muted-note">${empty}</p>`;
}

function renderDays() {
  const days = S.digest?.byDay ?? [];
  $("dayCount").textContent = String(days.length);
  $("digestDays").innerHTML = days.length
    ? days
        .map(
          (day) => `
      <div class="digest-day">
        <div class="digest-day-head">
          <i class="bi bi-calendar-event"></i> ${esc(fmtDay(day.day))}
          <span class="ms-auto">${t("replay.shows", { n: day.count })}</span>
        </div>
        ${day.shows
          .map((show) => {
            const kind = kindOf(show.kind);
            return `<div class="digest-show">
              <span class="tag ${kind.cls}">${kind.label}</span>
              <a href="/replay.html?show=${encodeURIComponent(show.id)}" target="_blank" rel="noreferrer">${esc(show.clock)} · ${esc(show.title)}</a>
              <span class="ms-auto text-secondary">${show.durationSec ? `${Math.round(show.durationSec)}s` : ""}</span>
            </div>`;
          })
          .join("")}
      </div>`,
        )
        .join("")
    : `<p class="muted-note">${t("digest.empty")}</p>`;
}

function renderSaved() {
  const saved = S.saved;
  const text = $("digestText");
  if (saved?.text) {
    text.textContent = saved.text;
    text.classList.remove("muted-note");
    $("digestMeta").textContent = t("digest.savedAt", {
      at: new Date(saved.at).toLocaleString(localeTag()),
      model: saved.model,
      cost: fmtCost(saved.costUsd),
      n: saved.shows,
    });
  } else {
    text.textContent = t("digest.none");
    text.classList.add("muted-note");
    $("digestMeta").textContent = "";
  }
}

async function load(days = S.days) {
  S.days = days;
  $("periodRow").querySelectorAll("[data-days]").forEach((button) => button.classList.toggle("active", Number(button.dataset.days) === days));
  try {
    const data = await api.digest(days);
    S.digest = data;
    S.saved = data.saved ?? null;
    renderStats();
    renderRank("digestTopics", data.topics ?? [], t("digest.noTopic"));
    renderRank("digestSources", data.sources ?? [], t("digest.noMedia"));
    renderDays();
    renderSaved();
  } catch (err) {
    toast(err.message, "danger");
  }
}

async function generate() {
  const button = $("generateBtn");
  button.disabled = true;
  button.innerHTML = `<span class="spinner-border spinner-border-sm"></span> ${esc(t("digest.generating"))}`;
  try {
    const res = await api.generateDigest(S.days);
    S.digest = res.digest;
    S.saved = { at: res.savedAt, days: S.days, text: res.text, model: res.model, costUsd: res.costUsd, shows: res.digest.totals.shows };
    renderStats();
    renderSaved();
    toast(t("digest.generated", { n: res.digest.totals.shows }));
  } catch (err) {
    toast(err.message, "danger");
  } finally {
    button.disabled = false;
    button.innerHTML = `<i class="bi bi-stars"></i> ${esc(t("digest.generate"))}`;
  }
}

async function copyText() {
  const text = S.saved?.text;
  if (!text) {
    toast(t("digest.copyNothing"), "danger");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(t("digest.copied"));
  } catch {
    toast(t("digest.copyFailed"), "danger");
  }
}

/** Redessine toute la page : appelé au boot et à chaque changement de langue. */
function renderAll() {
  if (!S.digest) return;
  renderStats();
  renderRank("digestTopics", S.digest.topics ?? [], t("digest.noTopic"));
  renderRank("digestSources", S.digest.sources ?? [], t("digest.noMedia"));
  renderDays();
  renderSaved();
}

function wire() {
  $("periodRow").addEventListener("click", (event) => {
    const button = event.target.closest("[data-days]");
    if (button) void load(Number(button.dataset.days));
  });
  $("generateBtn").addEventListener("click", () => void generate());
  $("copyBtn").addEventListener("click", () => void copyText());
}

async function boot() {
  const { locale } = await api.locale().catch(() => ({ locale: "fr" }));
  setLocale(locale);
  applyI18n(document);
  wire();
  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.classList.toggle("active", button.dataset.lang === locale);
    button.addEventListener("click", async () => {
      const next = button.dataset.lang;
      if (next === getLocale()) return;
      await api.saveSettings({ locale: next }).catch(() => {});
      setLocale(next);
      applyI18n(document);
      document.querySelectorAll("[data-lang]").forEach((other) => other.classList.toggle("active", other.dataset.lang === next));
      renderAll();
    });
  });
  await load(7);
}

void boot();
