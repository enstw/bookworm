# 安全性回報

## 怎麼回報

請走 GitHub 的私下回報管道：**[Security → Report a vulnerability](https://github.com/enstw/bookworm/security/advisories/new)**。
這條路徑只有維護者看得到，可以放心寫細節。

**請不要開公開 issue 或 PR 描述漏洞**，也不要在討論串裡貼可直接利用的步驟——
Bookworm 的每個 fork 都是別人正在讀書的伺服器，公開細節等於同時通知了所有人。

回報時有這些會很有幫助：受影響的檔案或路徑、重現步驟、你認為的影響範圍，以及你
測試的版本（commit SHA 或部署時間）。

## 你會等到什麼

這是一人維護的專案，沒有 24 小時輪值，也沒有獎金。實際能承諾的是：

- 一週內回覆確認收到。
- 確認成立後，修補會走跟其他變更一樣的路徑——PR、`candidate-gate`、部署——並在
  修好後發 GitHub Security Advisory。
- 你可以決定要不要具名致謝。

只有 `main` 的最新版本會收到修補。這裡沒有維護中的舊版分支：自架的 fork 請跟上
`main`。

## 範圍

**算在範圍內**：這個 repository 裡的程式碼——Worker、閱讀前端、`/admin`、部署與
GitHub Actions workflow、以及會影響 reader key、`ADMIN_TOKEN`、書籍內容或閱讀進度
的任何問題。

**不算在範圍內**：

- 對別人的 Bookworm 實例做未經授權的測試。要驗證請自己開一份 fork。
- 自架時的設定失誤，例如把 `ADMIN_TOKEN` 貼到公開的地方、或把 reader key 給了不
  該給的人。[INSTALLATION.md](./INSTALLATION.md) 是設定的依據。
- Cloudflare 平台本身的問題（請回報 Cloudflare）。
- 上游相依套件的已知漏洞——Renovate 與 Dependabot 已經在追；如果你認為某個漏洞在
  Bookworm 裡真的可被利用，那就值得回報。

## 自架的人請注意

`ADMIN_TOKEN` 等於整座書架的鑰匙，reader key 等於一位讀者的門票。懷疑外洩時，前者
重新部署換掉，後者在 `/admin` 撤銷——撤銷只擋伺服器，已經離線快取的章節仍讀得到，
這是刻意的設計。

---

# Security Policy (English)

**Reporting:** use GitHub's private channel —
[Security → Report a vulnerability](https://github.com/enstw/bookworm/security/advisories/new).
Please do not open a public issue or post exploit steps: every fork of
Bookworm is someone's live reading server.

**What to expect:** one maintainer, no bounty. An acknowledgement within a
week; confirmed issues are fixed through the normal path (PR →
`candidate-gate` → deploy) and published as a GitHub Security Advisory, with
credit if you want it. Only the latest `main` is patched — self-hosted forks
should track `main`.

**In scope:** code in this repository — the Worker, the reader frontend,
`/admin`, the deploy and GitHub Actions workflows, and anything affecting
reader keys, `ADMIN_TOKEN`, book content, or reading positions.

**Out of scope:** testing against someone else's instance without permission
(fork it and test your own), self-hosting misconfiguration, the Cloudflare
platform itself, and known upstream dependency advisories that Renovate and
Dependabot already track — unless you can show the vulnerability is reachable
in Bookworm.
