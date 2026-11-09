// Sec-MS-GEC v2 — the token speech.platform.bing.com demands since Microsoft
// retired the plain SHA-256 one (v1 started answering 403 in November 2026).
// A line-for-line port of drm.py in the edge-tts Python package (7.3.1):
// "<CS64 hex16>-<SHA-256 hex64>" over "<windows ticks floored to 5 min><token>".
// The SHA-256 is standard, but over a secret 57-byte prefix that upstream
// ships pre-folded into the constants below (first-block state after 14
// rounds, schedule contributions, adjusted K[14] and sigma terms) — so it is
// not crypto.subtle's digest of anything we can name. CS64 is the second
// half, keyed by that digest. Constants are copied verbatim; a mismatch
// shows up as a 403, so `scripts/test-edge-gec.mjs` pins vectors produced by
// the Python reference. All arithmetic is mod 2^32 on Numbers (`>>> 0`,
// `Math.imul`), every intermediate staying under 2^53.

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0,
  0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const K_BLOCK = [...K.slice(0, 14), SHA256_ADJUSTMENT, ...K.slice(15)];
const SIGMA0_ADJUSTMENT = 0x059c0b80;
const SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf], [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb], [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
const rol16 = (x) => rotr(x >>> 0, 16);
const mul = (a, b) => Math.imul(a, b) >>> 0;
const sigma0 = (x) => (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
const sigma1 = (x) => (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;
const readBE = (b, o, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[o + i]; return v; };

function expand(w, from = 16) {
  for (let i = from; i < 64; i++) {
    w[i] = (sigma1(w[i - 2]) + w[i - 7] + sigma0(w[i - 15]) + w[i - 16]) >>> 0;
  }
}

// standard SHA-256 rounds, resumable inside the first block (round 14 on)
function rounds(state, w, first = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const k = first === 14 ? K_BLOCK : K;
  for (let i = first; i < 64; i++) {
    const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((g ^ (e & (f ^ g))) >>> 0) + k[i] + w[i]) >>> 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0) + (((a & b) | (c & (a | b))) >>> 0);
    h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

// state after the first block: the secret prefix's 57 bytes + data[0..7)
function sha256Init(head) {
  const w = new Array(14).fill(0);
  w.push(readBE(head, 0, 3), readBE(head, 3, 4));
  for (let i = 16; i < 30; i++) {
    let v = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) v += i === 16 ? (sigma1(w[i - 2]) ^ SIGMA1_ADJUSTMENT) >>> 0 : sigma1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? (sigma0(w[i - 15]) ^ SIGMA0_ADJUSTMENT) >>> 0 : sigma0(w[i - 15]);
    w.push(v >>> 0);
  }
  w.push((sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + SHA256_ADJUSTMENT - K[14]) >>> 0);
  expand(w, 31);
  const working = rounds(SHA256_STATE, w, 14);
  return SHA256_INITIAL.map((x, i) => (x + working[i]) >>> 0);
}

function sha256Digest(data) {
  const length = 57 + data.length;
  const tail = data.subarray(7);
  const padLen = (((55 - length) % 64) + 64) % 64;
  const padded = new Uint8Array(tail.length + 1 + padLen + 8);
  padded.set(tail);
  padded[tail.length] = 0x80;
  const bits = length * 8;
  const end = padded.length;
  padded[end - 4] = (bits >>> 24) & 255; padded[end - 3] = (bits >>> 16) & 255;
  padded[end - 2] = (bits >>> 8) & 255; padded[end - 1] = bits & 255;
  let state = sha256Init(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const w = [];
    for (let i = 0; i < 16; i++) w.push(readBE(padded, off + i * 4, 4));
    expand(w);
    const working = rounds(state, w);
    state = state.map((x, i) => (x + working[i]) >>> 0);
  }
  const out = new Uint8Array(32);
  state.forEach((x, i) => { out[i * 4] = x >>> 24; out[i * 4 + 1] = (x >>> 16) & 255; out[i * 4 + 2] = (x >>> 8) & 255; out[i * 4 + 3] = x & 255; });
  return out;
}

function cs64Digest(data, digest) {
  const le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const keyA = (le(digest, 0) | 1) >>> 0;
  const keyB = (le(digest, 4) | 1) >>> 0;
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];
  const terms = CS64_COEFFICIENTS.map(([c], i) => mul(c, factors[i % 2]));
  const offsets = CS64_COEFFICIENTS.map(([, o]) => o);
  // b"\x00" + data as little-endian words, zero-padded to an even count
  const bytes = new Uint8Array(Math.ceil((data.length + 1) / 8) * 8);
  bytes.set(data, 1);
  const nWords = Math.ceil((data.length + 1) / 4);
  for (let i = 0; i < nWords + (nWords % 2); i++) {
    const word = le(bytes, i * 4);
    let term = mul(word, i % 2 === 0 ? keyA : keyB);
    let offset = mul(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term = (term + mul(CS64_ADJUSTMENT0, factors[0])) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  }
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offsets[i] + x) >>> 0);
    let q = mul(t, 0x76f50f34);
    swapAcc = (swapAcc + ((mul(rol16(q), 0xc3efea97) + q) >>> 0)) >>> 0;
    t = rol16((offsets[i + 1] + y) >>> 0);
    q = mul(t, 0x1881ce3c);
    swapLast = (mul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (mul(state, keyA) + x) >>> 0;
    state = mul(rol16(state), 0xcf98b111);
    state = mul(rol16(state), 0x87085b9f);
    state = mul(rol16(state), 0x12ceb96d);
    state = mul(rol16(state), 0x257e1d83);
    acc = (acc + state) >>> 0;
    t = (mul(state, keyB) + y) >>> 0;
    t = mul(rol16(t), 0xa27416f5);
    t = mul(rol16(t), 0xd38396ff);
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = (acc + state) >>> 0;
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
const leHex = (x) => hex([x & 255, (x >>> 8) & 255, (x >>> 16) & 255, x >>> 24]);

// The tick count deliberately goes through double-precision multiplication
// (ticks * 1e7 overflows 2^53): the server validates against the original
// Edge JS client's rounding, and the Python reference mimics it the same way.
// BigInt(double) then prints that double's exact integer value.
export function secMsGecV2(token, unixSeconds = Date.now() / 1000) {
  const unix = Math.floor(unixSeconds);
  const ticks = (unix - (unix % 300) + 11644473600) * 10_000_000;
  const data = new TextEncoder().encode(`${BigInt(ticks)}${token}`);
  const digest = sha256Digest(data);
  const [lo, hi] = cs64Digest(data, digest);
  return `${leHex(lo)}${leHex(hi)}-${hex(digest)}`;
}
