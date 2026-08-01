// Push crypto tests, no network: (1) the RFC 8291 Appendix A vector must
// reproduce BYTE-EXACTLY through src/push.js encryptPayload; (2) a fresh
// round-trip decrypted by an independent receiver-side implementation;
// (3) the VAPID Authorization header must verify and carry the right
// claims. Node's global WebCrypto is the same API the worker runs on.
import { encryptPayload, vapidAuth, vapidPublicKey, b64u } from "../src/push.js";

const te = new TextEncoder();
const td = new TextDecoder();
const out = {};
const cat = (...ps) => {
  const o = new Uint8Array(ps.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of ps) { o.set(p, i); i += p.length; }
  return o;
};
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

// --- 1. RFC 8291 Appendix A ---
{
  const V = {
    plaintext: "When I grow up, I want to be a watermelon",
    asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
    salt: "DGv6ra1nlYgDCS1FRnbzlw",
    body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  };
  const asPub = b64u.dec(V.asPublic);
  const jwk = {
    kty: "EC", crv: "P-256", d: V.asPrivate,
    x: b64u.enc(asPub.slice(1, 33)), y: b64u.enc(asPub.slice(33, 65)), ext: true,
  };
  const asKeys = {
    privateKey: await crypto.subtle.importKey("jwk", jwk,
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", asPub,
      { name: "ECDH", namedCurve: "P-256" }, true, []),
  };
  const got = b64u.enc(await encryptPayload(
    V.plaintext, V.uaPublic, V.auth, asKeys, b64u.dec(V.salt)));
  out.rfc8291Vector = got === V.body ? "ok (byte-exact)" : `FAIL got ${got}`;
}

// --- 2. round-trip with an independent receiver ---
{
  const ua = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const uaRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const msg = JSON.stringify({ title: "新書上架", body: "三國演義", url: "/" });
  const body = await encryptPayload(msg, b64u.enc(uaRaw), b64u.enc(auth));
  // receiver side, straight from RFC 8291/8188
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asRaw = body.slice(21, 21 + idlen);
  const record = body.slice(21 + idlen);
  const asPub = await crypto.subtle.importKey("raw", asRaw,
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: asPub }, ua.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(te.encode("WebPush: info\0"), uaRaw, asRaw), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce }, aes, record));
  const okPad = plain[plain.length - 1] === 2;
  const text = td.decode(plain.slice(0, -1));
  out.roundTrip = okPad && text === msg && rs === 4096 && idlen === 65
    ? "ok" : `FAIL pad=${okPad} rs=${rs} idlen=${idlen} text=${text}`;
}

// --- 3. VAPID header verifies and claims are right ---
{
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const env = {
    VAPID_PRIVATE_JWK: JSON.stringify(jwk),
    VAPID_SUBJECT: "mailto:ops@example.test",   // a self-hosted install's own contact
  };
  const header = await vapidAuth(env, "https://web.push.apple.com/QOX9nq31");
  const m = header.match(/^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/);
  const [h, c, s] = m[1].split(".");
  const claims = JSON.parse(td.decode(b64u.dec(c)));
  const okSig = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, pair.publicKey,
    b64u.dec(s), te.encode(h + "." + c));
  const pub = b64u.dec(vapidPublicKey(env));
  out.vapid = okSig &&
    claims.aud === "https://web.push.apple.com" &&
    claims.sub === "mailto:ops@example.test" &&
    claims.exp > Date.now() / 1000 + 3600 &&
    m[2] === b64u.enc(pub) && pub.length === 65 && pub[0] === 4
    ? "ok (signature verifies, aud/sub/exp/k correct)"
    : `FAIL sig=${okSig} claims=${JSON.stringify(claims)}`;
}

console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
