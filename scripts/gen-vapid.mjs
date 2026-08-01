// Generate the VAPID keypair for Web Push (新書通知). Prints the private
// JWK to put in VAPID_PRIVATE_JWK (repo secret + .deploy.env) and the
// public key for reference — the worker derives the public key from the
// JWK at runtime, so there is nothing else to keep in sync.
//
//   node scripts/gen-vapid.mjs
//
// Rotating the key invalidates every existing subscription (each device
// re-subscribes on its next 訂閱 tap): DELETE FROM push_subs after a swap.

const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const b64u = (b) => btoa(String.fromCharCode(...b))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log("VAPID_PRIVATE_JWK=" + JSON.stringify({
  kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y, ext: true,
}));
console.log("\npublic key (applicationServerKey, served by /api/push/vapid):");
console.log(b64u(raw));
