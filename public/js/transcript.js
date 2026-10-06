/**
 * Transcript synchronisation.
 *
 * Two cases:
 *  - the engine gave word timings (Edge TTS does) -> align them with the tokens;
 *  - it did not (most OpenRouter TTS models) -> spread the audio duration over
 *    the tokens, weighted by length and punctuation, using the measured rate.
 */

const deaccent = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");

/**
 * Splits the transcript into sentences and words, keeping each token's character
 * range: it is what links a word to the speaker who said it.
 */
export function buildTokens(transcript) {
  const raw = transcript || "";
  const sentences = [];
  const sentenceRe = /[^.!?…]+[.!?…]*/g;
  let match;
  while ((match = sentenceRe.exec(raw))) {
    const text = match[0].trim();
    if (!text) continue;
    const lead = match[0].length - match[0].trimStart().length;
    sentences.push({ start: match.index + lead, end: match.index + lead + text.length, text });
  }
  if (!sentences.length && raw.length) sentences.push({ start: 0, end: raw.length, text: raw });

  const tokens = [];
  const tokenRe = /\S+/g;
  let current = 0;
  let token;
  while ((token = tokenRe.exec(raw))) {
    const start = token.index;
    while (current < sentences.length - 1 && start >= sentences[current].end) current += 1;
    tokens.push({ text: token[0], start, end: start + token[0].length, sentence: current, startMs: null, endMs: null });
  }
  return { tokens, sentences };
}

function weight(token) {
  const base = token.text.replace(/[^\p{L}\p{N}]/gu, "").length || 1;
  if (/[.!?…]$/.test(token.text)) return base + 7;
  if (/[,;:]$/.test(token.text)) return base + 3;
  return base;
}

/** Spreads a duration over tokens proportionally to their weight. */
function distribute(tokens, fromMs, toMs, slice) {
  const total = slice.reduce((sum, t) => sum + weight(t), 0) || 1;
  let cursor = fromMs;
  for (const token of slice) {
    const span = ((toMs - fromMs) * weight(token)) / total;
    token.startMs = cursor;
    token.endMs = cursor + span;
    cursor += span;
  }
}

/**
 * Aligns real word boundaries onto the tokens. Sequences such as "start-up"
 * (one token, two boundaries) are merged; unmatched tokens are interpolated.
 */
export function alignWords(tokens, words) {
  if (!Array.isArray(words) || !words.length) return false;
  let wi = 0;
  let matched = 0;
  for (const token of tokens) {
    const want = deaccent(token.text);
    if (!want) continue;
    let acc = "";
    let j = wi;
    while (j < words.length && acc.length < want.length && j - wi < 3) {
      acc += deaccent(words[j].text);
      j += 1;
    }
    if (acc === want) {
      token.startMs = words[wi].startMs;
      token.endMs = words[j - 1].endMs;
      wi = j;
      matched += 1;
    }
  }
  // Keep the real timings only if the alignment looks trustworthy.
  return matched >= Math.max(3, Math.floor(tokens.length * 0.5));
}

/** Chronological timeline: interpolate the runs of tokens without timings. */
export function fillGaps(tokens, durationMs) {
  const known = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => Number.isFinite(token.startMs) && Number.isFinite(token.endMs));
  if (!known.length) {
    distribute(tokens, 0, durationMs, tokens);
    return tokens;
  }
  const first = known[0].index;
  const last = known[known.length - 1].index;
  if (first > 0) distribute(tokens, Math.max(0, known[0].token.startMs - 1600), known[0].token.startMs, tokens.slice(0, first));
  for (let k = 0; k < known.length - 1; k += 1) {
    const a = known[k];
    const b = known[k + 1];
    const slice = tokens.slice(a.index + 1, b.index);
    if (slice.length) distribute(tokens, a.token.endMs, b.token.startMs, slice);
  }
  if (last < tokens.length - 1) {
    const tail = tokens.slice(last + 1);
    distribute(tokens, known[known.length - 1].token.endMs, Math.max(durationMs, known[known.length - 1].token.endMs + tail.length * 260), tail);
  }
  tokens.forEach((token) => {
    if (!Number.isFinite(token.startMs)) token.startMs = 0;
    if (!Number.isFinite(token.endMs) || token.endMs < token.startMs) token.endMs = token.startMs + 180;
  });
  return tokens;
}

/** @param durationSec real audio duration when known, otherwise NaN */
export function prepareSegment(segment, durationSec) {
  const { tokens, sentences } = buildTokens(segment.transcript);
  const speakerTurns = segment.turns ?? [];
  tokens.forEach((token) => {
    let turn = 0;
    for (let i = speakerTurns.length - 1; i >= 0; i -= 1) {
      if (token.start >= speakerTurns[i].start) {
        turn = i;
        break;
      }
    }
    token.turn = turn;
  });
  const aligned = alignWords(tokens, segment.words);
  const total = Number.isFinite(durationSec) && durationSec > 0
    ? durationSec * 1000
    : Math.max(2000, (segment.estimatedSeconds || tokens.length * 0.42) * 1000);
  fillGaps(tokens, total);
  return { tokens, sentences, exact: aligned, turns: speakerTurns };
}

/**
 * Index of the token being spoken at `ms`: the last token that started before
 * `ms` (-1 before the first line). Past the end, the last token stays active.
 */
export function tokenIndexAt(tokens, ms) {
  let lo = 0;
  let hi = tokens.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
