---
name: install
description: Install Bookworm into the user's own Cloudflare account — fork, secrets, first deploy, first reader key, first book. Use when asked to "install", "deploy", "set up" or "self-host" Bookworm, or when a fresh fork has never been deployed. The full runbook is INSTALLATION.md; this skill only adds how to run it as an agent inside this session.
user-invocable: true
---

# Installing Bookworm

The runbook is [INSTALLATION.md](../../../INSTALLATION.md) (中文；English mirror:
[INSTALLATION.en.md](../../../INSTALLATION.en.md)). Follow its install steps 1–7
in order — every step states its expected result, and the manual, not this
skill, is the source of truth. What follows is only how to run it well from
inside a Claude Code session.

## Session conduct

- Steps marked 🧑 are the human's: creating the Cloudflare token, opening the
  key link on the phone. Do them last-responsibly — set everything up, then
  hand the human one short list of exactly what to do, not a drip of asks.
- Secrets never enter the conversation if the human types them: suggest they
  run `! gh secret set CLOUDFLARE_API_TOKEN --repo "$FORK"` themselves (the
  `!` prefix runs it in-session) and paste the value at the prompt. The
  `ADMIN_TOKEN` you mint must be shown to them exactly once, for the password
  manager, before it goes into `gh secret set`.
- On a mismatch with an expected result, stop and use the manual's
  Troubleshooting table; do not retry a failing step blind, and do not
  substitute `wrangler deploy` for the Actions path.
- Finish by reporting: the live `$URL`, the `/admin` address, the sign-in
  link `$URL/?key=…` still to be opened on the device, and which 🧑 steps
  remain.
