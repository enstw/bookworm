// Run the bootstrap from a clone (PM-10). Same command the published,
// self-contained bootstrap.mjs runs — the only difference is where the payload
// comes from: this rebuilds it from the tree (schema.sql + a wrangler dry-run of
// the updater), the published file bakes it in.
//
//   CF_API_TOKEN=…  CF_ACCOUNT_ID=…  UPSTREAM_URL=…/releases/latest/download/  \
//   node scripts/bootstrap-cli.mjs
//
// Most owners never see this: they run the one file attached to the release.
// This exists so the repo's own bootstrap is testable and so a clone is never a
// second, diverging path.

import { runBootstrap, payloadFromTree } from "./bootstrap.mjs";

await runBootstrap(payloadFromTree());
