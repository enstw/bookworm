// The online voice's login: speech.platform.bing.com answers 403 unless the
// Sec-MS-GEC token is the one Microsoft's own client would send. The v2
// token is a hand-ported hash (src/edge-gec.js), so this pins it to vectors
// printed by the Python reference — edge-tts 7.3.1:
//   uvx --from edge-tts==7.3.1 python -c 'from edge_tts.drm import
//     generate_sec_ms_gec_v2 as g; print(g(1794207974.5))'
// When Microsoft rotates the scheme again, the fix starts upstream: port the
// new drm.py and re-print these.
//
//   node scripts/test-edge-gec.mjs

import { secMsGecV2 } from "../src/edge-gec.js";

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const vectors = {
  0: "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6",
  1700000000: "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
  1794207974.5: "60DAEC531BD8D90A-A1D1B1F1134FE0048A0A8F4918E945AE596378708AA10E9B2FD2C59A4E83CC63",
  // same 5-minute window as the line above: the token only moves every 300 s
  1794208199: "60DAEC531BD8D90A-A1D1B1F1134FE0048A0A8F4918E945AE596378708AA10E9B2FD2C59A4E83CC63",
  2000000000: "2D62557F1142BC5D-FD9C30C68FF194A5EE6B45FEFC5E2BA1D1239F88A90569AB55CFFFAA7799F40E",
};

const out = {};
const fails = [];
for (const [t, want] of Object.entries(vectors)) {
  const got = secMsGecV2(TOKEN, Number(t));
  if (got !== want) fails.push(`${t}: got ${got}, want ${want}`);
}
out.vectors = fails.length ? "FAIL" : `ok (${Object.keys(vectors).length} match edge-tts 7.3.1)`;
out.shape = /^[0-9A-F]{16}-[0-9A-F]{64}$/.test(secMsGecV2(TOKEN)) ? "ok" : "FAIL";

if (fails.length) out.failures = fails;
console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
