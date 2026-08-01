// Web Push from the worker with zero dependencies: VAPID auth (RFC 8292)
// and aes128gcm payload encryption (RFC 8291 + RFC 8188) on WebCrypto.
// Used for 新書上架 notifications — see pushNewBook() in worker.js.
// Verified against the RFC 8291 Appendix A test vector by
// scripts/test-push-crypto.mjs (part of `pnpm test`).

const te = new TextEncoder();

export const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => Uint8Array.from(
    atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0)),
};

function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// The VAPID keypair lives as a private-key JWK in the VAPID_PRIVATE_JWK
// secret; the public key is derived from its x/y so the client's
// applicationServerKey and the JWT's k= can never drift apart.
export function vapidPublicKey(env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  return b64u.enc(cat(new Uint8Array([4]), b64u.dec(jwk.x), b64u.dec(jwk.y)));
}

// Authorization header for one push service origin: ES256 JWT (WebCrypto's
// raw r||s signature is exactly the JWS format) + the public key.
export async function vapidAuth(env, endpoint) {
  const key = await crypto.subtle.importKey(
    "jwk", JSON.parse(env.VAPID_PRIVATE_JWK),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u.enc(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.enc(te.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    // RFC 8292 sub: who to contact about this application server. Push
    // services may use it if our traffic misbehaves. Required — the worker
    // treats a missing VAPID_SUBJECT as push-unconfigured, so an install
    // can never announce itself under someone else's address.
    sub: env.VAPID_SUBJECT,
  })));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, te.encode(head + "." + claims));
  return `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${vapidPublicKey(env)}`;
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

// RFC 8291 encryption: one aes128gcm record, padding delimiter 0x02.
// testKeys/testSalt inject the deterministic values the RFC vector needs;
// production callers omit them and get a fresh ephemeral key + salt.
export async function encryptPayload(plaintext, p256dh, auth, testKeys, testSalt) {
  const uaRaw = b64u.dec(p256dh);
  const ua = await crypto.subtle.importKey(
    "raw", uaRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const as = testKeys ?? await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const asRaw = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: ua }, as.privateKey, 256));
  const ikm = await hkdf(b64u.dec(auth), shared,
    cat(te.encode("WebPush: info\0"), uaRaw, asRaw), 32);
  const salt = testSalt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, aes,
    cat(te.encode(plaintext), new Uint8Array([2]))));
  const header = new Uint8Array(21 + asRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096); // rs — single record
  header[20] = asRaw.length;
  header.set(asRaw, 21);
  return cat(header, record);
}

// POST one encrypted notification; returns {status, detail} — the push
// service's status and the first of whatever it said, because a rejection
// (Apple explains itself in the body) is the only thing that tells the
// difference between "we never sent" and "the phone never showed it".
// 404/410 mean the subscription is gone — the caller drops the row.
export async function sendPush(env, sub, payload) {
  const body = await encryptPayload(JSON.stringify(payload), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuth(env, sub.endpoint),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
      urgency: "normal",
    },
    body,
  });
  return {
    status: res.status,
    detail: (await res.text().catch(() => "")).trim().slice(0, 200),
  };
}
