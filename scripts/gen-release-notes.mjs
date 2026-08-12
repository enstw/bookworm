#!/usr/bin/env node
// Write public/releases.json — the reader-facing notes, shipped WITH the build
// they describe.
//
// Ordering is the whole reason this is a separate script from
// update-releases.mjs. The ledger is written after a green deploy (a failed
// deploy must not claim a release), but a file the deploy uploads has to exist
// before it — so the pending release's notes are computed here, before
// deploy.sh, and the ledger records the same computation afterwards. Both call
// release-notes.mjs, so they cannot disagree.
//
// Gitignored like public/vendor/: it is a build product, and a dev run that
// never generates one simply 404s, which the reader treats as "no notes".
//
// Entries with no notes are dropped rather than shipped empty — a reader is
// never shown a release that had nothing to say to them, and the client can
// tell "nothing to report" from "not deployed yet" without a special case.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerHistory, pendingRelease, root } from "./release-notes.mjs";

const KEEP = 20; // enough for a device that skipped months of updates

const pending = pendingRelease();
// The ledger's newest entry is the PREVIOUS release; the pending one is not in
// it yet (that write happens after the deploy this file is being made for).
const entries = [
  ...(pending.empty ? [] : [{ build: pending.build, date: pending.date, notes: pending.notes }]),
  ...ledgerHistory(),
]
  .filter((e) => e.notes.length > 0)
  .slice(0, KEEP);

const out = join(root, "public", "releases.json");
writeFileSync(out, JSON.stringify({ releases: entries }) + "\n");
console.log(
  `✓ public/releases.json: ${entries.length} release(s) with notes` +
  (pending.empty ? "" : `, newest ${pending.build} (${pending.notes.length} note(s))`),
);
