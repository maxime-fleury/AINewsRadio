/**
 * Compose le jingle d'ouverture de la radio : une signature sonore courte,
 * synthétisée ici — aucun échantillon téléchargé, donc aucune question de licence.
 *
 *   bun scripts/make-jingle.ts        → public/jingle/start.mp3, 6 s
 *   bun scripts/make-jingle.ts 8      → 8 s
 *
 * C'est le fichier que l'app joue au démarrage d'une émission (voir
 * public/js/app.js, cycleIntro). Le motif est volontairement minimal : la même
 * note (la 5, 880 Hz) frappée trois fois en noires à 120 BPM, puis reprise comme
 * sommet de l'accord final. Ce qui rend la signature reconnaissable, c'est le
 * rythme — puis l'accord large qui arrive dessus (la + quinte + octaves, sans
 * tierce : il tombe juste partout, y compris sur les ambiances en la mineur / do
 * majeur du fond musical).
 */
import { join } from "node:path";
import { midiToFreq, normalize, PEAK, SR, type StereoSamples, writeMp3 } from "./audio";

const JINGLE_DIR = join(import.meta.dir, "..", "public", "jingle");
const FILE = "start.mp3";

/* ─────────────────────────── la piste en cours ─────────────────────────── */

let frames = 0;
let left = new Float32Array(0);
let right = new Float32Array(0);

function startTrack(seconds: number): void {
  frames = SR * seconds;
  left = new Float32Array(frames);
  right = new Float32Array(frames);
}

/* ─────────────────────────── timbres ─────────────────────────── */

/**
 * Cloche : partiels inharmoniques (1, 2, 2,76, 5,4, 8,93 × la fondamentale).
 * C'est ce qu'on entend dans un carillon de gare — net, brillant, et ça s'éteint
 * tout seul. Chaque partiel a sa propre extinction et un léger écart de panoramique.
 */
const BELL_PARTIALS = [
  { ratio: 1, gain: 1, decay: 1 },
  { ratio: 2, gain: 0.42, decay: 0.72 },
  { ratio: 2.76, gain: 0.3, decay: 0.5 },
  { ratio: 5.4, gain: 0.14, decay: 0.34 },
  { ratio: 8.93, gain: 0.07, decay: 0.22 },
];

/** Ajoute les partiels de la cloche, avec attaque courte et panoramique alterné. */
function bell(freq: number, at: number, decay: number, gain = 1): void {
  const from = Math.floor(at * SR);
  if (from >= frames) return;
  const attack = 0.004;
  const length = Math.min(frames - from, Math.floor(decay * 6.9 * SR)); // ≈ -60 dB
  BELL_PARTIALS.forEach((partial, index) => {
    const f = freq * partial.ratio;
    if (f > SR / 2) return; // au-delà de Nyquist : on n'ajoute pas d'alias
    const tau = Math.max(0.05, decay * partial.decay);
    const amp = gain * partial.gain * 0.5;
    const pan = index % 2 === 0 ? 0.12 : -0.12; // largeur stéréo
    const gl = 1 - Math.max(0, pan);
    const gr = 1 + Math.min(0, pan);
    for (let i = 0; i < length; i++) {
      const t = i / SR;
      const env = Math.min(1, t / attack) * Math.exp(-t / tau);
      if (env < 0.0004) break;
      const sample = Math.sin(2 * Math.PI * f * t) * env * amp;
      left[from + i] += sample * gl;
      right[from + i] += sample * gr;
    }
  });
}

/** Pavé : sinus additionnés, attaque douce, extinction longue (l'assise de l'accord). */
function pad(freq: number, at: number, attack: number, decay: number, gain = 1, harmonics = 3, rolloff = 1.6, pan = 0): void {
  const from = Math.floor(at * SR);
  if (from >= frames) return;
  const length = Math.min(frames - from, Math.floor((attack + decay * 6.9) * SR));
  const gl = 1 - Math.max(0, pan);
  const gr = 1 + Math.min(0, pan);
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / Math.max(0.005, attack)) * Math.exp(-t / decay);
    if (env < 0.0004) break;
    let sample = 0;
    for (let h = 1; h <= harmonics; h++) {
      if (freq * h > SR / 2) break;
      sample += Math.sin(2 * Math.PI * freq * h * t) / Math.pow(h, rolloff);
    }
    sample *= env * gain * 0.5;
    left[from + i] += sample * gl;
    right[from + i] += sample * gr;
  }
}

/** Souffle qui monte vers l'accord, pour que l'arrivée s'entende venir. */
function riser(from: number, to: number, gain = 0.055): void {
  const start = Math.floor(from * SR);
  const end = Math.min(frames, Math.floor(to * SR));
  let lp = 0;
  for (let s = start; s < end; s++) {
    const k = (s - start) / (end - start);
    lp += 0.25 * ((Math.random() * 2 - 1) * gain * k * k - lp); // passe-bas doux
    left[s] += lp;
    right[s] += lp;
  }
}

/* ─────────────────────────── sortie ─────────────────────────── */

/** Fondu final, 3 ms de fondu d'entrée pour éviter le clic, puis normalisation. */
function finish(seconds: number): StereoSamples {
  const outStart = Math.floor((seconds - 0.8) * SR);
  for (let s = outStart; s < frames; s++) {
    const k = 1 - (s - outStart) / (frames - outStart);
    left[s] *= k * k;
    right[s] *= k * k;
  }
  const inLength = Math.floor(0.003 * SR);
  for (let s = 0; s < inLength; s++) {
    const k = s / inLength;
    left[s] *= k;
    right[s] *= k;
  }
  // Même niveau crête que les fonds musicaux : le volume du lecteur reste juste.
  normalize(left, right, PEAK);
  return { left, right };
}

/* ─────────────────────────── composition ─────────────────────────── */

/** Trois noires, puis la même note au sommet de l'accord de la. */
function compose(): void {
  const MOTIF = midiToFreq(81); // la 5 — la note unique du motif
  const BEAT = 0.5; // noire à 120 BPM
  const FIRST = 0.2;

  // 1. Le motif : trois frappes de la même note, la troisième appuyée.
  bell(MOTIF, FIRST, 1.4, 1);
  bell(MOTIF, FIRST + BEAT, 1.4, 0.92);
  bell(MOTIF, FIRST + 2 * BEAT, 1.9, 1.05);

  // 2. L'accord, une demi-mesure plus tard : la note du motif revient au sommet,
  //    doublée à l'aiguë pour le scintillement, et tenue sous des octaves larges.
  const CHORD = 1.9;
  pad(midiToFreq(45), CHORD, 0.12, 2.2, 0.42, 2, 2.1); // la 2 — le poids
  pad(midiToFreq(52), CHORD, 0.26, 2.0, 0.34, 3, 1.8, -0.22); // mi 3 — la quinte
  pad(midiToFreq(57), CHORD, 0.28, 2.0, 0.5, 3, 1.7, 0.22); // la 3
  pad(midiToFreq(64), CHORD, 0.28, 2.1, 0.3, 3, 1.7, -0.18); // mi 4
  pad(midiToFreq(69), CHORD, 0.3, 2.4, 0.36, 4, 1.6); // la 4
  bell(MOTIF, CHORD, 2.6, 1); // le motif, encore, par-dessus
  bell(MOTIF * 2, CHORD + 0.02, 0.9, 0.16); // la 6 — la touche de brillance

  // 3. Un souffle qui monte vers l'accord.
  riser(0.95, CHORD);
}

/* ─────────────────────────── ligne de commande ─────────────────────────── */

const seconds = Math.max(4, Math.min(20, Math.round(Number(process.argv[2]) || 6)));

startTrack(seconds);
compose();
await writeMp3(finish(seconds), join(JINGLE_DIR, FILE));
console.log(`✔ public/jingle/${FILE} — ${seconds}s, cloche en la, trois noires puis l'accord ouvert.`);
