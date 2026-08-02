// Unit test for the offline TTS frontend (public/wasm-tts.mjs pure parts):
// clause splitting for pause control, orphan-punct folding, espeak→model id
// remapping with structural 0/1/2 pass-through and miss counting, and the
// PCM helpers. No browser APIs — plain node.
//
//   node scripts/test-wasm-frontend.mjs

import { clauses, remapIds, trimTail, mkWav, PAUSE_MS, UNIT_ENDERS, RATE }
  from "../public/wasm-tts.mjs";

const out = {};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// clause per mark, the mark stays with its clause, the tail keeps its text
out.clauses = eq(clauses("你好，好嗎。再見"), [
  { text: "你好", punct: "，" },
  { text: "好嗎", punct: "。" },
  { text: "再見", punct: "" },
]) ? "ok (split, punct kept, bare tail)" : `FAIL ${JSON.stringify(clauses("你好，好嗎。再見"))}`;

// a clause that trims to nothing folds its mark into the previous clause
out.orphanPunct = eq(clauses("甲， ，乙"), [
  { text: "甲", punct: "，" },
  { text: "乙", punct: "" },
]) && clauses("甲， ，乙")[0] // fold happened, mark not lost
  ? "ok (orphan mark folds back)" : `FAIL ${JSON.stringify(clauses("甲， ，乙"))}`;

// ids walk the phoneme strings in lockstep; 0/1/2 are structural and consume
// no phoneme; a symbol the model lacks is dropped and counted
const MAP = { a: [40], b: [41] };
out.remap = eq(remapIds(MAP, [1, 90, 91, 2], ["a", "b"]), { ids: [1, 40, 41, 2], miss: 0 })
  && eq(remapIds(MAP, [1, 90, 91, 2], ["a", "zz"]), { ids: [1, 40, 2], miss: 1 })
  ? "ok (lockstep remap, miss counted)"
  : `FAIL ${JSON.stringify(remapIds(MAP, [1, 90, 91, 2], ["a", "zz"]))}`;

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
