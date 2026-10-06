/**
 * Outils audio partagés par les générateurs locaux (`make-music-bed.ts`,
 * `make-jingle.ts`) : encodage WAV 16 bits stéréo et passage à ffmpeg.
 *
 * Rien n'est téléchargé : tout est synthétisé par le projet, donc sans question
 * de licence. Les fichiers produits vivent dans public/ et sont servis tels quels.
 */
import { mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const SR = 44100;

/**
 * Niveau crête commun à tous les sons du projet (fonds musicaux, jingle) : le
 * lecteur peut passer de l'un à l'autre sans retoucher son volume.
 */
export const PEAK = 0.32;

export interface StereoSamples {
  left: Float32Array;
  right: Float32Array;
}

/** Encode en WAV 16 bits stéréo, prêt pour ffmpeg. */
export function encodeWav({ left, right }: StereoSamples, sampleRate = SR): Uint8Array {
  const frames = left.length;
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + frames * 4, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stéréo
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // débit d'octets
  view.setUint16(32, 4, true); // alignement
  view.setUint16(34, 16, true); // 16 bits
  ascii(36, "data");
  view.setUint32(40, frames * 4, true);
  for (let s = 0; s < frames; s++) {
    view.setInt16(44 + s * 4, Math.round(left[s] * 32767), true);
    view.setInt16(46 + s * 4, Math.round(right[s] * 32767), true);
  }
  return bytes;
}

/**
 * Ramène le mélange à un niveau crête donné, sur place. Tous les fonds du projet
 * partagent la même cible : on peut passer de l'un à l'autre sans retoucher le
 * volume du lecteur.
 */
export function normalize(left: Float32Array, right: Float32Array, peakTarget: number): void {
  let peak = 0;
  for (let s = 0; s < left.length; s++) peak = Math.max(peak, Math.abs(left[s]), Math.abs(right[s]));
  const gain = peak > 0 ? peakTarget / peak : 0;
  for (let s = 0; s < left.length; s++) {
    left[s] = Math.max(-1, Math.min(1, left[s] * gain));
    right[s] = Math.max(-1, Math.min(1, right[s] * gain));
  }
}

/**
 * Écrit un WAV temporaire à côté du fichier de sortie, l'encode en MP3 avec
 * ffmpeg, puis supprime le WAV — même en cas d'échec. Lève une erreur si
 * ffmpeg n'est pas là ou refuse le fichier.
 */
export async function writeMp3(samples: StereoSamples, outPath: string, opts: { bitRate?: string; sampleRate?: number } = {}): Promise<void> {
  const sampleRate = opts.sampleRate ?? SR;
  const dir = dirname(outPath);
  mkdirSync(dir, { recursive: true });
  const tmpWav = join(dir, `.${basename(outPath)}.tmp.wav`);
  await Bun.write(tmpWav, encodeWav(samples, sampleRate));
  try {
    const ffmpeg = Bun.spawnSync([
      "ffmpeg", "-y", "-loglevel", "error",
      "-i", tmpWav,
      "-codec:a", "libmp3lame", "-b:a", opts.bitRate ?? "128k", "-ar", String(sampleRate),
      outPath,
    ], { stderr: "pipe" });
    if (ffmpeg.exitCode !== 0) {
      throw new Error(ffmpeg.stderr?.toString().trim() || `ffmpeg a quitté avec le code ${ffmpeg.exitCode}`);
    }
  } finally {
    rmSync(tmpWav, { force: true });
  }
}

/** Fréquence d'une note MIDI (69 = la 440 Hz). */
export const midiToFreq = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);
