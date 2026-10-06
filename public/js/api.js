/** Thin wrapper around the JSON API. */

async function parse(res) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Erreur ${res.status}`);
    err.status = res.status;
    err.detail = data?.detail;
    throw err;
  }
  return data;
}

const json = (path, init) => fetch(path, init).then(parse);

const post = (path, body, signal) =>
  json(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal,
  });

export const api = {
  state: () => json("/api/state"),
  locale: () => json("/api/locale"),
  models: (kind, q = "", force = false) =>
    json(`/api/models?kind=${kind}&q=${encodeURIComponent(q)}${force ? "&force=1" : ""}`),
  saveSettings: (patch) => post("/api/settings", patch),
  checkKey: (key) => post("/api/settings/check", { key }),
  voices: (locale, force = false) => json(`/api/voices?locale=${locale}${force ? "&force=1" : ""}`),
  plan: (body, signal) => post("/api/segment/plan", body, signal),
  render: (id, signal) => post("/api/segment/render", { id }, signal),
  played: (id, chars, complete) => post("/api/segment/played", { id, chars, complete }),
  compare: (text, candidates, audio, signal) => post("/api/tts/compare", { text, candidates, audio }, signal),
  preview: async (text) => {
    const res = await fetch("/api/tts/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Erreur ${res.status}`);
    return URL.createObjectURL(await res.blob());
  },
  reset: () => post("/api/reset", {}),
  digest: (days) => json(`/api/digest?days=${encodeURIComponent(days)}`),
  generateDigest: (days, signal) => post("/api/digest", { days }, signal),
  clearMemory: () => json("/api/memory", { method: "DELETE" }),
  forgetStory: (title, at) =>
    json(`/api/memory/story?title=${encodeURIComponent(title)}&at=${encodeURIComponent(at)}`, { method: "DELETE" }),
  shows: (day) => json(`/api/shows${day ? `?day=${encodeURIComponent(day)}` : ""}`),
  deleteShow: (day, file) => json(`/api/shows/${encodeURIComponent(day)}/${encodeURIComponent(file)}`, { method: "DELETE" }),
  saveTemplate: (body) => post("/api/templates", body),
  deleteTemplate: (id) => json(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" }),
  importTeam: (body) => post("/api/team/import", body),
};
