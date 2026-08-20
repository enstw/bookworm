// bookworm-updater: the second Worker on an instance's account (see
// docs/pull-mode-updates.md, "What an instance looks like"). Cron trigger
// only — NO fetch handler, no route — so nothing outside Cloudflare can invoke
// it. It is the one thing on the instance that talks to upstream, and under R4
// it holds no reader secret: its whole configuration is UPSTREAM_URL (this
// ticket) and, from PM-05, the Cloudflare API token that rewrites the reader.
//
// PM-04 is the split itself plus the read-only half of the cron: every check
// interval it fetches upstream's manifest and writes what it saw to
// updater_status in the shared D1, where /admin will read it (PM-08). It
// installs nothing — the upload path, the token, and the panel are later
// tickets. Keeping the risky half out means this Worker, deployed to the
// canary account today, can do nothing worse than record a version string.
//
// The entry module holds only the handler — a Worker's entry may export
// nothing else (workerd rejects a non-handler export) — so the logic and the
// version constant live in ./updater-core.mjs. It imports none of the reader's
// code, so its bundle stays tiny and it does not follow the reader's feature
// work ("it barely changes", the third reason the token lives here).

import { checkOnce, d1Store } from "./updater-core.mjs";

export default {
  // The only entry point. No fetch handler exists on purpose: the updater has
  // no callable surface whatsoever, which is what makes the Cloudflare token
  // it will hold (PM-05) unreachable from the internet (R1).
  async scheduled(controller, env, ctx) {
    await checkOnce({ upstreamUrl: env.UPSTREAM_URL, store: d1Store(env), now: Date.now() });
  },
};
