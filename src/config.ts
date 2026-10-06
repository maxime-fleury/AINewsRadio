/**
 * Static configuration: locales, RSS feed presets, theme catalogue, host defaults
 * and defaults for everything the settings panel can change.
 */
import { dirname, join } from "node:path";

export const APP_NAME = "AI News Radio";
export const PORT_RANGE = [3000, 3600] as const;

/**
 * Racine du projet (le dossier qui contient src/, public/, shows/). Les données
 * restent ici même si le serveur est lancé depuis un autre dossier : sans ça,
 * `.data` et `shows` se dispersaient au gré du dossier courant.
 */
export const PROJECT_ROOT = dirname(import.meta.dir);

/** Réglages, catalogue de modèles, compteurs cumulés. */
export const DATA_DIR = join(PROJECT_ROOT, ".data");

export type Locale = "fr" | "en";

export interface FeedPreset {
  id: string;
  label: string;
  url: string;
  lang: Locale;
  topic: string;
}

/** Verified live feeds (checked over the wire before being hard-coded here). */
export const FEED_PRESETS: FeedPreset[] = [
  { id: "lemonde", label: "Le Monde — Une", url: "https://www.lemonde.fr/rss/une.xml", lang: "fr", topic: "général" },
  { id: "france24", label: "France 24", url: "https://www.france24.com/fr/rss", lang: "fr", topic: "monde" },
  { id: "francetvinfo", label: "France Info", url: "https://www.francetvinfo.fr/titres.rss", lang: "fr", topic: "général" },
  { id: "lefigaro", label: "Le Figaro — Actu", url: "https://www.lefigaro.fr/rss/figaro_actualites.xml", lang: "fr", topic: "général" },
  { id: "liberation", label: "Libération", url: "https://www.liberation.fr/arc/outboundfeeds/rss/?outputType=xml", lang: "fr", topic: "général" },
  { id: "courrier", label: "Courrier International", url: "https://www.courrierinternational.com/feed/all/rss.xml", lang: "fr", topic: "monde" },
  { id: "numerama", label: "Numerama — Tech", url: "https://www.numerama.com/feed/", lang: "fr", topic: "tech" },
  { id: "bbcworld", label: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", lang: "en", topic: "monde" },
  { id: "theverge", label: "The Verge", url: "https://www.theverge.com/rss/index.xml", lang: "en", topic: "tech" },
  { id: "techcrunch", label: "TechCrunch", url: "https://techcrunch.com/feed/", lang: "en", topic: "tech" },
  { id: "hn", label: "Hacker News", url: "https://hnrss.org/frontpage", lang: "en", topic: "tech" },
];

/* ─────────────────────────── thèmes prédéfinis ─────────────────────────── */

export interface Theme {
  id: string;
  label: string;
  group: string;
  /** Requête envoyée à Google News (vide = uniquement les flux suivis). */
  query: string;
  /** Termes utilisés pour classer les articles par pertinence. */
  keywords: string[];
  /** Anciens libellés reconnus (compatibilité avec les chips déjà enregistrées). */
  aliases?: string[];
}

export const FRONT_PAGE = "À la une";

export const THEME_GROUPS = [
  "Technologie & IA",
  "Actualité France",
  "Monde",
  "Économie",
  "Climat & planète",
  "Santé & épidémies",
  "Risques & fin du monde",
  "Science & espace",
  "Culture & sport",
];

export const THEMES: Theme[] = [
  // Technologie & IA
  {
    id: "ia-tech", label: "IA & tech", group: "Technologie & IA", query: "intelligence artificielle",
    keywords: ["ia", "intelligence artificielle", "openai", "anthropic", "google", "modèle", "algorithme", "tech", "numérique", "puce", "puces", "robot", "start-up", "logiciel", "cloud", "données", "open source"],
    aliases: ["tech & ia", "tech", "ia", "intelligence artificielle"],
  },
  {
    id: "cyber", label: "Cybersécurité & fuites", group: "Technologie & IA", query: "cyberattaque fuite de données",
    keywords: ["cyberattaque", "piratage", "ransomware", "fuite", "violation", "vulnérabilité", "logiciel malveillant", "hacker", "sécurité informatique", "données personnelles", "rgpd"],
    aliases: ["cybersécurité", "cyber"],
  },
  {
    id: "geants", label: "Géants du net & régulation", group: "Technologie & IA", query: "gafam amende régulation numérique",
    keywords: ["apple", "meta", "microsoft", "amazon", "nvidia", "régulation", "amende", "concurrence", "dma", "tiktok", "réseaux sociaux", "plateforme"],
  },
  {
    id: "jeuxvideo", label: "Jeux vidéo", group: "Technologie & IA", query: "jeux vidéo sortie studio",
    keywords: ["jeu vidéo", "jeux vidéo", "studio", "console", "playstation", "xbox", "nintendo", "esport", "éditeur", "sortie"],
  },

  // Actualité France
  {
    id: "france", label: "Actualité France", group: "Actualité France", query: "politique France gouvernement",
    keywords: ["france", "français", "gouvernement", "assemblée", "sénat", "premier ministre", "matignon", "ministre", "loi", "député", "préfecture", "paris", "région", "elysée", "politique"],
    aliases: ["france", "politique francaise", "politique française"],
  },
  {
    id: "social", label: "Social & grèves", group: "Actualité France", query: "grève manifestation salaires",
    keywords: ["grève", "manifestation", "syndicat", "salaire", "retraite", "chômage", "précarité", "pouvoir d'achat", "logement", "hôpital", "grévistes"],
    aliases: ["social", "greves", "grèves"],
  },
  {
    id: "justice", label: "Justice & faits divers", group: "Actualité France", query: "justice procès enquête",
    keywords: ["procès", "tribunal", "enquête", "condamné", "police", "gendarmerie", "jugé", "garde à vue", "crime", "accident", "incendie"],
  },
  {
    id: "elections", label: "Élections", group: "Actualité France", query: "élection candidat scrutin",
    keywords: ["élection", "scrutin", "candidat", "sondage", "vote", "présidentielle", "municipales", "législatives", "campagne", "bulletins", "urnes"],
    aliases: ["election", "élections"],
  },

  // Monde
  {
    id: "monde", label: "Monde", group: "Monde", query: "international actualité",
    keywords: ["international", "monde", "diplomatie", "sommet", "traité", "minorité", "réfugiés", "guerre", "conflit", "frontière", "onu", "pays"],
    aliases: ["monde", "international"],
  },
  {
    id: "europe", label: "Europe", group: "Monde", query: "Union européenne Paris Berlin Bruxelles",
    keywords: ["union européenne", "bruxelles", "commission européenne", "parlement européen", "allemagne", "espagne", "italie", "pologne", "royaume-uni", "otan", "schengen"],
  },
  {
    id: "ukraine", label: "Ukraine & Russie", group: "Monde", query: "Ukraine Russie guerre",
    keywords: ["ukraine", "russie", "kiev", "moscou", "poutine", "zelensky", "missile", "drone", "sanctions", "front", "offensive"],
    aliases: ["ukraine", "guerre en ukraine"],
  },
  {
    id: "moyenorient", label: "Moyen-Orient", group: "Monde", query: "Moyen-Orient Gaza Iran Israël",
    keywords: ["gaza", "israël", "iran", "liban", "hamas", "hezbollah", "tehéran", "palestinien", "trêve", "cisjordanie"],
    aliases: ["moyen-orient", "gaza", "israel"],
  },
  {
    id: "ameriques", label: "Amériques", group: "Monde", query: "États-Unis Brésil Amérique",
    keywords: ["états-unis", "brésil", "argentine", "mexique", "canada", "trump", "maison blanche", "congrès", "lula", "chili", "colombie"],
    aliases: ["ameriques", "amériques", "etats-unis"],
  },
  {
    id: "afrique", label: "Afrique & Asie", group: "Monde", query: "Afrique Chine Inde Asie",
    keywords: ["afrique", "chine", "inde", "japon", "corée", "taïwan", "sahel", "nigeria", "kenya", "pékin", "asie", "océan indien"],
    aliases: ["afrique", "asie"],
  },

  // Économie
  {
    id: "economie", label: "Économie & marchés", group: "Économie", query: "inflation bourse taux croissance",
    keywords: ["inflation", "bourse", "taux", "croissance", "pib", "banque centrale", "bce", "fed", "marchés", "cac 40", "récession", "dette", "budget", "déficit", "euro", "dollar"],
    aliases: ["economie", "économie", "marches", "marchés"],
  },
  {
    id: "emploi", label: "Emploi & entreprises", group: "Économie", query: "emploi entreprise licenciements salaires",
    keywords: ["emploi", "entreprise", "licenciement", "embauche", "usine", "investissement", "fusion", "faillite", "salaire", "industrie", "compétitivité"],
  },
  {
    id: "immobilier", label: "Immobilier & pouvoir d'achat", group: "Économie", query: "immobilier prix logement pouvoir d'achat",
    keywords: ["immobilier", "loyer", "logement", "crédit", "taux d'intérêt", "pouvoir d'achat", "consommation", "prix", "essence", "facture"],
  },

  // Climat & planète
  {
    id: "climat", label: "Climat & énergie", group: "Climat & planète", query: "réchauffement climatique énergie",
    keywords: ["climat", "réchauffement", "énergie", "carbone", "co2", "émissions", "température", "accord de paris", "cop", "transition", "nucléaire", "éolien", "solaire", "gaz", "pétrole"],
    aliases: ["climat & energie", "climat & énergie", "climat", "energie"],
  },
  {
    id: "catastrophes", label: "Catastrophes naturelles", group: "Climat & planète", query: "séisme inondation ouragan incendie",
    keywords: ["séisme", "inondation", "ouragan", "incendie", "fortes chaleurs", "canicule", "sécheresse", "grêle", "tempête", "tsunami", "volcan", "évacuation", "victimes"],
    aliases: ["catastrophes", "catastrophes naturelles"],
  },
  {
    id: "biodiversite", label: "Biodiversité & océans", group: "Climat & planète", query: "biodiversité espèces disparition océans",
    keywords: ["biodiversité", "espèces", "disparition", "océans", "coraux", "pêche", "forêt", "déforestation", "pollution", "plastique", "animaux"],
  },

  // Santé & épidémies
  {
    id: "epidemies", label: "Santé & épidémies", group: "Santé & épidémies", query: "épidémie virus contamination",
    keywords: ["épidémie", "virus", "contamination", "foyer", "cas", "grippe aviaire", "rougeole", "variole", "vaccin", "santé publique", "hôpital", "alerte sanitaire"],
    aliases: ["sante & epidemies", "santé & épidémies", "epidemies", "épidémies", "sante"],
  },
  {
    id: "pandemie", label: "Pandémie & OMS", group: "Santé & épidémies", query: "pandémie OMS coronavirus propagation mondiale",
    keywords: ["pandémie", "oms", "coronavirus", "covid", "propagation", "confinement", "variant", "urgence sanitaire", "mondiale", "décès"],
    aliases: ["pandemie", "pandémie"],
  },
  {
    id: "recherche-medicale", label: "Recherche médicale", group: "Santé & épidémies", query: "étude médicale essai clinique traitement découverte",
    keywords: ["étude", "essai clinique", "traitement", "thérapie", "cancer", "alzheimer", "antibiotique", "recherche", "médecine", "chercheurs"],
  },

  // Risques & fin du monde
  {
    id: "fin-du-monde", label: "Fin du monde & effondrement", group: "Risques & fin du monde", query: "effondrement risque civilisation catastrophe mondiale",
    keywords: ["effondrement", "collapse", "catastrophe", "fin du monde", "catastrophique", "apocalypse", "survie", "crise majeure", "réserve", "pénurie", "scénario", "signal", "urgence"],
    aliases: ["fin du monde", "effondrement", "collapsologie", "apocalypse"],
  },
  {
    id: "risque-nucleaire", label: "Risque nucléaire", group: "Risques & fin du monde", query: "nucléaire missile dissuasion essai",
    keywords: ["nucléaire", "missile", "dissuasion", "ogive", "silo", "centrale", "radiation", "traité", "iran nucléaire", "essai", "alerte"],
    aliases: ["risque nucleaire", "risque nucléaire"],
  },
  {
    id: "risque-ia", label: "IA & risques existentiels", group: "Risques & fin du monde", query: "intelligence artificielle risque catastrophe contrôle",
    keywords: ["intelligence artificielle", "risque", "sécurité", "contrôle", "alignement", "agents autonomes", "catastrophe", "scénarios", "régulation", "gouvernance", "superintelligence", "armée"],
    aliases: ["ia & risques", "risque ia"],
  },
  {
    id: "espace-menace", label: "Menaces spatiales", group: "Risques & fin du monde", query: "astéroïde défense planétaire éruption solaire",
    keywords: ["astéroïde", "comète", "impact", "défense planétaire", "nasa", "éruption solaire", "tempête géomagnétique", "orbite", "collision"],
    aliases: ["asteroide", "astéroïde"],
  },

  // Science & espace
  {
    id: "espace", label: "Espace & astronomie", group: "Science & espace", query: "espace mission spatiale découverte astronomie",
    keywords: ["espace", "mission", "fusée", "satellite", "iss", "spatial", "exoplanète", "télescope", "mars", "lune", "galaxie", "astronautes"],
    aliases: ["espace", "science & espace"],
  },
  {
    id: "science", label: "Science & découvertes", group: "Science & espace", query: "découverte scientifique recherche physique",
    keywords: ["découverte", "recherche", "physique", "biologie", "archéologie", "fossile", "étude", "chercheurs", "génome", "paléontologie", "laboratoire"],
    aliases: ["science", "decouvertes"],
  },

  // Culture & sport
  {
    id: "culture", label: "Culture & médias", group: "Culture & sport", query: "culture cinéma livre exposition",
    keywords: ["culture", "film", "cinéma", "livre", "roman", "exposition", "festival", "théâtre", "musée", "série", "album", "artiste", "prix", "médias", "presse"],
    aliases: ["culture", "culture & medias"],
  },
  {
    id: "sport", label: "Sport", group: "Culture & sport", query: "sport match championnat",
    keywords: ["sport", "match", "championnat", "football", "rugby", "tennis", "basket", "cyclisme", "jo", "coupe", "entraîneur", "joueur", "f1", "moto", "athlétisme"],
    aliases: ["sport"],
  },
  {
    id: "insolite", label: "Insolite", group: "Culture & sport", query: "insolite surprenant record",
    keywords: ["insolite", "surprenant", "record", "étrange", "bizarre", "découverte", "exploit", "hasard", "internet"],
  },
];

/** Accent-free lookup key. */
export const normToken = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " & ")
    .replace(/[^a-z0-9&]+/g, " ")
    .trim();

const THEME_INDEX = new Map<string, Theme>();
for (const theme of THEMES) {
  THEME_INDEX.set(normToken(theme.label), theme);
  THEME_INDEX.set(normToken(theme.id), theme);
  for (const alias of theme.aliases ?? []) THEME_INDEX.set(normToken(alias), theme);
}

/** Resolves a chip label ("Santé & épidémies") to its theme, if it matches one. */
export function themeFor(topic: string): Theme | null {
  return THEME_INDEX.get(normToken(topic)) ?? null;
}

export function isFrontPage(topic: string): boolean {
  return normToken(topic) === "a la une" || normToken(topic) === "une" || normToken(topic) === "headlines";
}

export const DEFAULT_CHIPS = [
  FRONT_PAGE,
  "IA & tech",
  "Actualité France",
  "Monde",
  "Économie & marchés",
  "Climat & énergie",
  "Santé & épidémies",
  "Fin du monde & effondrement",
  "Espace & astronomie",
  "Sport",
  "Culture & médias",
];

/* ─────────────────────────── présentateurs ─────────────────────────── */

export interface Host {
  name: string;
  voice: string;
  persona: string;
}

export const DEFAULT_HOSTS: Record<Locale, Host[]> = {
  fr: [
    { name: "Camille", voice: "fr-FR-DeniseNeural", persona: "Chaleureuse et curieuse, elle ouvre le bulletin, pose les questions simples, vulgarise et relance son collègue." },
    { name: "Théo", voice: "fr-FR-HenriNeural", persona: "Posé et analytique, il apporte le contexte, les chiffres, les comparaisons, avec un humour très sec." },
  ],
  en: [
    { name: "Ava", voice: "en-US-AriaNeural", persona: "Warm and curious, she opens the show, asks the plain-language questions and keeps the pace moving." },
    { name: "Miles", voice: "en-US-GuyNeural", persona: "Calm and analytical, he brings context, numbers and comparisons, with dry humour." },
  ],
};

/* ─────────────────────────── gabarits de présentateurs ─────────────────────────── */

export interface PersonaTemplate {
  id: string;
  label: string;
  /** Voix suggérée quand le gabarit est appliqué. */
  gender: "F" | "H";
  fr: { name: string; persona: string };
  en: { name: string; persona: string };
}

export const PERSONA_TEMPLATES: PersonaTemplate[] = [
  {
    id: "optimiste", label: "Optimiste", gender: "F",
    fr: { name: "Lila", persona: "Optimiste invétérée : elle cherche systématiquement la bonne nouvelle, relativise les mauvaises et trouve toujours une raison d'y croire, sans nier les faits." },
    en: { name: "Joy", persona: "An incurable optimist: she always looks for the bright side, keeps bad news in proportion and finds a reason to hope, without denying the facts." },
  },
  {
    id: "pessimiste", label: "Pessimiste", gender: "H",
    fr: { name: "Marcel", persona: "Pessimiste lucide et un peu las : il attend le pire sans se tromper sur les faits, soupire, rappelle que ça n'arrange jamais rien, mais reconnaît quand ça va mieux." },
    en: { name: "Walter", persona: "A lucid, slightly weary pessimist: he expects the worst without getting facts wrong, sighs a lot and reminds everyone that it never helps — but concedes when things improve." },
  },
  {
    id: "ironique", label: "Ironique", gender: "F",
    fr: { name: "Inès", persona: "Ironique et pince-sans-rire : second degré permanent, petites piques sur les responsables et les communicants, jamais méchante avec les victimes." },
    en: { name: "Iris", persona: "Ironic and deadpan: permanent second degree, gentle jabs at officials and spin doctors, never cruel about victims." },
  },
  {
    id: "bouffon", label: "Bouffon", gender: "H",
    fr: { name: "Bastien", persona: "Bouffon assumé : vannes, comparaisons absurdes, imitations légères, il fait rire puis redevient sérieux en une phrase. Jamais de blague sur les drames." },
    en: { name: "Benny", persona: "An unapologetic jester: jokes, absurd comparisons, light impressions — he gets a laugh then turns serious in one sentence. Never jokes about disasters." },
  },
  {
    id: "taquine", label: "Taquine (façon Nagatoro)", gender: "F",
    fr: { name: "Nao", persona: "Espiègle et taquine, un peu insolente : elle chambre son collègue et l'auditeur, adore le taquiner sur ses questions, puis redevient précise et utile. Taquinerie affectueuse, jamais humiliante." },
    en: { name: "Nao", persona: "Playful and teasing, a bit cheeky: she ribs her co-host and the listener, loves poking fun at their questions, then snaps back to precise and useful. Affectionate teasing, never humiliating." },
  },
  {
    id: "analyste", label: "Analyste", gender: "H",
    fr: { name: "Victor", persona: "Analyste : chiffres, ordres de grandeur, comparaisons historiques, il structure l'information et corrige les approximations de l'autre voix." },
    en: { name: "Victor", persona: "The analyst: numbers, orders of magnitude, historical comparisons — he structures the information and corrects the other voice's approximations." },
  },
  {
    id: "vulgarisateur", label: "Vulgarisateur", gender: "F",
    fr: { name: "Maya", persona: "Vulgarisatrice : elle traduit le jargon en langage simple, donne des exemples concrets du quotidien et vérifie que l'auditeur a bien compris." },
    en: { name: "Maya", persona: "The explainer: she turns jargon into plain language, gives everyday examples and checks the listener actually understood." },
  },
  {
    id: "sceptique", label: "Sceptique", gender: "H",
    fr: { name: "Gaspard", persona: "Sceptique méthodique : il demande des preuves, distingue les faits des annonces, signale les sources faibles et les chiffres invérifiables." },
    en: { name: "Gaspard", persona: "A methodical sceptic: he asks for evidence, separates facts from announcements, flags weak sourcing and unverifiable numbers." },
  },
  {
    id: "dramatique", label: "Dramatique", gender: "F",
    fr: { name: "Solène", persona: "Dramatique : elle raconte l'actualité comme un feuilleton, avec suspense et respiration, mais sans exagérer l'importance réelle des faits." },
    en: { name: "Solene", persona: "Dramatic: she tells the news like a series, with suspense and pacing, without inflating how much the facts actually matter." },
  },
  {
    id: "complice", label: "Complice", gender: "F",
    fr: { name: "Nora", persona: "Complice et chaleureuse : elle parle à l'auditeur comme à un ami, l'interpelle directement, partage des impressions personnelles mesurées." },
    en: { name: "Nora", persona: "Warm and friendly: she talks to the listener like a friend, addresses them directly and shares measured personal takes." },
  },
  {
    id: "zen", label: "Zen", gender: "H",
    fr: { name: "Sacha", persona: "Zen : voix calme, débit posé, il prend du recul, contextualise, et désamorce les sujets anxiogènes sans les minimiser." },
    en: { name: "Sacha", persona: "Zen: calm delivery, steps back, gives context and defuses anxiety-inducing topics without downplaying them." },
  },
  {
    id: "urgentiste", label: "Urgentiste", gender: "H",
    fr: { name: "Nils", persona: "Urgentiste : direct, factuel, phrases courtes, il va à l'essentiel et enchaîne, quitte à couper la parole quand ça traîne." },
    en: { name: "Nils", persona: "Breaking-news energy: direct, factual, short sentences, straight to the point — he even cuts the other off when it drags." },
  },
];

/** Duos prêts à l'emploi (ids de gabarits). */
export const DUO_PRESETS: { label: string; templateIds: [string, string] }[] = [
  { label: "Optimiste & Pessimiste", templateIds: ["optimiste", "pessimiste"] },
  { label: "Taquine & Analyste", templateIds: ["taquine", "analyste"] },
  { label: "Bouffon & Sceptique", templateIds: ["bouffon", "sceptique"] },
  { label: "Ironique & Dramatique", templateIds: ["ironique", "dramatique"] },
  { label: "Complice & Zen", templateIds: ["complice", "zen"] },
  { label: "Vulgarisatrice & Urgentiste", templateIds: ["vulgarisateur", "urgentiste"] },
];

export function personaTemplate(id: string): PersonaTemplate | null {
  return PERSONA_TEMPLATES.find((tpl) => tpl.id === id) ?? null;
}

/** Ids réservés : un gabarit perso ne peut pas écraser un gabarit fourni. */
export const PERSONA_TEMPLATE_IDS = new Set(PERSONA_TEMPLATES.map((tpl) => tpl.id));

const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Valide un gabarit venu du navigateur (création, import JSON, relecture du
 * fichier de réglages). Renvoie null si rien d'exploitable n'en sort.
 * Une langue absente est complétée par l'autre, pour qu'un gabarit reste
 * utilisable dans les deux langues.
 */
export function normalizeTemplate(raw: unknown): PersonaTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
  const id = text(t.id, 40).toLowerCase();
  if (!TEMPLATE_ID_RE.test(id)) return null;
  const fr = (t.fr && typeof t.fr === "object" ? t.fr : {}) as Record<string, unknown>;
  const en = (t.en && typeof t.en === "object" ? t.en : {}) as Record<string, unknown>;
  const nameFr = text(fr.name, 24);
  const nameEn = text(en.name, 24);
  const personaFr = text(fr.persona, 400);
  const personaEn = text(en.persona, 400);
  if (!nameFr && !nameEn) return null;
  return {
    id,
    label: text(t.label, 60) || id,
    gender: t.gender === "H" ? "H" : "F",
    fr: { name: nameFr || nameEn, persona: personaFr || personaEn },
    en: { name: nameEn || nameFr, persona: personaEn || personaFr },
  };
}

/** Ids de gabarits déjà pris (fournis + persos), pour en générer un unique. */
export function templateIdsInUse(custom: PersonaTemplate[] = []): string[] {
  return [...PERSONA_TEMPLATES.map((tpl) => tpl.id), ...custom.map((tpl) => tpl.id)];
}

/* ─────────────────────────── langues ─────────────────────────── */

export interface LocaleInfo {
  label: string;
  hl: string;
  gl: string;
  ceid: string;
  langName: string;
  defaultEdgeVoice: string;
  fallbackVoices: { id: string; label: string }[];
}

export const LOCALES: Record<Locale, LocaleInfo> = {
  fr: {
    label: "Français",
    hl: "fr",
    gl: "FR",
    ceid: "FR:fr",
    langName: "français",
    defaultEdgeVoice: "fr-FR-DeniseNeural",
    fallbackVoices: [
      { id: "fr-FR-DeniseNeural", label: "Denise (FR, F)" },
      { id: "fr-FR-HenriNeural", label: "Henri (FR, H)" },
      { id: "fr-FR-VivienneMultilingualNeural", label: "Vivienne (FR, F)" },
      { id: "fr-FR-RemyMultilingualNeural", label: "Rémy (FR, H)" },
      { id: "fr-CA-SylvieNeural", label: "Sylvie (CA, F)" },
      { id: "fr-CA-ThierryNeural", label: "Thierry (CA, H)" },
    ],
  },
  en: {
    label: "English",
    hl: "en",
    gl: "US",
    ceid: "US:en",
    langName: "English",
    defaultEdgeVoice: "en-US-AriaNeural",
    fallbackVoices: [
      { id: "en-US-AriaNeural", label: "Aria (US, F)" },
      { id: "en-US-GuyNeural", label: "Guy (US, H)" },
      { id: "en-GB-SoniaNeural", label: "Sonia (UK, F)" },
      { id: "en-GB-RyanNeural", label: "Ryan (UK, H)" },
    ],
  },
};

/** Preferred LLM slugs; the first one present in the live OpenRouter list wins. */
export const PREFERRED_LLM_MODELS = [
  "tencent/hy3",
  "qwen/qwen3.8-27b:free",
  "google/gemini-2.5-flash-lite",
  "openai/gpt-oss-20b",
  "google/gemini-2.5-flash",
  "openai/gpt-4o-mini",
  "deepseek/deepseek-chat",
];

/** Shortlist of TTS models surfaced first in the comparison UI. */
export const TTS_PRESET_MODELS = [
  "fish-audio/s2.1-pro-free:free",
  "hexgrad/kokoro-82m",
  "google/gemini-3.8-flash-lite-tts",
  "microsoft/mai-voice-2.1-flash",
  "deepgram/aura-2",
];

/** Radio pace used to size a bulletin from its target duration. */
export const WORDS_PER_SECOND = 2.6;

/** Average spoken characters per second, used to approximate token-billed TTS cost. */
export const CHARS_PER_SECOND = 15;

export const CADENCE_OPTIONS = [30, 45, 60, 90, 120, 180, 300];

/** L'auditeur à qui les présentateurs s'adressent. */
export interface Listener {
  name: string;
  persona: string;
}

export const DEFAULT_LISTENER: Record<Locale, Listener> = {
  fr: { name: "Alex", persona: "Auditeur fidèle, curieux de tout, il aime les explications concrètes et les ordres de grandeur." },
  en: { name: "Alex", persona: "A loyal listener, curious about everything, who likes concrete explanations and orders of magnitude." },
};

/* ─────────────────────────── fond musical ─────────────────────────── */

/**
 * Ambiances du fond musical d'attente. Les identifiants sont aussi les noms des
 * pistes livrées avec l'app (public/music/bed-<id>.mp3) ; « aucun » coupe la
 * musique. Les libellés affichés viennent de l'interface bilingue
 * (clés i18n « music.mood.<id> »), pour ne pas dupliquer les traductions ici.
 */
export type MusicMood = "aucun" | "ambient" | "calme" | "electro" | "tension";

export const MUSIC_MOODS: { id: MusicMood; file: string }[] = [
  { id: "ambient", file: "bed-ambient.mp3" },
  { id: "calme", file: "bed-calme.mp3" },
  { id: "electro", file: "bed-electro.mp3" },
  { id: "tension", file: "bed-tension.mp3" },
];

const MUSIC_MOOD_IDS = new Set<string>([...MUSIC_MOODS.map((mood) => mood.id), "aucun"]);

export function isMusicMood(value: unknown): value is MusicMood {
  return typeof value === "string" && MUSIC_MOOD_IDS.has(value);
}

/** Piste livrée pour une ambiance (null pour « aucun »). */
export function musicMoodFile(id: MusicMood): string | null {
  return MUSIC_MOODS.find((mood) => mood.id === id)?.file ?? null;
}

/** Extensions reconnues pour une piste, où qu'elle vienne. */
export const MUSIC_EXTENSIONS = [".mp3", ".ogg", ".m4a", ".wav", ".flac", ".aac"];

/** Type MIME d'une piste, déduit de son extension. */
export function musicMime(name: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return (
    {
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg",
      ".m4a": "audio/mp4",
      ".wav": "audio/wav",
      ".flac": "audio/flac",
      ".aac": "audio/aac",
    }[ext] ?? "application/octet-stream"
  );
}

/** Est-ce que ce nom de fichier ressemble à une piste exploitable ? */
export function isMusicFile(name: string): boolean {
  return !name.startsWith(".") && MUSIC_EXTENSIONS.includes(name.slice(name.lastIndexOf(".")).toLowerCase());
}

export type RadioMode = "news" | "explore" | "hybrid";

export interface Settings {
  radioMode: RadioMode;
  searchIntervalSec: number;
  questionTiming: "after" | "now";
  humor: number;
  disagreement: number;
  technicality: number;
  replyLength: number;
  addressFrequency: number;
  ttsFallback: boolean;
  ttsFallbackModel: string;
  openrouterKey: string;
  llmModel: string;
  /** Modèle des tâches rapides (requête de recherche, récapitulatifs) ; vide = même modèle. */
  llmModelFast: string;
  ttsProvider: "edge" | "openrouter" | "local";
  localExaggeration: number;
  ttsModel: string;
  ttsVoice: string;
  ttsSpeed: number;
  locale: Locale;
  /** 1 or 2 presenters on air. */
  hostCount: 1 | 2;
  hosts: Host[];
  listener: Listener;
  topic: string;
  chips: string[];
  feeds: string[];
  customFeeds: { label: string; url: string }[];
  useGoogleNews: boolean;
  cadenceSec: number;
  maxSources: number;
  prefetch: number;
  deepRead: boolean;
  styleNote: string;
  /** Keep every produced segment on disk (shows/YYYY-MM-DD/HH-MM-SS.mp3). */
  archive: boolean;
  /** Sans dépêche exploitable, le LLM répond de mémoire (culture générale). */
  knowledgeFallback: boolean;
  /** S'adresser à l'auditeur en le tutoyant (français). */
  tutoiement: boolean;
  /** Ne pas rediffuser une histoire déjà passée à l'antenne dans la journée. */
  newsMemory: boolean;
  /** Gabarits de présentateurs créés depuis l'interface. */
  customTemplates: PersonaTemplate[];
  /** Ambiance du fond musical joué quand le tampon est vide ("aucun" = jamais). */
  musicMood: MusicMood;
  /** Dossier de musique de l'utilisateur ; vide = les pistes livrées avec l'app. */
  musicFolder: string;
}

export const DEFAULT_SETTINGS: Settings = {
  radioMode: "hybrid",
  searchIntervalSec: 600,
  questionTiming: "after",
  humor: 1,
  disagreement: 1,
  technicality: 1,
  replyLength: 2,
  addressFrequency: 1,
  ttsFallback: true,
  ttsFallbackModel: "",
  openrouterKey: "",
  llmModel: "tencent/hy3",
  llmModelFast: "",
  ttsProvider: "edge",
  localExaggeration: 0.5,
  ttsModel: "fish-audio/s2.1-pro-free:free",
  ttsVoice: "fr-FR-DeniseNeural",
  ttsSpeed: 1.05,
  locale: "fr",
  hostCount: 2,
  hosts: DEFAULT_HOSTS.fr.map((h) => ({ ...h })),
  listener: { ...DEFAULT_LISTENER.fr },
  topic: FRONT_PAGE,
  chips: DEFAULT_CHIPS,
  feeds: ["lemonde", "france24", "francetvinfo", "numerama", "bbcworld"],
  customFeeds: [],
  useGoogleNews: true,
  cadenceSec: 60,
  maxSources: 5,
  prefetch: 3,
  deepRead: true,
  styleNote: "Complicité légère, informations claires, pas de sensationnalisme.",
  archive: true,
  tutoiement: true,
  knowledgeFallback: true,
  newsMemory: true,
  customTemplates: [],
  musicMood: "ambient",
  musicFolder: "",
};

/** Folder holding the archived shows, relative to the project root. */
export const SHOWS_DIR = "shows";

/** Absolute path of the archive folder. */
export const SHOWS_PATH = join(PROJECT_ROOT, SHOWS_DIR);
