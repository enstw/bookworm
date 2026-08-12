# Releases

One entry per green deploy — the commits that went live, newest first. Written
by scripts/update-releases.mjs from the deploy workflow; the `released` tag
marks the last deployed commit. Do not edit entries by hand.

The `>` lines are the reader-facing notes, taken from each commit's
`Release-Note:` trailer plus the release's dependency bumps. A release with
none says nothing to readers — which is the intended outcome for a week of
pure CI work.

## 2026-08-13 — `29755dac2ecc`

- ci: strip the write token from the deploy test job (`29755da`)

## 2026-08-13 — `447beaa1f264`

> wasmtts v1.0.0 → v1.0.2

- chore(deps): update dependency wasmtts to v1.0.2 (`447beaa`)

## 2026-08-13 — `1e860a35d7dc`

- ci: pin renovate, split the roll-up merge behind a fail-closed verifier (`1e860a3`)

## 2026-08-12 — `5e9ae86e9073`

- testlog: require an admin cookie to write, and a quota per page (#16) (`5e9ae86`)
- docs: require Actions to be pinned to a commit digest (`1a3d8cd`)

## 2026-08-12 — `0081b255834e`

> 更新提示多了「有什麼新的」，可以看這次到底改了什麼

- ci: untrack public/releases.json, autostash the ledger rebase (`0081b25`)
- reader: tell readers what shipped, in a sentence someone wrote (`14eeb1d`)

## 2026-08-12 — `cfd7fea8555b`

- admin: a switch for this device's diagnostic uploads (`cfd7fea`)

## 2026-08-12 — `d0cb32b6ea7e`

- admin: fold the panels, one screen instead of two (`d0cb32b`)

## 2026-08-12 — `0b90b03a019c`

- reader: pull the bookmark again in the background (`0b90b03`)

## 2026-08-12 — `0fb2bd094ff9`

- ci: pin every action to a commit digest (`0fb2bd0`)

## 2026-08-12 — `e9a5ed877b2f`

- ci: pin the released tag to the deployed commit, backfill the roll-up entry (`e9a5ed8`)

## 2026-08-12 — `61da4bb06cb0`

- chore(deps): update weekly upstream roll-up (`61da4bb`)

## 2026-08-12 — `21dbf5e67a19`

- ci: decide wasmtts builds in allowBuilds before the v1.0.0 roll-up (`21dbf5e`)

## 2026-08-11 — `32b40054231a`

- ci: fold majors into the weekly roll-up, source CVE alerts from osv.dev (`32b4005`)

## 2026-08-11 — `941bbe45175a`

- reader: start data-off at the first visible char so the tts wash lands on the spoken sentence (`941bbe4`)
