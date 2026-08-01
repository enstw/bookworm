// TTS chunking core shared by src/worker.js (synthesis) and the reader's
// audio player in app.js. Pure functions over strings — both sides must
// produce identical chunk boundaries, or the audio the worker synthesizes
// and the char offsets the reader tracks drift apart.

// Measured on edge-tts zh-TW-HsiaoChenNeural (劍來 ch.1, 248-char chunk →
// 54.6 s): Mandarin speech averages ~4.5 chars/sec. Only a fallback for
// playback→offset mapping — the player prefers proportional mapping over
// the real audio.duration once metadata is loaded.
export const CHARS_PER_SEC = 4.5;

// Whole sentences are packed up to this many chars per chunk (~60–70 s of
// audio per synthesis request). Chunk 0 is always the heading line alone
// (chapter number + name announced by themselves — and at ~2 s of audio it
// doubles as the fast start); the first content chunk after it stays small
// so narration flows while the big chunks synthesize.
export const CHUNK_CHARS = 280;
export const FIRST_CHUNK_CHARS = 100;

const ENDERS = "。！？；\n";
const CLOSERS = "」』”’）)】";

// Chapter text → [{ start, chars, text }] where start is the char offset of
// the chunk in `text` (same offsets as the reader's p[data-off] paragraphs)
// and text is the raw slice — clean it with ttsPrompt() before synthesis.
export function chunkChapter(text) {
  const headChunks = [];
  // the heading line (chapter number + name) is its own chunk
  const lead = text.match(/^\s*/)[0].length;
  let bodyStart = lead;
  if (lead < text.length) {
    let nl = text.indexOf("\n", lead);
    if (nl === -1) nl = text.length;
    // absorb blank lines after the heading so the body starts at content
    let end = nl;
    while (end < text.length && !text[end].trim()) end++;
    headChunks.push({ start: lead, end });
    bodyStart = end;
  }

  // sentence spans: split after 。！？；or newline, plus any closing quotes
  const sentences = [];
  let s = bodyStart;
  for (let i = bodyStart; i < text.length; i++) {
    if (ENDERS.includes(text[i])) {
      let e = i + 1;
      while (e < text.length && CLOSERS.includes(text[e])) e++;
      sentences.push([s, e]);
      s = e;
      i = e - 1;
    }
  }
  if (s < text.length) sentences.push([s, text.length]);

  // a "sentence" longer than a whole chunk (no 。！？； for hundreds of
  // chars) would blow past the model's input comfort zone — sub-split it at
  // secondary pauses ，、：, hard-cutting as a last resort
  const spans = sentences.flatMap(([a, b]) =>
    b - a <= CHUNK_CHARS ? [[a, b]] : subSplit(text, a, b),
  );

  const chunks = headChunks;
  let cur = null;
  for (const [a, b] of spans) {
    if (!text.slice(a, b).trim()) {
      // whitespace-only span (blank line): absorb into the current chunk so
      // the next chunk starts at real content
      if (cur) cur.end = b;
      continue;
    }
    // chunk 0 is the heading; the first content chunk stays small
    const limit = chunks.length <= 1 ? FIRST_CHUNK_CHARS : CHUNK_CHARS;
    if (cur && cur.end - cur.start + (b - a) > limit) {
      chunks.push(cur);
      cur = null;
    }
    if (!cur) cur = { start: a, end: b };
    else cur.end = b;
  }
  if (cur) chunks.push(cur);

  return chunks.map((c) => ({
    start: c.start,
    chars: c.end - c.start,
    text: text.slice(c.start, c.end),
  }));
}

const PAUSES = "，、：";

function subSplit(text, a, b) {
  const out = [];
  let s = a;
  for (let i = a; i < b; i++) {
    const atPause = PAUSES.includes(text[i]);
    if ((atPause && i + 1 - s >= CHUNK_CHARS / 2) || i + 1 - s >= CHUNK_CHARS) {
      out.push([s, i + 1]);
      s = i + 1;
    }
  }
  if (s < b) out.push([s, b]);
  return out;
}

// Index of the chunk containing char offset `off` (clamped to valid range).
export function chunkIndexFor(chunks, off) {
  let idx = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].start <= off) idx = i;
    else break;
  }
  return idx;
}

// Raw chunk slice → text sent to the model: collapse newlines and full-width
// indent spaces (paragraph layout, not speech) into single spaces.
export function ttsPrompt(chunkText) {
  return chunkText.replace(/[\s　]+/g, " ").trim();
}
