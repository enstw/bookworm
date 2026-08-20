// Generates the committed PWA icons from artwork/icon-source.png.
//
// The source artwork is Bookworm's green library dragon, generated with the
// imagegen skill to echo .github/banner.png. Keep the source file so a future
// resize never falls back to the platform-dependent 📖 emoji this script used
// to render through Chromium. It lives OUTSIDE public/ on purpose: nothing
// fetches it, and at 2.9 MB it was a quarter of every deploy's upload and of
// the release artifact (package-release.mjs). Moved rather than listed in an
// .assetsignore, because wrangler serves the directory wholesale and an
// ignore file would put the exclusion in two places that drift.
//
// Requires ffmpeg (already needed by the TTS streaming test):
//
//   pnpm exec node scripts/make-icons.mjs

import { existsSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "icons");
const SOURCE = join(ROOT, "artwork", "icon-source.png");

if (!existsSync(SOURCE)) {
  console.error(`missing source artwork: ${SOURCE}`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

for (const size of [180, 192, 512]) {
  const out = join(OUT, `icon-${size}.png`);
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", SOURCE,
      "-vf", `scale=${size}:${size}:flags=lanczos`,
      "-frames:v", "1",
      out,
    ],
    { stdio: "pipe" },
  );
  const ok = result.status === 0 && existsSync(out) && statSync(out).size > 5000;
  console.log(`${out}: ${ok ? statSync(out).size + " bytes" : "FAILED"}`);
  if (!ok) {
    if (result.stderr?.length) process.stderr.write(result.stderr);
    process.exit(1);
  }
}

// ---------- mark.png: the same dragon with the parchment cut away ----------
//
// The icons above keep their background, because a home-screen tile wants an
// opaque square. The inline mark does not: it stands where the 📖 emoji used
// to, beside text in a page heading and in the reader toolbar, and there it
// must not drag a cream card along with it. The source artwork has no alpha
// (rgb24, an opaque #e6bb68 parchment), so the background is cut here.
//
// It is cut by flood-filling INWARD FROM THE BORDER, not by keying on the
// parchment's colour. The gold horns and the cream book pages sit in the same
// tonal family as the parchment — a colour key eats them. Only connectivity
// tells them apart: the background is what touches the frame, and the pages
// and horns are interior. The fill also clears the cream notches between the
// wing spikes, which a circular mask would leave behind.
const MARK = 192;   // shown at ~28 px, so this is 2–3x headroom; matches the set
const WORK = 1024;  // fill at this size, then downsample — see below
// RGB distance from the mean border colour. The fill plateaus from about 75
// up (it keeps 45.5% of the frame at 75 and 45.2% at 95, i.e. there is no
// artwork in the colour band next to the background), so this is comfortably
// past the cream fringe and nowhere near biting into the dragon.
const TOL = 75;

const ff = (args, input) => spawnSync("ffmpeg",
  ["-hide_banner", "-loglevel", "error", "-y", ...args],
  { stdio: "pipe", input, maxBuffer: 1 << 28 });

// Work at a fixed size so no image-dimension probe is needed. Filling at WORK
// and shrinking afterwards is what makes the edge smooth: the fill itself is
// binary (a pixel is background or it is not), and it is the downsample that
// turns that hard boundary into an anti-aliased alpha ramp.
const decoded = ff(["-i", SOURCE, "-vf", `scale=${WORK}:${WORK}:flags=lanczos`,
  "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
if (decoded.status !== 0) {
  process.stderr.write(decoded.stderr);
  process.exit(1);
}
const rgb = decoded.stdout;

// the parchment reference: the mean of the frame's outermost ring
let mr = 0, mg = 0, mb = 0, seen = 0;
const add = (x, y) => {
  const i = (y * WORK + x) * 3;
  mr += rgb[i]; mg += rgb[i + 1]; mb += rgb[i + 2]; seen++;
};
for (let x = 0; x < WORK; x++) { add(x, 0); add(x, WORK - 1); }
for (let y = 0; y < WORK; y++) { add(0, y); add(WORK - 1, y); }
mr /= seen; mg /= seen; mb /= seen;

const bg = new Uint8Array(WORK * WORK);
const stack = [];
const push = (x, y) => {
  const p = y * WORK + x;
  if (bg[p]) return;
  const i = p * 3, dr = rgb[i] - mr, dg = rgb[i + 1] - mg, db = rgb[i + 2] - mb;
  if (dr * dr + dg * dg + db * db > TOL * TOL) return;
  bg[p] = 1;
  stack.push(p);
};
for (let x = 0; x < WORK; x++) { push(x, 0); push(x, WORK - 1); }
for (let y = 0; y < WORK; y++) { push(0, y); push(WORK - 1, y); }
while (stack.length) {
  const p = stack.pop(), x = p % WORK, y = (p / WORK) | 0;
  if (x > 0) push(x - 1, y);
  if (x < WORK - 1) push(x + 1, y);
  if (y > 0) push(x, y - 1);
  if (y < WORK - 1) push(x, y + 1);
}

// Alpha-WEIGHTED box downsample. Averaging straight RGBA would mix the cream
// still sitting in the now-transparent pixels back into the edge and ring the
// mark with a halo; weighting colour by alpha is what keeps the edge clean.
const step = WORK / MARK;
const mark = Buffer.alloc(MARK * MARK * 4);
for (let oy = 0; oy < MARK; oy++) {
  for (let ox = 0; ox < MARK; ox++) {
    const x1 = Math.min(WORK, Math.ceil((ox + 1) * step));
    const y1 = Math.min(WORK, Math.ceil((oy + 1) * step));
    let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
    for (let y = Math.floor(oy * step); y < y1; y++) {
      for (let x = Math.floor(ox * step); x < x1; x++) {
        const p = y * WORK + x, i = p * 3, a = bg[p] ? 0 : 1;
        sr += rgb[i] * a; sg += rgb[i + 1] * a; sb += rgb[i + 2] * a;
        sa += a; n++;
      }
    }
    const o = (oy * MARK + ox) * 4;
    mark[o] = sa ? sr / sa : 0;
    mark[o + 1] = sa ? sg / sa : 0;
    mark[o + 2] = sa ? sb / sa : 0;
    mark[o + 3] = Math.round((sa / n) * 255);
  }
}

const markOut = join(OUT, "mark.png");
const encoded = ff(["-f", "rawvideo", "-pix_fmt", "rgba",
  "-s", `${MARK}x${MARK}`, "-i", "-", markOut], mark);
const markOk = encoded.status === 0 && existsSync(markOut) && statSync(markOut).size > 5000;
const kept = (bg.reduce((a, c) => a + (c ? 0 : 1), 0) / (WORK * WORK) * 100).toFixed(1);
console.log(`${markOut}: ${markOk ? `${statSync(markOut).size} bytes, ${kept}% opaque` : "FAILED"}`);
if (!markOk) {
  if (encoded.stderr?.length) process.stderr.write(encoded.stderr);
  process.exit(1);
}
