// bookworm-updater: the second Worker on an instance's account (see
// DESIGN.md). Cron trigger
// only — NO fetch handler, no route — so nothing outside Cloudflare can invoke
// it. It is the one thing on the instance that talks to upstream, and under R4
// it holds no reader secret: its whole configuration is UPSTREAM_URL (this
// ticket) and, from PM-05, the Cloudflare API token that rewrites the reader.
//
// Every check interval it fetches upstream's manifest, writes what it saw to
// updater_status in the shared D1 (the check, PM-04), and then — ARMED only,
// when CF_API_TOKEN is present — decides by policy and installs, verifies and
// rolls back, one at a time (the loop, PM-05/07/15/08). Unarmed, the install
// half returns at once, so a Worker with no token can do nothing worse than
// record a version string; setting the token is the owner's whole opt-in.
//
// The entry module holds only the handler — a Worker's entry may export
// nothing else (workerd rejects a non-handler export) — so the logic and the
// version constant live in ./updater-core.mjs. It imports none of the reader's
// code, so its bundle stays tiny and it does not follow the reader's feature
// work ("it barely changes", the third reason the token lives here).

import { checkOnce, d1Store, runInstall } from "./updater-core.mjs";

export default {
  // The only entry point. No fetch handler exists on purpose: the updater has
  // no callable surface whatsoever, which is what makes the Cloudflare token
  // it holds (PM-05) unreachable from the internet (R1).
  async scheduled(controller, env, ctx) {
    const now = Date.now();
    // armed rides the check so /admin can SHOW whether the owner's arming
    // took (a secret typo is otherwise silent: nothing installs, ever)
    const armed = !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID);
    const res = await checkOnce({ upstreamUrl: env.UPSTREAM_URL, store: d1Store(env), now, armed });
    // install only off a successful check, and only when armed (runInstall
    // returns at once without CF_API_TOKEN)
    if (res.ok) await runInstall({ env, manifest: res.manifest, now });
  },
};
