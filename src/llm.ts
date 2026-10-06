/**
 * Prompting layer: turns raw news items into a spoken two-host radio dialogue,
 * and answers listener questions from freshly fetched sources.
 */
import { CHARS_PER_SECOND, isFrontPage, LOCALES, themeFor, WORDS_PER_SECOND, type Host, type Listener, type Locale } from "./config";
import type { NewsItem } from "./news";

export interface ScriptTurn {
  speakerIndex: number;
  name: string;
  text: string;
}

export interface ScriptPlan {
  title: string;
  turns: ScriptTurn[];
  usedSources: number[];
}

export const joinTurns = (turns: ScriptTurn[]): string => turns.map((t) => t.text).join(" ").trim();

/** Strips anything that should never be read aloud. */
export function normalizeSpoken(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[[^\]]{0,60}\]/g, " ")
    .replace(/\*\*|__|\*|`|#+\s?/g, "")
    .replace(/^\s*[-•>]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ")
    .replace(/\s*[-–—]+\s*$/gm, ".")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .replace(/\n/g, " ")
    .trim();
}

/** Lenient JSON reader: models sometimes wrap JSON in prose or fences. */
export function extractJson(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export function wordBudget(cadenceSec: number): number {
  return Math.min(700, Math.max(45, Math.round(cadenceSec * WORDS_PER_SECOND)));
}

const deaccent = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/**
 * Une ligne de prompt dans les deux langues. Tout ce que le modèle lit passe par
 * ici : une consigne restée en français quand l'émission est anglaise produisait
 * notamment des requêtes de recherche en français, qui ramenaient des articles
 * hors sujet sur une radio anglophone.
 */
const say = (locale: Locale, fr: string, en: string): string => (locale === "fr" ? fr : en);

/** Which host is speaking, from the name the model returned. */
function speakerIndexFor(name: unknown, hosts: Host[]): number | null {
  if (typeof name !== "string") return null;
  const wanted = deaccent(name.trim());
  if (!wanted) return null;
  const index = hosts.findIndex((host) => deaccent(host.name) === wanted || deaccent(host.name.split(" ")[0]) === wanted);
  return index >= 0 ? index : null;
}

/** Merges consecutive replies from the same host: fewer synthesis calls. */
export function mergeTurns(turns: ScriptTurn[]): ScriptTurn[] {
  const merged: ScriptTurn[] = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.speakerIndex === turn.speakerIndex) last.text = `${last.text} ${turn.text}`.trim();
    else merged.push({ ...turn });
  }
  return merged;
}

/**
 * Builds the spoken plan from the model answer. Handles both the duo format
 * (`turns`) and a flat `script`, which is then split between the hosts.
 */
export function planFromModel(text: string, sourceCount: number, hosts: Host[], duo: boolean): ScriptPlan {
  const parsed = extractJson(text) ?? {};
  const used = Array.isArray(parsed.usedSources)
    ? [...new Set(parsed.usedSources.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= sourceCount))]
    : [];
  const title = typeof parsed.title === "string" ? normalizeSpoken(parsed.title).slice(0, 90) : "";
  const rawTurns = Array.isArray(parsed.turns) ? parsed.turns : [];

  let turns: ScriptTurn[] = [];
  if (rawTurns.length) {
    rawTurns.forEach((raw, index) => {
      const entry = raw as Record<string, unknown>;
      const text = normalizeSpoken(typeof entry.text === "string" ? entry.text : typeof entry.content === "string" ? entry.content : "");
      if (!text) return;
      const found = speakerIndexFor(entry.speaker ?? entry.name, hosts);
      const speakerIndex = duo ? found ?? index % 2 : 0;
      turns.push({ speakerIndex, name: hosts[speakerIndex]?.name ?? `Voix ${speakerIndex + 1}`, text });
    });
  } else {
    const fallback = normalizeSpoken(typeof parsed.script === "string" ? parsed.script : typeof parsed.text === "string" ? parsed.text : text);
    turns = splitScriptBetweenHosts(fallback, hosts, duo);
  }
  if (!turns.length) turns = splitScriptBetweenHosts(normalizeSpoken(text), hosts, duo);
  return { title, turns: enforceDuo(mergeTurns(turns), hosts, duo), usedSources: used };
}

/**
 * Filet de sécurité : quoi qu'ait répondu le modèle, en mode duo le bulletin doit
 * s'entendre à deux voix. Si tout est sorti sur une seule voix, on redistribue
 * les répliques en alternance ; une réplique unique est découpée par phrases.
 */
export function enforceDuo(turns: ScriptTurn[], hosts: Host[], duo: boolean): ScriptTurn[] {
  if (!duo || hosts.length < 2 || !turns.length) return turns;
  if (turns.length === 1) return mergeTurns(splitScriptBetweenHosts(turns[0].text, hosts, true));
  const distinct = new Set(turns.map((turn) => turn.speakerIndex)).size;
  if (distinct > 1) return turns;
  return turns.map((turn, index) => ({
    speakerIndex: index % 2,
    name: hosts[index % 2]?.name ?? turn.name,
    text: turn.text,
  }));
}

/** Splits a monologue into alternating replies, by sentence. */
export function splitScriptBetweenHosts(script: string, hosts: Host[], duo: boolean): ScriptTurn[] {
  const sentences = script.match(/[^.!?…]+[.!?…]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (!sentences.length) return [];
  if (!duo) return [{ speakerIndex: 0, name: hosts[0]?.name ?? "Voix 1", text: sentences.join(" ") }];
  // Two sentences per reply reads better than strict alternation.
  const turns: ScriptTurn[] = [];
  sentences.forEach((sentence, index) => {
    const speakerIndex = Math.floor(index / 2) % 2;
    const last = turns[turns.length - 1];
    if (last && last.speakerIndex === speakerIndex) last.text = `${last.text} ${sentence}`;
    else turns.push({ speakerIndex, name: hosts[speakerIndex]?.name ?? `Voix ${speakerIndex + 1}`, text: sentence });
  });
  return turns;
}

/**
 * Cuts on a sentence boundary when there is one inside the budget, otherwise on
 * a clause boundary. Fragments too short to be worth reading are dropped.
 */
export function cutAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars);
  const lastStop = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (lastStop > maxChars * 0.5) return window.slice(0, lastStop + 1).trim();
  const lastClause = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" : "));
  if (lastClause > maxChars * 0.55) return window.slice(0, lastClause + 1).trim();
  const lastSpace = window.lastIndexOf(" ");
  const fragment = (lastSpace > 0 ? window.slice(0, lastSpace) : window).trim();
  return fragment.length > 60 ? fragment : "";
}

/** Headline as it should be spoken: no emoji, no trailing "— publisher". */
export function cleanHeadline(item: NewsItem): string {
  let title = normalizeSpoken(item.title);
  const suffixes = [item.source, item.feed, new URL(item.url).hostname.replace(/^www\./, "")].filter(Boolean);
  for (const suffix of suffixes) {
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title.replace(new RegExp(`\\s*[-–—|]\\s*${escaped}\\s*$`, "i"), "").trim();
  }
  return title.replace(/\s*[-–—|]\s*$/, "").trim() || normalizeSpoken(item.title);
}

function formatSources(items: NewsItem[], locale: Locale, withBody: boolean): string {
  const dateFmt = new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", { dateStyle: "short", timeStyle: "short" });
  return items
    .map((item, index) => {
      const when = item.publishedAt ? dateFmt.format(new Date(item.publishedAt)) : say(locale, "date inconnue", "date unknown");
      const body = withBody && item.body ? `\n   ${say(locale, "Extrait", "Excerpt")}: ${item.body.slice(0, 900)}` : "";
      // La mention « couvert par N médias » indique l'importance du sujet ; elle ne se lit pas.
      const coverage = item.dupes && item.dupes > 1 ? say(locale, ` · sujet couvert par ${item.dupes} médias`, ` · story covered by ${item.dupes} outlets`) : "";
      const empty = say(locale, "(aucun)", "(none)");
      return `[${index + 1}] ${item.title} — ${item.source} (${when}, via ${item.feed})${coverage}\n   ${say(locale, "Résumé", "Summary")}: ${item.summary.slice(0, 280) || empty}${body}`;
    })
    .join("\n");
}

/** Indice sur le moment de la journée : la salutation s'y adapte, l'heure ne se dit pas. */
function clockLine(locale: Locale): string {
  const hour = new Date().getHours();
  const moment =
    hour < 6 ? (locale === "fr" ? "tôt le matin" : "early morning")
      : hour < 12 ? (locale === "fr" ? "le matin" : "morning")
        : hour < 18 ? (locale === "fr" ? "l'après-midi" : "afternoon")
          : (locale === "fr" ? "la soirée" : "evening");
  return locale === "fr"
    ? `Il est ${moment} : adapte la salutation, mais n'annonce NI l'heure NI la date à l'antenne.`
    : `It is ${moment}: match the greeting, but do not announce the time or the date on air.`;
}

function castLine(hosts: Host[], duo: boolean, locale: Locale, listener: Listener, tutoiement: boolean): string {
  const audience = locale === "fr"
    ? [
        `Vous vous adressez à ${listener.name}, l'auditeur qui écoute et qui écrit ses questions. Profil : ${listener.persona}`,
        tutoiement
          ? `RÈGLE ABSOLUE : vous le TUTOYEZ (\u00ab tu \u00bb, \u00ab ton \u00bb, \u00ab toi \u00bb) du début à la fin. Aucun vouvoiement, jamais \u00ab vous \u00bb ni \u00ab votre \u00bb pour parler de lui, et pas de formule impersonnelle pour l'éviter.`
          : `Vouvoyez-le systématiquement (\u00ab vous \u00bb, \u00ab votre \u00bb).`,
        `Interpelle-le avec parcimonie, en respectant la fréquence éditoriale demandée. Les deux présentateurs peuvent aussi s'interpeller entre eux par leur prénom.`,
      ].join(" ")
    : [
        `The listener you are talking to is called ${listener.name}. Profile: ${listener.persona}.`,
        `Address them directly as "you" and respect the configured frequency of first-name mentions.`,
      ].join(" ");
  if (!duo) {
    return [
      locale === "fr"
        ? `Tu écris pour ${hosts[0].name}, seul(e) à l'antenne. Personnalité : ${hosts[0].persona}`
        : `You write for ${hosts[0].name}, alone on air. Personality: ${hosts[0].persona}`,
      audience,
    ].join("\n");
  }
  const [a, b] = [hosts[0].name, hosts[1].name];
  return [
    locale === "fr"
      ? [
          `Les deux présentateurs :\n- ${a} : ${hosts[0].persona}\n- ${b} : ${hosts[1].persona}`,
          `Tu écris UN SEUL dialogue complet, en une seule réponse JSON : les répliques des deux voix sont déjà entrelacées, comme si on entendait la conversation. N'écris jamais deux monologues séparés ni un seul texte à redistribuer ensuite.`,
          "Règles de répartie, à respecter à la lettre : 1) alterne strictement les voix, jamais deux répliques de suite du même présentateur ; 2) chaque réplique rebondit sur la précédente (reprends un mot, un chiffre ou une idée de l'autre avant d'ajouter ton information) ; 3) les présentateurs s'interpellent par leur prénom 2 à 3 fois par bulletin et se posent de vraies questions ; 4) au moins une fois par information, un échange rapide de 2 à 4 répliques (question → réponse → relance → précision) ; 5) celui qui parle ajoute, nuance, complète ou conteste : il ne répète pas ce que l'autre vient de dire.",
          `Exemple de rythme attendu : « ${a} : … » puis « ${b} : Attends, ${a}, tu vas trop vite — … » puis « ${a} : Tu as raison sur ce point, sauf que … ».`,
          "Respecte la longueur des répliques réglée par l'auditeur ; jamais de longue tirade.",
        ].join("\n")
      : [
          `The two hosts:\n- ${a}: ${hosts[0].persona}\n- ${b}: ${hosts[1].persona}`,
          `You write ONE complete dialogue in a single JSON answer: both voices are already interleaved, like a conversation being heard. Never two separate monologues, and never a single block of text to be split later.`,
          `Banter rules, to the letter: 1) strictly alternate the voices, never two replies in a row from the same host; 2) every reply bounces off the previous one (pick up a word, a number or an idea from the other host before adding your point); 3) the hosts call each other by first name 2-3 times per bulletin and genuinely ask each other questions; 4) at least once per story, a quick 2-4 reply exchange (question → answer → follow-up → detail); 5) whoever speaks adds, nuances, completes or pushes back: never repeat what the other just said.`,
          `Expected rhythm: "${a}: …" then "${b}: Hold on, ${a}, you're going too fast — …" then "${a}: Fair point, except …".`,
          "Each reply is 1 to 3 spoken sentences; never a long monologue.",
        ].join("\n"),
    audience,
  ].join("\n");
}

function radioSystem(locale: Locale, hosts: Host[], duo: boolean, styleNote: string, listener: Listener, tutoiement: boolean): string {
  return [
    say(
      locale,
      `Tu es le rédacteur d'un flash radio en ${LOCALES[locale].langName}, dans l'esprit d'une matinale d'information.`,
      `You write a news flash for ${LOCALES[locale].langName}, in the spirit of a morning news show.`,
    ),
    castLine(hosts, duo, locale, listener, tutoiement),
    say(
      locale,
      "Les présentateurs parlent à l'auditeur, pas au micro en général : leurs réponses et leurs transitions peuvent l'interpeller directement.",
      "The hosts talk to the listener, not to a generic audience: their answers and links can address them directly.",
    ),
    say(
      locale,
      `Tu écris un texte PARLÉ, destiné à être lu par ${duo ? "deux voix de synthèse" : "une voix de synthèse"} : pas de markdown, pas de listes, pas d'emoji, pas de didascalies, pas de noms suivis de deux-points.`,
      `You write SPOKEN text, meant to be read aloud by ${duo ? "two synthesised voices" : "one synthesised voice"}: no markdown, no lists, no emoji, no stage directions, no names followed by a colon.`,
    ),
    say(
      locale,
      "Chaque réplique doit être autonome et se suffire à elle-même : on ne doit jamais entendre « comme je disais ».",
      "Every reply must stand on its own: never let the audience hear “as I was saying”.",
    ),
    say(
      locale,
      "Tu n'inventes AUCUN fait, chiffre, nom ou citation : tout doit venir des sources fournies, sauf si le mode connaissances générales est explicitement autorisé. Si une information est incertaine, tu le dis ou tu l'omets. En science, distingue les modèles théoriques des observations : par exemple, une singularité n'est pas une densité infinie observée ou démontrée.",
      "You NEVER invent a fact, figure, name or quote: everything must come from the provided sources, unless the general-knowledge mode is explicitly allowed. If something is uncertain, say so or leave it out. In science, tell theoretical models apart from observations: a singularity, for instance, is not an observed or proven infinite density.",
    ),
    say(locale, "Tu ne lis jamais d'URL ni de numéro de source.", "You never read out URLs or source numbers."),
    say(
      locale,
      "Tu ne nommes JAMAIS un média à l'antenne : pas de « selon Le Monde », pas de nom de site, de journal, d'agence ni de chaîne. L'auditeur voit les sources affichées dans l'application, alors on lui raconte les faits, pas l'origine des faits.",
      "You NEVER name a media outlet on air: no “according to Reuters”, no site, paper, agency or channel name. The listener sees the sources in the app, so tell the facts, not where they come from.",
    ),
    say(
      locale,
      "Tu n'annonces NI l'heure NI la date de publication : tu racontes ce qui s'est passé, avec le recul nécessaire, sans horodatage.",
      "You do NOT announce times or publication dates: describe what happened, with the needed context, but never a timestamp.",
    ),
    say(
      locale,
      "Une information ne se répète JAMAIS : chaque sujet est traité une seule fois, en fusionnant ce que disent les articles qui le couvrent, puis on n'y revient plus.",
      "A story is NEVER repeated: each topic is covered exactly once, merging whatever the articles covering it say, then you move on for good.",
    ),
    styleNote ? say(locale, `Consigne de style : ${styleNote}`, `Style note: ${styleNote}`) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function jsonInstruction(sourceCount: number, hosts: Host[], duo: boolean, locale: Locale): string {
  const names = duo
    ? say(locale, `"${hosts[0].name}" ou "${hosts[1].name}"`, `"${hosts[0].name}" or "${hosts[1].name}"`)
    : `"${hosts[0].name}"`;
  const example = duo
    ? `"turns": [{"speaker": "${hosts[0].name}", "text": "…"}, {"speaker": "${hosts[1].name}", "text": "…"}]`
    : `"turns": [{"speaker": "${hosts[0].name}", "text": "…"}]`;
  return [
    say(locale, "Réponds STRICTEMENT en JSON (aucun texte autour) avec ce schéma :", "Answer STRICTLY in JSON (nothing around it) using this schema:"),
    say(locale, `{"title": "titre court du bulletin", ${example}, "usedSources": [1,3]}`, `{"title": "short bulletin title", ${example}, "usedSources": [1,3]}`),
    say(
      locale,
      `"speaker" doit valoir exactement ${names}. "usedSources" contient les numéros [1..${sourceCount}] des sources réellement utilisées, les plus pertinentes d'abord.`,
      `"speaker" must be exactly ${names}. "usedSources" holds the numbers [1..${sourceCount}] of the sources you actually used, most relevant first.`,
    ),
    say(locale, "Le texte parlé ne mentionne pas les numéros de sources à haute voix.", "The spoken text must not read source numbers aloud."),
  ].join("\n");
}

/** Même JSON imposé, mais sans aucune source à citer (débat ou réponse de mémoire). */
function emptyJsonRule(hosts: Host[], duo: boolean, locale: Locale, what: string): string {
  const names = duo
    ? say(locale, `"${hosts[0].name}" ou "${hosts[1].name}"`, `"${hosts[0].name}" or "${hosts[1].name}"`)
    : `"${hosts[0].name}"`;
  const example = duo
    ? `"turns": [{"speaker": "${hosts[0].name}", "text": "…"}, {"speaker": "${hosts[1].name}", "text": "…"}]`
    : `"turns": [{"speaker": "${hosts[0].name}", "text": "…"}]`;
  return [
    say(locale, `Réponds STRICTEMENT en JSON (aucun texte autour) : {"title": "${what}", ${example}, "usedSources": []}.`, `Answer STRICTLY in JSON (nothing around it): {"title": "${what}", ${example}, "usedSources": []}.`),
    say(
      locale,
      `"speaker" doit valoir exactement ${names}. "usedSources" reste le tableau vide : aucune source n'existe.`,
      `"speaker" must be exactly ${names}. "usedSources" stays empty: there is no source.`,
    ),
  ].join(" ");
}

function topicLine(topic: string, locale: Locale): string {
  if (isFrontPage(topic)) {
    return locale === "fr" ? "Sujet : l'essentiel de l'actualité du moment (toutes rubriques)." : "Topic: today's main headlines (all sections).";
  }
  const theme = themeFor(topic);
  const scope = theme ? ` (rubrique « ${theme.group} »)` : "";
  return locale === "fr" ? `Sujet du bulletin : ${topic}${scope}.` : `Bulletin topic: ${topic}${scope}.`;
}

export function bulletinPrompt(opts: {
  items: NewsItem[];
  locale: Locale;
  topic: string;
  hosts: Host[];
  duo: boolean;
  listener: Listener;
  tutoiement: boolean;
  cadenceSec: number;
  maxSources: number;
  styleNote: string;
  /** Toutes les sources ci-dessous sont déjà passées à l'antenne aujourd'hui. */
  recycledCount?: number;
}): { system: string; user: string } {
  const budget = wordBudget(opts.cadenceSec);
  const user = [
    topicLine(opts.topic, opts.locale),
    clockLine(opts.locale),
    say(
      opts.locale,
      `Durée cible à l'antenne : ${opts.cadenceSec} secondes, soit environ ${budget} mots au total pour l'ensemble des répliques (reste entre ${Math.round(budget * 0.8)} et ${Math.round(budget * 1.15)} mots).`,
      `Target length on air: ${opts.cadenceSec} seconds, so about ${budget} words in total across every reply (stay between ${Math.round(budget * 0.8)} and ${Math.round(budget * 1.15)} words).`,
    ),
    say(
      opts.locale,
      `Structure : une ouverture courte, puis un résumé continu de l'essentiel — ${opts.maxSources} sujets au maximum, développés ${opts.duo ? "par les deux voix" : "par la voix à l'antenne"}, une transition avant chaque nouveau sujet, et une brève conclusion.`,
      `Structure: a short opening, then a continuous summary of what matters — at most ${opts.maxSources} topics, covered ${opts.duo ? "by both voices" : "by the voice on air"}, a transition before each new topic, and a brief conclusion.`,
    ),
    opts.locale === "fr"
      ? "Résume au lieu de dérouler : tu retiens les faits et les chiffres importants, tu ne cites pas les articles les uns après les autres. Si plusieurs articles racontent la même histoire, tu la racontes UNE fois en gardant les détails les plus précis — jamais deux passages sur le même sujet. Ignore les doublons, les brèves sans information et les sujets purement locaux sans intérêt."
      : "Summarise instead of listing: keep the important facts and numbers, do not walk through the articles one by one. If several articles tell the same story, tell it ONCE with the most precise details — never two passes on the same topic. Drop duplicates, empty briefs and trivial local items.",
    say(opts.locale, `Voici les sources disponibles (${opts.items.length}) :`, `Here are the available sources (${opts.items.length}):`),
    formatSources(opts.items, opts.locale, true),
    opts.duo
      ? opts.locale === "fr"
        ? `Format dialogue obligatoire : ${opts.hosts[0].name} ouvre puis les deux voix se renvoient la parole information par information — chacun lance ou commente, réagit à la réplique précédente, et jamais deux répliques d'affilée ne viennent de la même personne.`
        : `Mandatory dialogue format: ${opts.hosts[0].name} opens, then the two voices hand the story back and forth item by item — one introduces or comments, the other reacts to the previous line, and never two replies in a row come from the same person.`
      : "",
    opts.recycledCount
      ? opts.locale === "fr"
        ? `Attention : ces ${opts.recycledCount} sujets ont DÉJÀ été diffusés dans un bulletin précédent aujourd'hui. Ne les présente jamais comme du neuf : soit tu apportes un élément réellement nouveau (chiffre, réaction, conséquence) en le signalant sobrement (« depuis notre dernier point »), soit tu enchaînes dessus en quelques secondes sans t'y attarder. Un bulletin court et vraiment neuf vaut mieux qu'un long résumé déjà entendu.`
        : `Careful: these ${opts.recycledCount} stories ALREADY aired in an earlier bulletin today. Never present them as new: either add something genuinely new (figure, reaction, consequence) and say so soberly, or move on in a few seconds. A short, genuinely fresh bulletin beats a long recap.`
      : "",
    jsonInstruction(opts.items.length, opts.hosts, opts.duo, opts.locale),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: radioSystem(opts.locale, opts.hosts, opts.duo, opts.styleNote, opts.listener, opts.tutoiement), user };
}

export function queryPrompt(question: string, locale: Locale): { system: string; user: string } {
  return {
    system: say(
      locale,
      `Tu transformes une question d'auditeur en requête de recherche d'actualités. Réponds uniquement par la requête, sans ponctuation finale, sans guillemets, en ${LOCALES[locale].langName}, 1 à 8 mots-clés.`,
      `You turn a listener question into a news search query. Answer with the query only, no trailing punctuation, no quotes, in ${LOCALES[locale].langName}, 1 to 8 keywords.`,
    ),
    user: say(
      locale,
      `Question: ${question}\n\nAjoute si utile un mot-clé d'actualité récent. Réponse (requête seule):`,
      `Question: ${question}\n\nAdd a recent news keyword if useful. Answer (query only):`,
    ),
  };
}

export function answerPrompt(opts: {
  question: string;
  items: NewsItem[];
  locale: Locale;
  hosts: Host[];
  duo: boolean;
  listener: Listener;
  tutoiement: boolean;
  cadenceSec: number;
  styleNote: string;
  /** Autorise le modèle à compléter de mémoire si les sources ne répondent pas. */
  knowledgeFallback?: boolean;
}): { system: string; user: string } {
  const budget = Math.min(wordBudget(opts.cadenceSec), 230);
  const whoAsks = opts.duo
    ? say(opts.locale, `${opts.hosts[1].name} pose la question à ${opts.hosts[0].name}`, `${opts.hosts[1].name} puts the question to ${opts.hosts[0].name}`)
    : say(opts.locale, `${opts.hosts[0].name} répond`, `${opts.hosts[0].name} answers`);
  const user = [
    say(opts.locale, `${opts.listener.name} vient d'écrire à l'antenne : « ${opts.question} »`, `${opts.listener.name} just wrote to the station: "${opts.question}"`),
    opts.locale === "fr"
      ? `À l'antenne, ${whoAsks}, en s'adressant directement à ${opts.listener.name} ${opts.tutoiement ? "en le tutoyant (\u00ab tu \u00bb)" : "en le vouvoyant (\u00ab vous \u00bb)"}. Reformule la question en une réplique courte, puis répondez en ${budget} mots maximum au total. Termine par une phrase qui lui est adressée.`
      : `On air, ${whoAsks}, speaking directly to ${opts.listener.name}. Restate the question in one short reply, then answer in at most ${budget} words overall, ending with a sentence aimed at them.`,
    clockLine(opts.locale),
    say(
      opts.locale,
      "Appuyez-vous d'abord sur les sources ci-dessous. Si elles ne permettent pas de répondre, dites-le honnêtement et donnez l'information la plus proche disponible.",
      "Lean on the sources below first. If they do not answer the question, say so honestly and give the closest information available.",
    ),
    opts.knowledgeFallback
      ? opts.locale === "fr"
        ? "Si les sources sont hors sujet ou trop générales, complétez avec vos connaissances générales : commencez par dire clairement que vous répondez de mémoire (par exemple « les dépêches ne répondent pas vraiment, alors je te réponds de mémoire »), puis restez factuel et prudent : aucun chiffre précis, aucune date ni citation inventés, et signalez ce qui peut avoir changé depuis."
        : "If the sources are off-topic or too thin, complete with your general knowledge: first say clearly that you are answering from memory, then stay factual and careful: no invented numbers, dates or quotes, and flag what may have changed."
      : "",
    say(opts.locale, `Sources (${opts.items.length}) :`, `Sources (${opts.items.length}):`),
    formatSources(opts.items, opts.locale, true),
    jsonInstruction(opts.items.length, opts.hosts, opts.duo, opts.locale),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: radioSystem(opts.locale, opts.hosts, opts.duo, opts.styleNote, opts.listener, opts.tutoiement), user };
}

/**
 * Débat contradictoire : deux positions assumées, l'auditeur en modérateur.
 * Les rôles sont tirés du sujet par le modèle lui-même, et les faits restent
 * bornés (sources, ou mémoire annoncée quand il n'y en a pas).
 */
export function debatePrompt(opts: {
  topic: string;
  question?: string;
  items: NewsItem[];
  locale: Locale;
  hosts: Host[];
  listener: Listener;
  tutoiement: boolean;
  cadenceSec: number;
  styleNote: string;
  /** Aucune dépêche : les deux voix débattent de mémoire. */
  knowledge: boolean;
}): { system: string; user: string } {
  const budget = wordBudget(opts.cadenceSec);
  const [first, second] = [opts.hosts[0].name, opts.hosts[1]?.name ?? opts.hosts[0].name];
  const subject = opts.question
    ? say(opts.locale, `la question de ${opts.listener.name} : « ${opts.question} »`, `${opts.listener.name}'s question: "${opts.question}"`)
    : say(opts.locale, `le sujet « ${opts.topic} »`, `the topic "${opts.topic}"`);
  const names = say(opts.locale, `"${first}" ou "${second}"`, `"${first}" or "${second}"`);
  const example = `{"speaker": "${first}", "text": "…"}, {"speaker": "${second}", "text": "…"}`;
  const jsonRule = opts.knowledge
    ? [
        say(opts.locale, `Réponds STRICTEMENT en JSON (aucun texte autour) : {"title": "titre court du débat", "turns": [${example}], "usedSources": []}.`, `Answer STRICTLY in JSON (nothing around it): {"title": "short debate title", "turns": [${example}], "usedSources": []}.`),
        say(opts.locale, `"speaker" doit valoir exactement ${names}. "usedSources" reste vide : aucune source.`, `"speaker" must be exactly ${names}. "usedSources" stays empty: there is no source.`),
      ].join(" ")
    : jsonInstruction(opts.items.length, opts.hosts, true, opts.locale);
  const user = [
    opts.locale === "fr" ? `À l'antenne : un DÉBAT CONTRADICTOIRE sur ${subject}.` : `On air: a head-to-head DEBATE about ${subject}.`,
    opts.locale === "fr"
      ? [
          `Le principe : ${first} défend une position, ${second} défend la position inverse. Choisis toi-même les deux positions les plus intéressantes et les plus défendables sur ce sujet, annonce-les chacune en une phrase au début du débat, puis tiens-les jusqu'au bout sans changer de camp.`,
          `${opts.listener.name} est le modérateur : c'est sa question qui ouvre le débat, et c'est à lui que la conclusion s'adresse.`,
          "Règles du débat : 1) alternance stricte des deux voix, jamais deux répliques de suite ; 2) chaque réplique répond précisément à la précédente (reprends son argument avant de le contrer) ; 3) arguments factuels seulement — appuie-toi sur les sources quand il y en a, sinon sur ce que tu sais de solide : n'invente ni chiffre, ni date, ni citation ; 4) aucune caricature ni mauvaise foi : chacun concède un point valable quand l'autre en marque un ; 5) pas de vainqueur proclamé, on reste courtois et serré.",
          `Structure : une ouverture qui pose le débat et reformule la question de ${opts.listener.name}, 6 à 10 échanges courts, puis une phrase de conclusion pour chacun, adressée à ${opts.listener.name}.`,
          `Longueur : ${budget} mots maximum au total pour l'ensemble des répliques.`,
        ].join(" ")
      : [
          `The setup: ${first} argues one position, ${second} argues the opposite. Pick the two most interesting, most defensible positions on the subject yourself, state each in one sentence at the start, then hold your side throughout.`,
          `${opts.listener.name} moderates: their question opens the debate, and the conclusion is addressed to them.`,
          "Debate rules: 1) strictly alternate the two voices; 2) every reply answers the previous one precisely (restate the argument before countering it); 3) factual arguments only — use the sources when there are any, otherwise solid knowledge: never invent figures, dates or quotes; 4) no caricature, no bad faith: each side concedes a fair point when the other earns it; 5) no declared winner, stay courteous and tight.",
          `Structure: an opening that frames the debate and restates ${opts.listener.name}'s question, 6 to 10 short exchanges, then one closing sentence each addressed to them.`,
          `Length: at most ${budget} words overall.`,
        ].join(" "),
    opts.knowledge
      ? opts.locale === "fr"
        ? "Aucune dépêche fraîche n'est disponible : dites-le une fois (les deux voix débattent de mémoire), restez prudents et signalez ce qui a pu changer."
        : "No fresh wire copy is available: say it once (both hosts debate from memory), stay careful and flag what may have changed."
      : "",
    opts.items.length ? say(opts.locale, `Sources (${opts.items.length}) :`, `Sources (${opts.items.length}):`) : "",
    opts.items.length ? formatSources(opts.items, opts.locale, true) : "",
    clockLine(opts.locale),
    opts.locale === "fr"
      ? `Termine par une phrase adressée directement à ${opts.listener.name}${opts.tutoiement ? ", en le tutoyant (« tu »)" : ", en le vouvoyant (« vous »)"}.`
      : `End with a sentence addressed directly to ${opts.listener.name}.`,
    jsonRule,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: radioSystem(opts.locale, opts.hosts, true, opts.styleNote, opts.listener, opts.tutoiement), user };
}

/**
 * Aucune dépêche exploitable : le modèle répond de mémoire. On le dit à l'antenne
 * une fois, et on interdit tout fait précis inventé (chiffres, dates, citations).
 * Sert aux sujets libres et aux questions qui ne sont pas de l'actualité chaude.
 */
export function knowledgePrompt(opts: {
  question?: string;
  topic: string;
  locale: Locale;
  hosts: Host[];
  duo: boolean;
  listener: Listener;
  tutoiement: boolean;
  cadenceSec: number;
  styleNote: string;
}): { system: string; user: string } {
  const budget = Math.min(wordBudget(opts.cadenceSec), 260);
  const jsonRule = emptyJsonRule(opts.hosts, opts.duo, opts.locale, say(opts.locale, "titre court", "short title"));
  const subject = opts.question
    ? say(opts.locale, `la question de ${opts.listener.name} : « ${opts.question} »`, `${opts.listener.name}'s question: "${opts.question}"`)
    : say(opts.locale, `le sujet « ${opts.topic} »`, `the topic "${opts.topic}"`);
  const user = [
    opts.locale === "fr" ? `À l'antenne, on traite ${subject}.` : `On air, we are covering ${subject}.`,
    opts.locale === "fr"
      ? [
          `Aucune dépêche fraîche n'est disponible : tu réponds DE MÉMOIRE, à partir de tes connaissances générales (sciences, histoire, techniques, contexte, ordres de grandeur connus).`,
          `Annonce-le une fois, sans t'excuser longuement : par exemple « On n'a pas de dépêche là-dessus, alors voilà ce que je sais » ou « Je te réponds de mémoire ».`,
          `N'invente JAMAIS un fait précis, une date, un chiffre ou une citation : reste sur ce que tu sais de solide, dis comment on peut vérifier, et signale ce qui a pu changer depuis. Si tu ne sais pas, dis-le.`,
          `Reste utile et concret : définition, mécanisme, exemple, et ce qu'il faut regarder pour aller plus loin.`,
          `Longueur : ${budget} mots maximum au total pour l'ensemble des répliques.`,
        ].join(" ")
      : `No fresh news is available: answer FROM MEMORY, from your general knowledge. Say it once, without long apologies ("We have no wire copy on this, so here is what I know"). Never invent precise facts, dates, numbers or quotes: stick to solid knowledge, explain how to verify it, and flag what may have changed. Stay concrete and useful. Maximum ${budget} words overall.`,
    clockLine(opts.locale),
    opts.locale === "fr"
      ? `Termine par une phrase adressée directement à ${opts.listener.name}${opts.tutoiement ? ", en le tutoyant (« tu »)" : ", en le vouvoyant (« vous »)"}.`
      : `End with a sentence addressed directly to ${opts.listener.name}.`,
    jsonRule,
  ].join("\n\n");
  return { system: radioSystem(opts.locale, opts.hosts, opts.duo, opts.styleNote, opts.listener, opts.tutoiement), user };
}

/** Reads the raw question back when there is no LLM available. */
export function fallbackQuestionQuery(question: string): string {
  return (
    question
      .replace(/[?!.]/g, " ")
      .replace(/^(est-ce que|qu'est-ce que|quoi|comment|pourquoi|qui|quand|où|combien|en est|il en est|où en est)\s+/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90) || question.slice(0, 90)
  );
}

/**
 * No-LLM mode: the two hosts read the headlines (and their snippets) verbatim,
 * alternating on each item. Keeps the app fully usable without an OpenRouter key.
 */
export function fallbackDialogue(opts: {
  items: NewsItem[];
  topic: string;
  question?: string;
  maxSources: number;
  locale: Locale;
  hosts: Host[];
  duo: boolean;
  cadenceSec: number;
}): ScriptPlan {
  const { items, topic, question, maxSources, locale, hosts, duo } = opts;
  const isFr = locale === "fr";
  const picked = items.slice(0, Math.max(1, maxSources));
  const perItemChars = Math.max(90, Math.round((opts.cadenceSec * CHARS_PER_SECOND) / picked.length) - 40);
  const turns: ScriptTurn[] = [];
  const push = (speakerIndex: number, text: string) => {
    const index = duo ? speakerIndex % 2 : 0;
    turns.push({ speakerIndex: index, name: hosts[index]?.name ?? `Voix ${index + 1}`, text: text.trim() });
  };

  if (question) {
    push(1, isFr ? `${hosts[0].name}, un auditeur demande : « ${question} »` : `${hosts[0].name}, a listener asks: "${question}"`);
    push(0, isFr ? `Voici ce que disent les titres que nous avons trouvés.` : `Here is what the headlines we found say.`);
  } else {
    push(0, isFr
      ? `Bonjour${isFrontPage(topic) ? "" : `, on fait le point sur ${topic}`} : voici l'essentiel de l'actualité en ${picked.length} titres.`
      : `Hello${isFrontPage(topic) ? "" : `, we're looking at ${topic}`} — here are the ${picked.length} stories we found.`);
  }

  picked.forEach((item, index) => {
    const headline = cleanHeadline(item);
    const summary = cutAtSentence(normalizeSpoken(item.summary), Math.max(60, perItemChars - headline.length));
    const sameSource = index > 0 && picked[index - 1].source === item.source;
    // Pas de nom de média ni d'heure : l'auditeur lit les sources dans l'app.
    const lead = isFr
      ? `${index === 0 ? "On commence avec" : sameSource ? "Dans la même veine," : "Autre sujet,"} ${headline}.`
      : `${index === 0 ? "We start with" : sameSource ? "Along the same lines," : "Next up,"} ${headline}.`;
    const tail = summary && !deaccent(headline).includes(deaccent(summary).slice(0, 28)) ? ` ${summary}` : "";
    // Sans LLM, la seconde voix réagit quand même à ce qui vient d'être dit.
    const reaction = duo && (index + (question ? 1 : 0)) % 2 === 1 && index > 0
      ? isFr ? ["D'accord.", "Intéressant.", "Ah, tiens.", "Bon à savoir."][index % 4] + " " : ["Right.", "Interesting.", "Oh, good to know.", "Noted."][index % 4] + " "
      : "";
    push(index + (question ? 1 : 0), `${reaction}${lead}${tail}`);
  });

  push(0, isFr
    ? "Ce bulletin est monté sans modèle de langage, uniquement à partir des titres reçus."
    : "This bulletin was assembled without a language model, straight from the headlines.");
  return {
    title: question ? (isFr ? `Question — ${question.slice(0, 60)}` : `Question — ${question.slice(0, 60)}`) : isFr ? `Titres — ${topic}` : `Headlines — ${topic}`,
    turns: mergeTurns(turns),
    usedSources: picked.map((_, i) => i + 1),
  };
}
