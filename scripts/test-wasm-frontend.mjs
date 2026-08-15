// Unit test for the offline TTS frontend: the pure parts of
// public/wasm-tts.mjs (sentence segmentation, the WAV header, the override
// table) and of the vendored wasmtts matcha-frontend.js (number and punctuation
// normalisation, lexicon parsing, greedy longest match). No browser APIs and
// no model files — plain node, so it stays in the `pnpm test` chain.
//
// The cases that need the real 1.4 MB lexicon run only when MATCHA_MODEL_DIR
// points at a directory holding matcha-icefall-zh-en's lexicon.txt and
// tokens.txt. That is where golden token-id vectors live, and where the
// traditional-reading table is pinned — see the note above it. Fetch the
// files from the pinned upstream (node_modules/wasmtts/platform/
// upstreams.yaml) into a private cache — the fetch block lives in
// .claude/skills/e2e/SKILL.md. Never point this at a live wasmtts checkout:
// that working folder mutates and vanishes under experiments.
//
//   node scripts/test-wasm-frontend.mjs
//   MATCHA_MODEL_DIR=~/.cache/bookworm-matcha/matcha-icefall-zh-en \
//     node scripts/test-wasm-frontend.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { segments, mkWav, RATE, OVERRIDES, PACK_FILES } from "../public/wasm-tts.mjs";
import "../public/vendor/wasmtts/matcha-frontend.js";
import "../public/vendor/wasmtts/matcha-taiwan-profile.js";

const { createFrontend, normalizeFullWidth, normalizeLocalForms, normalizeNumbers, normalizePunctuation,
        parseLexicon, parseTokens } = globalThis.MatchaFrontend;

// the reviewed reading layer, compiled exactly the way the synth worker does
const review = JSON.parse(readFileSync(new URL("../public/vendor/wasmtts/matcha-g2p-review.json", import.meta.url), "utf8"));
const profileCfg = globalThis.MatchaTaiwanProfile.createConfig(review);

const out = {};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const texts = (p) => segments(p).map((s) => s.text);

// ---- segmentation ---------------------------------------------------------

// one unit per sentence; the mark stays with its sentence
out.split = eq(texts("你好。好嗎？再見"), ["你好。", "好嗎？", "再見"])
  ? "ok (one unit per sentence, mark kept)" : `FAIL ${JSON.stringify(texts("你好。好嗎？再見"))}`;

// a closing bracket belongs to the sentence it closes, never to the next one
out.closers = eq(texts("「你來了。」她說。"), ["「你來了。」", "她說。"])
  ? "ok (closer absorbed)" : `FAIL ${JSON.stringify(texts("「你來了。」她說。"))}`;

// whitespace-only spans say nothing and must not become empty units
out.blank = eq(segments(""), []) && eq(segments("   　  "), [])
  ? "ok (nothing to say)" : `FAIL ${JSON.stringify(segments("   　  "))}`;

// prose with no terminal mark still has to be cut, or first audio waits on a
// paragraph-long synthesis; the cut lands on a secondary pause
const long = "他一路走過長街，穿過市集，越過石橋，繞過廟口，聞著糖炒栗子的香氣，聽著小販的吆喝，看著孩童追逐嬉戲，想起許多年前的那個冬天，也是這樣的一個黃昏，母親牽著他的手走過同樣的路";
const longSegs = segments(long);
const longMax = Math.max(...longSegs.map((s) => s.end - s.start));
out.resplit = longSegs.length > 1 && longMax <= 72 && longSegs.every((s) => /[，、：,;]$/.test(s.text) || s.end === long.length)
  ? `ok (${longSegs.length} units, max ${longMax} ch, cut at pauses)`
  : `FAIL ${longSegs.length} units, max ${longMax}: ${JSON.stringify(texts(long))}`;

// The player turns frac0/frac1 into char offsets, so the spans must be ordered,
// non-overlapping and inside the prompt — otherwise a bookmark lands in the
// wrong paragraph and the reader silently jumps.
const prompt = "第十二章　窗外。他看著窗外，銀行的招牌顯得格外明亮。「你來了。」她說。";
const segs = segments(prompt);
out.spans = segs.every((s, i) => s.start >= 0 && s.end <= prompt.length && s.end > s.start
  && (i === 0 || s.start >= segs[i - 1].end))
  && segs.at(-1).end === prompt.length
  ? `ok (${segs.length} ordered spans tiling ${prompt.length} ch)`
  : `FAIL ${JSON.stringify(segs)}`;

// ---- helpers --------------------------------------------------------------

const wav = mkWav(new Float32Array(100), RATE);
out.mkWav = wav.size === 44 + 200 && wav.type === "audio/wav"
  ? "ok (header + 16-bit)" : `FAIL size=${wav.size}`;

out.rate = RATE === 16000 ? "ok (16 kHz, the model's own rate)" : `FAIL ${RATE}`;

// the pack list is what packReady() gates on and what /wasmtest downloads; a
// typo here silently means "no offline engine, ever"
out.pack = PACK_FILES.length === 8 && PACK_FILES.every((f) => f.name && f.bytes > 0 && f.label)
  ? `ok (8 files, ${(PACK_FILES.reduce((s, f) => s + f.bytes, 0) / 1048576).toFixed(0)} MiB)`
  : `FAIL ${JSON.stringify(PACK_FILES)}`;

// ---- text normalisation (pure, no lexicon) --------------------------------

out.numbers = normalizeNumbers("第12章，日期2026年8月7日，14:30完成25.5%。")
  === "第十二章，日期二零二六年八月七日，十四点三十分完成百分之二十五点五。"
  ? "ok (chapter, date, clock, percent, decimal)"
  : `FAIL ${normalizeNumbers("第12章，日期2026年8月7日，14:30完成25.5%。")}`;

// The four shapes sherpa's rule tables read wrong here, rewritten so the tables
// still do the reading. Digits stay digits in the first three — that is the
// whole point — so the assertions are on the reframing, not on any Chinese.
const LOCAL = [
  ["25.5%的路", "百分之25.5的路"],          // % is in neither lexicon nor tokens
  ["14:30", "14点30分"], ["14:00", "14点"],  // ":" is a token the model speaks
  ["2026-08-07", "2026年8月7日"], ["2026/8/7", "2026年8月7日"],
  ["2026年08月07日", "2026年8月7日"],        // date.fst wants the zeros gone
  ["0912345678", "零九一二三四五六七八"],      // no spelling makes number.fst do this
  ["02-2345-6789", "零二二三四五六七八九"], ["(02)2345-6789", "零二二三四五六七八九"],
  // and what it must leave alone: quantities, short zero-padded runs the tables
  // already read digit by digit, and the separators that are not dates
  ["他有100元", "他有100元"], ["3.14", "3.14"], ["02", "02"], ["007", "007"],
  ["1.05", "1.05"], ["2020-2025年", "2020-2025年"], ["4273-9/8", "4273-9/8"],
  ["5213%4", "5213%4"],                     // % is consumed: it must not fuse 5213 and 4
  ["0415:00", "0415:00"],                   // an hour cannot start mid-number
];
const localDrift = LOCAL.filter(([input, want]) => normalizeLocalForms(input) !== want)
  .map(([input, want]) => `${input} → ${normalizeLocalForms(input)} ≠ ${want}`);
out.localForms = localDrift.length === 0
  ? `ok (${LOCAL.length} cases: percent, clock, date, phone — and what stays put)`
  : `FAIL\n    ${localDrift.join("\n    ")}`;

// Regression: full-width digits used to come out as their code points ("１" →
// "65297") because charCodeAt was not paired with fromCharCode.
out.fullWidth = normalizeFullWidth("１００％") === "100%"
  ? "ok (１００％ → 100%)" : `FAIL ${normalizeFullWidth("１００％")}`;

// Regression, upstream 05b5b35: quote marks used to reach the model as “ ”
// tokens and were audibly pronounced. They must be deleted, not mapped.
const quoted = normalizePunctuation("「清晨」，她說：“你好。” ‘再見。’");
out.quotes = !/[「」『』《》“”‘’"]/.test(quoted)
  ? `ok (stripped → ${quoted})` : `FAIL ${quoted}`;

// ---- lexicon lookup, on a fixture small enough to read --------------------
const FIX_TOKENS = ", 4\n. 5\nni3 10\nhao3 11\nshi4 12\njie4 13\nle4 14\nse4 15\nla1 16\nji1 17\n";
const FIX_LEXICON = "你 ni3\n好 hao3\n你好 ni3 hao3\n世 shi4\n界 jie4\n世界 shi4 jie4\n垃 la1\n圾 ji1\n";
const fix = createFrontend({ lexiconText: FIX_LEXICON, tokensText: FIX_TOKENS });

out.parse = parseLexicon(FIX_LEXICON).lexicon.size === 8 && parseTokens(FIX_TOKENS).size === 10
  ? "ok (first space splits lexicon, last space splits tokens)"
  : `FAIL lex=${parseLexicon(FIX_LEXICON).lexicon.size} tok=${parseTokens(FIX_TOKENS).size}`;

// the whole word wins over its characters — that is the only reason a lexicon
// beats per-char fallback, and what traditional input mostly cannot reach
out.longestMatch = eq(fix.tokensFor("你好世界。").ids, [10, 11, 12, 13, 5])
  ? "ok (word beats char)" : `FAIL ${JSON.stringify(fix.tokensFor("你好世界。").ids)}`;

// an override must beat the lexicon, including a word only reachable per-char
const over = createFrontend({ lexiconText: FIX_LEXICON, tokensText: FIX_TOKENS, pronunciationOverrides: { "垃圾": "le4 se4" } });
out.override = eq(fix.tokensFor("垃圾").ids, [16, 17]) && eq(over.tokensFor("垃圾").ids, [14, 15])
  ? "ok (la1 ji1 → le4 se4)"
  : `FAIL plain=${JSON.stringify(fix.tokensFor("垃圾").ids)} over=${JSON.stringify(over.tokensFor("垃圾").ids)}`;

// prepareText runs three passes over the digits, and the order is the contract:
// normalizeLocalForms reframes, ruleNormalizer (the FST chain, in the engine)
// reads, normalizeNumbers picks up whatever is left. Here the middle pass is a
// spy, so this pins exactly what the real tables get handed.
let handed = "";
const spy = createFrontend({
  lexiconText: FIX_LEXICON, tokensText: FIX_TOKENS,
  ruleNormalizer: (text) => { handed = text; return text; },
});
spy.prepareText("我在14:30看到25.5%和0912-345-678。");
out.ruleHook = handed === "我在14点30分看到百分之25.5和零九一二三四五六七八。"
  ? "ok (pre-pass reframes, hook reads, JS rules mop up)" : `FAIL ${handed}`;

// …and with no tables the JS rules are still the whole reading — which is what
// a device holding a pack cut before the tables existed falls back to.
out.ruleFallback = fix.prepareText("14:30") === "十四点三十分" && fix.prepareText("25.5%") === "百分之二十五点五"
  ? "ok (no tables: the JS number rules read it)"
  : `FAIL ${fix.prepareText("14:30")} / ${fix.prepareText("25.5%")}`;

// Regression, phone A/B 2026-08-08: the colon token (id 3) is VOCALIZED by the
// acoustic model — ~0.25 s of voiced sound per colon, stacking linearly, never
// a pause. A prose colon must therefore leave normalizePunctuation as a comma,
// and full-width 14：30 must reach the time rules exactly like its half-width
// twin instead of falling through to that artifact plus two loose numbers.
out.colon = fix.prepareText("他說：你好。") === "他說,你好."
  && fix.prepareText("14：30") === "十四点三十分"
  ? "ok (prose : reads as the comma pause; 14：30 folds to the time rule)"
  : `FAIL ${fix.prepareText("他說：你好。")} / ${fix.prepareText("14：30")}`;

// One unknown glyph must never stop a book — the engine passes allowUnknown.
let threw = false;
try { fix.tokensFor("Z"); } catch { threw = true; }
const lenient = fix.tokensFor("你Z好", { allowUnknown: true });
out.unknown = threw && lenient.unknown.length === 1 && eq(lenient.ids, [10, 11])
  ? "ok (throws by default, drops and counts when allowed)"
  : `FAIL threw=${threw} ${JSON.stringify(lenient)}`;

// every shipped override must be a real phone list, or it fails at synthesis
out.overrides = Object.entries(OVERRIDES).every(([w, p]) => w.length && /^[a-z]+[1-5]( [a-z]+[1-5])*$/.test(p))
  ? `ok (${Object.keys(OVERRIDES).length} local entr${Object.keys(OVERRIDES).length === 1 ? "y" : "ies"} — the reviewed layer is the profile)`
  : `FAIL ${JSON.stringify(OVERRIDES)}`;

// the taiwan profile the worker applies: its shape is pinned here so a review
// ledger that compiles to nothing (a schema drift, a renamed profile) fails in
// node instead of shipping a silently un-reviewed voice. 垃圾 → le4 se4 is the
// profile's own base entry — the first local override to graduate upstream.
out.profile = Object.keys(profileCfg.pronunciationOverrides).length >= 100
  && profileCfg.contextualRules.length >= 10
  && eq(profileCfg.pronunciationOverrides["覺得"], ["jue2", "de5"])
  && eq(profileCfg.pronunciationOverrides["垃圾"], ["le4", "se4"])
  && profileCfg.contextualRules.some((r) => r.pattern === "著")
  ? `ok (${Object.keys(profileCfg.pronunciationOverrides).length} words, ${profileCfg.contextualRules.length} contextual rules)`
  : `FAIL words=${Object.keys(profileCfg.pronunciationOverrides).length} rules=${profileCfg.contextualRules.length}`;

// ---- with the real lexicon ------------------------------------------------
const dir = process.env.MATCHA_MODEL_DIR;
if (!dir) {
  out.golden = "skipped (set MATCHA_MODEL_DIR to run)";
  out.traditional = "skipped (set MATCHA_MODEL_DIR to run)";
} else {
  // the worker's exact recipe: profile under local OVERRIDES, rules alongside
  const real = createFrontend({
    lexiconText: readFileSync(join(dir, "lexicon.txt"), "utf8"),
    tokensText: readFileSync(join(dir, "tokens.txt"), "utf8"),
    pronunciationOverrides: { ...profileCfg.pronunciationOverrides, ...OVERRIDES },
    contextualRules: profileCfg.contextualRules,
  });

  // Byte-identical to sherpa-onnx 1.13.4's ids for the same text. Simplified
  // on purpose: upstream's traditional vector only holds with OpenCC, and this
  // engine has no conversion step.
  const ids = real.tokensFor("清晨的阳光穿过窗帘。").ids;
  out.golden = eq(ids, [1431, 292, 420, 1932, 661, 331, 679, 336, 992, 5])
    ? "ok (matches sherpa-onnx)" : `FAIL ${JSON.stringify(ids)}`;

  out.numbersReal = real.tokensFor("第12章，日期2026年8月7日，14:30完成25.5%。").unknown.length === 0
    ? "ok (no unknown from digits)" : "FAIL";

  out.packOverride = eq(real.tokensFor("垃圾。").phones, ["le4", "se4", "."])
    ? "ok (垃圾 → le4 se4, via the profile's base entry)"
    : `FAIL ${JSON.stringify(real.tokensFor("垃圾。").phones)}`;

  // 簡繁直輸 has a known, accepted cost: the multi-char entries are
  // overwhelmingly simplified, so traditional prose falls through to per-char
  // readings. This table PINS THE CURRENT ANSWERS on purpose — the 2026-08-15
  // taiwan-profile adoption flipped 著/乾/得 to the reviewed readings, and the
  // lines still marked "want" are the accepted defects the review has not
  // reached yet. When it does, flip the line; this test proves the fix landed.
  const TRADITIONAL = [
    ["他看著窗外", ["ta1", "kan4", "zhe5", "chuang1", "wai4"]],    // profile contextual rule
    ["銀行", ["yin2", "xing2"]],                                   // want yin2 hang2
    ["會計", ["hui4", "ji4"]],                                     // want kuai4 ji4
    ["乾淨", ["gan1", "jing4"]],                                   // profile contextual rule
    ["顯得", ["xian3", "de5"]],                                    // profile phrase override
    // and a spread of the profile's own corrections, one per rule family
    ["覺得", ["jue2", "de5"]],                                     // 得 neutral tone
    ["睡著了", ["shui4", "zhao2", "le5"]],                         // 著 zhao2 after 睡
    ["長劍", ["chang2", "jian4"]],                                 // 長 chang2 before 劍
    ["還給他", ["huan2", "gei3", "ta1"]],                          // 還 huan2 before 給
  ];
  const drift = TRADITIONAL.filter(([t, want]) => !eq(real.tokensFor(t).phones, want))
    .map(([t, want]) => `${t}: ${JSON.stringify(real.tokensFor(t).phones)} ≠ ${JSON.stringify(want)}`);
  out.traditional = drift.length === 0
    ? `ok (${TRADITIONAL.length} readings pinned — profile fixes in, 銀行/會計 stay the accepted defects)`
    : `FAIL — reading changed, update the profile/OVERRIDES and this table together:\n    ${drift.join("\n    ")}`;
}

console.log(JSON.stringify(out, null, 2));
if (Object.values(out).some((v) => String(v).startsWith("FAIL"))) process.exit(1);
