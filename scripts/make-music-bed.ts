/**
 * Génère des fonds musicaux d'attente (beds) libres de droits, à partir de rien.
 *
 * Toute la musique est synthétisée ici : aucune piste téléchargée, donc aucune
 * question de licence. Le résultat va dans public/music/ et sert à combler les
 * trous quand le tampon est vide (voir cycleIntro dans public/js/app.js).
 *
 *   bun scripts/make-music-bed.ts                 → bed-ambient.mp3, 48 s
 *   bun scripts/make-music-bed.ts all             → les quatre ambiances
 *   bun scripts/make-music-bed.ts electro 90      → bed-electro.mp3, 90 s
 *
 * Les identifiants correspondent au réglage « type de musique » de l'interface :
 * ambient, calme, electro, tension. Toutes les ambiances sont normalisées au même
 * niveau crête, pour qu'on puisse passer de l'une à l'autre sans retoucher le
 * volume du lecteur.
 *
 * Tu peux évidemment déposer tes propres pistes CC0/CC-BY dans public/music/ :
 * elles sont prises en compte au même titre.
 */
import { join } from "node:path";
import { normalize, PEAK, SR, writeMp3 } from "./audio";

const PUBLIC_MUSIC = join(import.meta.dir, "..", "public", "music");

const f = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

/** Réglages d'une ambiance : c'est la seule chose qui change d'une piste à l'autre. */
interface Mood {
  /** Nom lisible, pour la ligne de journal. */
  label: string;
  /** Progression d'accords, en notes MIDI : une mesure lente par accord. */
  progression: number[][];
  /** Attaque (s) et relâchement (s) d'un accord — courts = piqué, longs = nappe. */
  attack: number;
  release: number;
  /** Nombre d'harmoniques par voix, et pente d'atténuation (grand = plus doux). */
  harmonics: number;
  rolloff: number;
  /** Détune (fraction) appliqué en alternance : léger effet de chorus. */
  detune: number;
  /** Coupure du passe-bas (Hz), amplitude et vitesse de sa respiration. */
  cutoff: number;
  cutoffSwing: number;
  cutoffSwingHz: number;
  /** Respiration du volume : profondeur et fréquence (Hz). */
  breathDepth: number;
  breathHz: number;
  /** Pompage rythmique du volume : fréquence (Hz) et profondeur. */
  pumpHz: number;
  pumpDepth: number;
  /** Arpège : cadence de re-déclenchement (Hz), attaque (s) et extinction. 0 = nappe tenue. */
  pluckHz: number;
  pluckAttack: number;
  pluckDecay: number;
  /** Frappe grave sur le temps : fréquence du temps (Hz), hauteur (Hz), gain et extinction. */
  thumpHz: number;
  thumpFreq: number;
  thumpGain: number;
  thumpDecay: number;
  /** Souffle de fond, pour que le silence ne « s'entende » pas. */
  air: number;
  /** Durée du raccord de boucle (s) : la fin est recollée au début sans clic. */
  loopFade: number;
}

const MOODS: Record<string, Mood> = {
  /** Nappe lente Am – F – C – G : la valeur sûre, très douce. */
  ambient: {
    label: "ambient",
    progression: [
      [45, 60, 64, 69], // A2 C4 E4 A4
      [41, 57, 60, 65], // F2 A3 C4 F4
      [48, 55, 60, 64], // C3 G3 C4 E4
      [43, 59, 62, 67], // G2 B3 D4 G4
    ],
    attack: 3.2,
    release: 3.4,
    harmonics: 4,
    rolloff: 1.6,
    detune: 0.0012,
    cutoff: 1500,
    cutoffSwing: 900,
    cutoffSwingHz: 0.013,
    breathDepth: 0.15,
    breathHz: 0.06,
    pumpHz: 0,
    pumpDepth: 0,
    pluckHz: 0,
    pluckAttack: 0.006,
    pluckDecay: 9,
    thumpHz: 0,
    thumpFreq: 55,
    thumpGain: 0,
    thumpDecay: 14,
    air: 0.0016,
    loopFade: 1.2,
  },
  /** Encore plus lent et plus doux, majeur : C – G – Am – F, filtre sombre. */
  calme: {
    label: "calme",
    progression: [
      [48, 60, 64, 67], // C3 C4 E4 G4
      [43, 55, 59, 67], // G2 G3 B3 G4
      [45, 57, 60, 64], // A2 A3 C4 E4
      [41, 53, 57, 65], // F2 F3 A3 F4
    ],
    attack: 4.5,
    release: 4.5,
    harmonics: 3,
    rolloff: 1.9,
    detune: 0.0008,
    cutoff: 1150,
    cutoffSwing: 500,
    cutoffSwingHz: 0.008,
    breathDepth: 0.12,
    breathHz: 0.04,
    pumpHz: 0,
    pumpDepth: 0,
    pluckHz: 0,
    pluckAttack: 0.006,
    pluckDecay: 9,
    thumpHz: 0,
    thumpFreq: 55,
    thumpGain: 0,
    thumpDecay: 14,
    air: 0.0012,
    loopFade: 1.5,
  },
  /** Pulsé à 120 BPM : arpège court sur les accords, pompage et frappe grave. */
  electro: {
    label: "électro",
    progression: [
      [45, 57, 60, 64], // A2 A3 C4 E4
      [41, 53, 57, 60], // F2 F3 A3 C4
      [48, 55, 60, 64], // C3 G3 C4 E4
      [43, 55, 59, 62], // G2 G3 B3 D4
    ],
    attack: 0.05,
    release: 0.45,
    harmonics: 6,
    rolloff: 1.25,
    detune: 0.002,
    cutoff: 3400,
    cutoffSwing: 600,
    cutoffSwingHz: 0.25,
    breathDepth: 0.06,
    breathHz: 0.12,
    pumpHz: 2,
    pumpDepth: 0.45,
    pluckHz: 4,
    pluckAttack: 0.006,
    pluckDecay: 9,
    thumpHz: 2,
    thumpFreq: 55,
    thumpGain: 0.35,
    thumpDecay: 14,
    air: 0.0012,
    loopFade: 1,
  },
  /** Sombre et dissonant : quartes augmentées, trémolo serré, filtre étroit. */
  tension: {
    label: "tension",
    progression: [
      [45, 51, 57, 63], // A2 D#3 A3 D#4 — triton
      [44, 50, 56, 62], // G#2 D3 G#3 D4
      [43, 49, 55, 61], // G2 C#3 G3 C#4
      [45, 51, 56, 62], // A2 D#3 G#3 D4
    ],
    attack: 2.2,
    release: 2.6,
    harmonics: 5,
    rolloff: 1.5,
    detune: 0.003,
    cutoff: 900,
    cutoffSwing: 350,
    cutoffSwingHz: 0.05,
    breathDepth: 0.1,
    breathHz: 0.09,
    pumpHz: 1.6,
    pumpDepth: 0.35,
    pluckHz: 0,
    pluckAttack: 0.006,
    pluckDecay: 9,
    thumpHz: 0,
    thumpFreq: 44,
    thumpGain: 0,
    thumpDecay: 14,
    air: 0.002,
    loopFade: 1.2,
  },
};

const MOOD_IDS = Object.keys(MOODS);

interface Voice {
  freq: number;
  gain: number;
  pan: number;
}

function chordVoices(midis: number[], mood: Mood): Voice[] {
  return midis.map((m, i) => ({
    freq: f(m) * (1 + (i % 2 === 0 ? mood.detune : -mood.detune)), // léger détune = chorus
    gain: i === 0 ? 0.5 : 0.3 / (1 + i * 0.35), // la basse domine, les aigus s'effacent
    pan: i % 2 === 0 ? 0.25 : -0.25,
  }));
}

/** Synthétise une ambiance : accords, frappe, souffle, filtre, boucle, normalisation. */
function render(mood: Mood, seconds: number): { left: Float32Array; right: Float32Array } {
  const chords = mood.progression.map((midis) => chordVoices(midis, mood));
  const chordLen = seconds / chords.length;
  const frames = SR * seconds;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const period = mood.pluckHz > 0 ? 1 / mood.pluckHz : 0;
  const attack = Math.max(0.01, mood.attack);
  const release = Math.max(0.05, mood.release);

  // Chaque accord est synthétisé dans sa fenêtre (avec recouvrement) puis mélangé.
  chords.forEach((voices, index) => {
    const start = index * chordLen;
    const from = Math.max(0, Math.floor((start - 1) * SR));
    const to = Math.min(frames, Math.floor((start + chordLen + release + 1) * SR));
    for (let s = from; s < to; s++) {
      const t = s / SR - start; // temps local à l'accord

      // Fenêtre de l'accord : aucun clic au passage d'un accord au suivant.
      const window = Math.min(1, Math.max(0, t) / attack) * Math.min(1, Math.max(0, chordLen + release - t) / release);
      if (window <= 0) continue;
      const breathe = 1 - mood.breathDepth + mood.breathDepth * Math.sin(2 * Math.PI * mood.breathHz * t);
      const pump = mood.pumpDepth > 0 ? 1 - mood.pumpDepth + mood.pumpDepth * (0.5 + 0.5 * Math.sin(2 * Math.PI * mood.pumpHz * t)) : 1;
      const frame = s / SR;
      for (let vi = 0; vi < voices.length; vi++) {
        const v = voices[vi];
        let env = 1;
        if (period > 0) {
          // Arpège : chaque voix attaque à son tour, puis s'éteint avant la suivante.
          const shifted = t - (vi * period) / voices.length;
          const local = ((shifted % period) + period) % period;
          env = Math.min(1, local / mood.pluckAttack) * Math.exp(-local * mood.pluckDecay);
          if (env <= 0.0005) continue;
        }
        let sample = 0;
        for (let h = 1; h <= mood.harmonics; h++) {
          sample += Math.sin(2 * Math.PI * v.freq * h * frame) / Math.pow(h, mood.rolloff);
        }
        sample *= v.gain * env * window * breathe * pump;
        left[s] += sample * (1 - Math.max(0, v.pan));
        right[s] += sample * (1 + Math.min(0, v.pan));
      }
    }
  });

  // Frappe grave sur le temps (électro) : la période divise la boucle, donc pas de saut.
  if (mood.thumpGain > 0 && mood.thumpHz > 0) {
    const beat = 1 / mood.thumpHz;
    for (let s = 0; s < frames; s++) {
      const since = (s / SR) % beat;
      const env = Math.exp(-since * mood.thumpDecay);
      if (env < 0.002) continue;
      const sample = Math.sin(2 * Math.PI * mood.thumpFreq * since) * env * mood.thumpGain;
      left[s] += sample;
      right[s] += sample;
    }
  }

  // Un souffle très discret, pour que le silence ne « s'entende » pas.
  for (let s = 0; s < frames; s++) {
    const air = (Math.random() * 2 - 1) * mood.air;
    left[s] += air;
    right[s] += air;
  }

  // Filtre passe-bas un pôle, coupure qui respire lentement : adoucit les harmoniques.
  let lpL = 0;
  let lpR = 0;
  for (let s = 0; s < frames; s++) {
    const cutoff = mood.cutoff + mood.cutoffSwing * Math.sin(2 * Math.PI * mood.cutoffSwingHz * (s / SR));
    const a = Math.min(1, (2 * Math.PI * cutoff) / SR);
    lpL += a * (left[s] - lpL);
    lpR += a * (right[s] - lpR);
    left[s] = lpL;
    right[s] = lpR;
  }

  // Fondu de boucle : on raccorde la fin au début pour un enchaînement sans clic.
  const fade = Math.min(Math.floor(frames / 4), Math.floor(mood.loopFade * SR));
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    const a = 1 - k;
    const s1 = frames - fade + i;
    left[i] = left[i] * k + left[s1] * a;
    right[i] = right[i] * k + right[s1] * a;
    left[s1] *= a;
    right[s1] *= a;
  }

  // Normalisation tranquille : même niveau d'une ambiance à l'autre, et le fond
  // doit passer sous la voix.
  normalize(left, right, PEAK);

  return { left, right };
}

/** Écrit une ambiance en MP3. Renvoie false si ffmpeg a échoué. */
async function generate(id: string, seconds: number): Promise<boolean> {
  const mood = MOODS[id];
  const { left, right } = render(mood, seconds);
  try {
    await writeMp3({ left, right }, join(PUBLIC_MUSIC, `bed-${id}.mp3`));
  } catch (err) {
    console.error(`ffmpeg a échoué (${id}) :`, (err as Error).message);
    return false;
  }
  console.log(`✔ public/music/bed-${id}.mp3 — ${seconds}s, ${mood.label} (synthétisé localement, libre de droits)`);
  return true;
}

const [, , moodArg = "ambient", secondsArg] = process.argv;
const seconds = Math.max(12, Math.round(Number(secondsArg) || 48));
const targets = moodArg === "all" ? MOOD_IDS : [moodArg];

const unknown = targets.filter((id) => !MOODS[id]);
if (unknown.length) {
  console.error(`Ambiance inconnue : ${unknown.join(", ")}.\nValides : ${MOOD_IDS.join(", ")}, all.`);
  process.exit(1);
}

for (const id of targets) {
  if (!(await generate(id, seconds))) process.exit(1);
}
