# Releases

One entry per green deploy — the commits that went live, newest first. Written
by scripts/update-releases.mjs from the deploy workflow; the `released` tag
marks the last deployed commit. Do not edit entries by hand.

The `>` lines are the reader-facing notes, taken from each commit's
`Release-Note:` trailer plus the release's dependency bumps. A release with
none says nothing to readers — which is the intended outcome for a week of
pure CI work.

## 2026-08-17 — `6d3302babe12`

- docs: stop duplicating rules the code already enforces (`6d3302b`)
- docs: record the chain page-turn flake in the CI ledger (`7fe0754`)
- docs: restore six diagnostic clauses the reorganisation dropped (`65f2a9e`)
- docs: reorganise DESIGN.md by subsystem instead of by date (`ecc8417`)
- docs: state the engine split as code behaviour, not an owner ruling (`0c505ba`)
- docs: a green gate still loses the ledger race — merge in one breath (`44c7046`)
- docs: data migrations are one-off dispatch workflows (`809740b`)
- books: progress reads only the index — the R2 fallback is gone (`fe4967b`)

## 2026-08-16 — `4ab04d207384`

- ci: one-off workflow backfills chapter_chars over the reindex api (`4ab04d2`)

## 2026-08-16 — `76dbcf381ed8`

> 修正 app 圖示的未讀數字：打開 app 即歸零，清掉的舊通知不再被重複計入。
> 書櫃載入變快 — 伺服器一趟往返就取回書單與閱讀進度。
> 書櫃底部新增「版本紀錄」，隨時可回看每次更新說了什麼。
> 書櫃不再在網路正常時被誤標成「離線 — 顯示上次看到的書目」。

- docs: branch first — main only takes work through a pr (`76dbcf3`)
- push: opening the app closes the notifications it was told about (`94466b6`)
- books: the shelf list answers in one D1 round trip (`0e15282`)
- shelf: the footer keeps a door to the release notes (`b8d746c`)
- shelf: allow the books fetch 2.5 s before painting the list stale (`a0cbb4e`)
- docs: the agent reads the live testlog with a reader key, not the owner's browser (`afc6b95`)
- docs: record how to read the production testlog and why the badge count lies (`c4cd962`)

## 2026-08-15 — `b9a0c5475077`

> wasmtts v1.2.0 → v1.2.2;修正離線快取缺漏,朗讀參數改隨語音包供給(聽感不變)。
> wasmtts v1.2.0 → v1.2.2

- tts: the playback recipe now lives upstream — synthesis knobs ride the pin (`b9a0c54`)

## 2026-08-15 — `073009919771`

- feat: 接上 wasmtts 台灣讀音 profile — 覆審讀音層進產品聲音 (`0730099`)

## 2026-08-15 — `b99eba055fc6`

- slug: reserve the URL names the app itself routes (`b99eba0`)
- sw: never hand the shell to a navigation the reader cannot route (`d42e8fb`)
- player: offer the voice pack to devices that never held it (`6271507`)
- player: a report button files the sentence under the voice (`acd592a`)
- player: the stale-pack pill re-downloads in place (`a308d77`)
- tts: read the heading's space as a comma, on every engine (`43b7db7`)

## 2026-08-15 — `c1caa9463c54`

> 離線語音升級為 steps-6 聲學模型;開始朗讀時會提示重新下載語音包。
> wasmtts v1.1.0 → v1.2.0

- tts: the voice pack's file list now lives upstream, and the pin moves to v1.2.0 (`c1caa94`)
- docs: write down the off-schedule roll-up runbook (`a85b1bb`)

## 2026-08-15 — `69d852d118c4`

> wasmtts v1.0.2 → v1.1.0

- chore(deps): update weekly upstream roll-up (`69d852d`)
- docs: move session-memory facts into DESIGN.md — memory does not cross machines (`3842c0d`)

## 2026-08-15 — `3266aa5ab2dd`

- test: fetch matcha assets from the pin, never the owner's wasmtts checkout (`3266aa5`)
- docs: record the 吃字 investigation — chain exonerated, acoustic model convicted (`b38a74d`)
- docs: record that the online tts engines are out of service in practice (`9918496`)

## 2026-08-14 — `cd4ec29d7709`

- admin: upload on a 16-wide pool, with retries and pace in the log (`cd4ec29`)

## 2026-08-14 — `4aa67c204f8c`

- admin: show a bar and hold the screen while a delete sweeps (`4aa67c2`)

## 2026-08-14 — `c1d40e71a2d3`

- admin: hold a screen wake lock while an upload runs (`c1d40e7`)

## 2026-08-14 — `ab4c4c10b018`

- admin: an upload run dies whole — abort, retry, and own the bar (`ab4c4c1`)
- docs(runbook): generate the cover when none is found — that is the enrichment (`f93e9af`)
- docs(runbook): spec the generated cover — a designed cover, not an illustration (`6f765d6`)
- docs(runbook): name the zip after the book, demand flat cover art (`b44f1b1`)
- docs: the enrichment runbook an agent can be handed (`eb5cc9c`)

## 2026-08-13 — `c1635f2ac3f5`

- shelf: surface the enrichment author on the 題簽 (`c1635f2`)

## 2026-08-13 — `2a00cd0fdf3c`

- admin: consume the enriched-book.zip contract, exempt its sidecars from repair (`2a00cd0`)

## 2026-08-13 — `267afdb5f2cd`

- shelf: redraw "/" as 書衣 covers on static markup, with a cover-image slot (`267afdb`)

## 2026-08-13 — `57beb350d3f8`

- ci: approve the held pull_request run instead of dispatching the gate (`57beb35`)

## 2026-08-13 — `948e92f4f57e`

- docs: record the expanded main ruleset and merge settings (`948e92f`)

## 2026-08-13 — `6bbd11cb21a3`

- ci: gate merges into main behind a candidate check (`6bbd11c`)

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
