// Unit test for the offline TTS frontend (public/wasm-tts.mjs pure parts):
// lexicon parsing, greedy longest match with per-char fallback, punctuation
// aliases, AddBlank shape, source-length accounting (position mapping), and
// the PCM helpers. No browser APIs — plain node.
//
//   node scripts/test-wasm-frontend.mjs

import { parseMeloLexicon, lexItems, addBlank, trimTail, mkWav, PAUSE_MS, UNIT_ENDERS, RATE }
  from "../public/wasm-tts.mjs";

const out = {};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// tiny melo-format fixture: word phone… tone… (equal counts)
const TOKS = "_ 0\nn 1\ni 2\nh 3\nao 4\n, 5\n. 6\nma 7\n";
const LEX = "你好 n i h ao 2 2 3 3\n你 n i 2 2\n好 h ao 3 3\n吗 ma 5\n母 ma 3\n恩 n 1\n";
const ld = parseMeloLexicon(TOKS, LEX);

out.parse = ld.lex.get("你好") && ld.tok.get("，") === 5 && ld.tok.get("。") === 6
  ? "ok (word entry, full-width punct aliases)"
  : `FAIL 你好=${JSON.stringify(ld.lex.get("你好"))} ，=${ld.tok.get("，")}`;

// word match beats per-char, punct token stays inside its clause, len sums
// to the full text, only the last item flushes
const items = lexItems("你好，好吗。", ld);
const i0 = items[0], i1 = items[1];
out.items =
  items.length === 2 &&
  eq(i0.ids, addBlank([1, 2, 3, 4, 5])) && eq(i0.tones, addBlank([2, 2, 3, 3, 0])) &&
  i0.punct === "，" && i0.len === 3 && !i0.flush &&
  eq(i1.ids, addBlank([3, 4, 7, 6])) && i1.punct === "。" && i1.len === 3 && i1.flush
    ? "ok (word match, aliases, len, flush)"
    : `FAIL ${JSON.stringify(items)}`;

out.addBlank = eq(addBlank([7]), [0, 7, 0]) && eq(addBlank([]), [0])
  ? "ok" : `FAIL ${JSON.stringify(addBlank([7]))}`;

// 1 s of tone then 1 s of silence → tail cut to 80 ms of the silence
const f32 = new Float32Array(RATE * 2);
for (let i = 0; i < RATE; i++) f32[i] = Math.sin(i / 10) * 0.5;
const trimmed = trimTail(f32, RATE);
out.trimTail = Math.abs(trimmed.length - RATE * 1.08) < RATE * 0.01
  ? "ok (≤80ms tail)" : `FAIL len=${trimmed.length}`;

const wav = mkWav(new Float32Array(100), 16000);
out.mkWav = wav.size === 44 + 200 && wav.type === "audio/wav"
  ? "ok (header + 16-bit)" : `FAIL size=${wav.size}`;

out.pauses = UNIT_ENDERS.includes("。") && PAUSE_MS["，"] === 200 && PAUSE_MS["。"] === 450
  ? "ok" : "FAIL";

console.log(JSON.stringify(out, null, 2));
if (Object.values(out).some((v) => String(v).startsWith("FAIL"))) process.exit(1);
