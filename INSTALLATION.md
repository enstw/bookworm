# Bookworm 安裝與維護手冊

這份手冊寫給**替你安裝的 AI agent**。把整份檔案交給終端機裡的 agent（Claude Code、
Codex⋯⋯），說「照 `INSTALLATION.md` 把 Bookworm 裝到我的帳戶」即可；標了 🧑 的步驟
才需要人親自動手，其餘每一步都是 agent 能直接執行、也能自行驗證的指令。沒有 agent
也沒關係 — 同樣的指令照順序自己跑，結果相同。

想先了解產品定位與特色，請回到 [README](README.md)。要改程式再讀
[DESIGN.md](DESIGN.md)；安裝用不到它。

## 分工

🧑 **人要做的只有三件事**，都在瀏覽器裡：

1. 準備一個免費的 [Cloudflare 帳號](https://dash.cloudflare.com/)，並進 R2 頁面啟用
   一次（首次啟用可能要求付款資料，免費額度內仍為 `$0`）。
2. 建立 Cloudflare API token（權限見第 2 步的表），抄下 Account ID，交給 agent —
   或者自己執行貼 token 的那兩行指令。
3. 部署完成後，把讀者鑰匙連結在手機上打開，加入主畫面。

其餘 — fork、secrets、部署、驗證、產生鑰匙、上書 — agent 用 `gh` 與 `curl` 完成。
另外準備一本你有權保存與使用的 `.txt` 書檔（Bookworm 不附書），和一個密碼管理器
收 `ADMIN_TOKEN`。

## Agent 守則

- **Secret 只走 stdin。** `gh secret set` 從 stdin 讀值；密鑰不寫進檔案、不放進
  指令列參數、不出現在 commit 或公開記錄。Cloudflare token 建議由人自己貼（第 3 步）。
- **一步一驗證。** 每一步都寫了預期結果，對不上就停在那一步查〈疑難排解〉，
  不要重試到過為止。
- **部署一律走 GitHub Actions。** 本機不需要 wrangler；裝好之後，push 到 `main`
  就是部署。（完全不想用 Actions 的替代路徑在〈本機開發〉的 `deploy.sh`。）

## 前置檢查

```sh
gh auth status        # 已登入 GitHub，scope 含 repo 與 workflow
git --version && curl --version && openssl version
```

本機的 pnpm 與 Node 只有〈第一本書〉的 B 路徑與〈本機開發〉才需要。

## 安裝

### 1. Fork 並啟用 workflow

```sh
gh repo fork enstw/bookworm --clone=false
FORK="$(gh api user -q .login)/bookworm"
gh workflow enable deploy.yml --repo "$FORK"
```

GitHub 預設停用 fork 帶來的 workflow；`gh workflow enable` 等同網頁上那顆
「I understand my workflows, go ahead and enable them」。`publish-book.yml` 與
`push-test.yml` 之後用到再啟用。

### 2. 🧑 建立 Cloudflare API token

Cloudflare 後台 → **My Profile → API Tokens → Create Token → Create Custom Token**。
內建的「Edit Cloudflare Workers」樣板不含 R2 與 D1，請照下表加權限：

| 範圍 | 權限 | 等級 |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | Workers R2 Storage | Edit |
| Account | D1 | Edit |
| Account | Account Settings | Read |
| User | User Details | Read |

**Account Resources** 選自己的帳戶。兩個 Read 權限只用於部署前的 `wrangler whoami`
驗證。另外抄下 **Account ID**：後台 **Workers & Pages** 右側欄就有。

### 3. 設定三個 secret

Cloudflare 的兩個值由 🧑 直接貼進終端機（`gh secret set` 從 stdin 讀，貼上後按
Enter 再按 Ctrl-D），這樣它們不必經過與 agent 的對話：

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo "$FORK"
gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$FORK"
```

`ADMIN_TOKEN` 是 Bookworm 自己的管理密鑰，由 agent 產生：

```sh
ADMIN_TOKEN="$(openssl rand -hex 24)"
echo "$ADMIN_TOKEN"   # 🧑 先抄進密碼管理器 — GitHub secret 是唯寫的，存了就看不回來
printf '%s' "$ADMIN_TOKEN" | gh secret set ADMIN_TOKEN --repo "$FORK"
```

### 4. 部署

```sh
gh workflow run deploy --repo "$FORK"
RUN="$(gh run list --repo "$FORK" --workflow deploy --limit 1 --json databaseId -q '.[0].databaseId')"
gh run watch "$RUN" --repo "$FORK" --exit-status
```

（run 要一兩秒才會出現；`gh run list` 撈不到就再等一下。）workflow 會驗證 token、
建立 D1 資料庫 `bookworm` 與 R2 bucket `bookworm-books`、套用 `schema.sql`、部署
Worker、設好 secret，最後帶著 `ADMIN_TOKEN` 探測一次 `/api/books`。整趟大約兩三分鐘。

完成後從記錄裡撈出網址：

```sh
URL="$(gh run view "$RUN" --repo "$FORK" --log | grep -m1 -oE 'https://[a-z0-9.-]+\.workers\.dev')"
echo "$URL"
```

預期形如 `https://bookworm.<你的子網域>.workers.dev`。此後每次 push 到 `main` 都會
自動部署；只動 Markdown 的 push 會跳過。要取得上游更新見〈日常維護〉。

### 5. 驗證

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/books"          # 預期 401
curl -s -H "authorization: Bearer $ADMIN_TOKEN" "$URL/api/books"   # 預期 {"books":[]}
```

無鑰匙的 401 是對的：內容都在讀者鑰匙後面。用瀏覽器打開 `$URL` 會看到「需要鑰匙」
的門，同一件事。

### 6. 第一把讀者鑰匙

閱讀需要**讀者鑰匙**，一台裝置一把。agent 直接產生：

```sh
curl -s -X POST "$URL/api/admin/readers" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"label":"我的 iPhone"}'
# 預期 {"ok":true,"key":"<32 位 hex>","user":"<自動產生的讀者代號>","label":"我的 iPhone"}
```

登入連結是 `$URL/?key=<key>`。🧑 用 AirDrop 或訊息把連結傳到閱讀裝置上打開 —
裝置便完成登入、落在書架上，之後不需再輸入；App 也會提示一次「加入主畫面」，
裝成全螢幕 PWA。

- 同一位讀者（同 `user` 代號）可以有多把鑰匙，進度與設定跟著代號在裝置間同步。
  幫第二台裝置產鑰匙時帶同一個代號：`-d '{"user":"<代號>","label":"iPad"}'`。
- 裝置遺失就撤銷那把鑰匙，其他裝置不受影響：在 `/admin` 按撤銷，或
  `curl -X DELETE "$URL/api/admin/readers/<key>" -H "authorization: Bearer $ADMIN_TOKEN"`。
- 離線閱讀預設就是開的：翻開一本書，附近章節與 App 外殼自動留在裝置上；書架上按
  某本書的 ⇣ 整本先存，再按一次刪掉那本書的離線內容。

### 7. 第一本書

上書不用重新部署，三條路選一條：

**A. 瀏覽器上傳（🧑，最私密，免工具）** — 打開 `$URL/admin`，貼上 `ADMIN_TOKEN`，
選 `.txt` 或 `.zip`，確認偵測到的書名、代稱與章節再上傳。解壓縮、編碼轉換
（UTF-8／GBK／Big5／Shift_JIS）、OpenCC `cn→tw` 簡轉繁與切章都在瀏覽器內完成；
章節辨識失敗可自填 regex（例如 `^第.+章`）。同代稱再傳一次是原地覆蓋，閱讀進度保留。

**B. 本機 CLI（agent；需 [pnpm](https://pnpm.io/installation) 11 與 Node 22）** —

```sh
gh repo clone "$FORK" bookworm && cd bookworm && pnpm install
pnpm run split -- ~/books/mybook.txt --title "書名" --slug mybook
pnpm run publish-book -- out/mybook --url "$URL" --token "$ADMIN_TOKEN"
```

常用切章參數：`--charset gbk|big5|shift_jis`（輸出一律 UTF-8）、`--s2t`（OpenCC
`cn→tw`，內文、標題、檔名一起轉）、`--pattern '^第.+章'`。標題匹配少於三個時改按
大小分段，過大的單章在行邊界續切；已切成 `NN_章名.txt` 的資料夾可整個當輸入。
切出的 `out/` 已被 gitignore。

**C. GitHub Actions（免本機工具；記錄公開）** — 適合只有下載網址的大檔：

```sh
printf '%s' "$URL" | gh secret set BOOKWORM_URL --repo "$FORK"
gh workflow enable publish-book.yml --repo "$FORK"
gh workflow run "publish book" --repo "$FORK" \
  -f source_url="https://example.com/book.txt" -f s2t=true -f dry_run=true
```

`dry_run=true` 只切章、把抓到的章節列在執行摘要裡；確認沒切錯再關掉重跑。
⚠ 公開 repo 的 Actions 輸入與記錄任何人都看得到，書名與章節名會留在上面 —
有版權或不想公開的內容走 A，或用私有 fork。

安裝到此完成：書架在 `$URL`，管理在 `$URL/admin`。

## 選用設定

### 自訂網域

🧑 在 Cloudflare 進入 **Workers → bookworm → Settings → Domains & Routes → Add**。
只在後台加網域，**不要**把 `routes` 寫進 `wrangler.jsonc` — 部署 token 沒有 zone
權限，寫了下次部署就失敗。

讀者鑰匙的 cookie 與離線快取都綁著 origin。換網域後，用原本的讀者代號重發鑰匙
（`-d '{"user":"<代號>"}'`），把新連結在每台裝置上打開；伺服器上的進度跟著代號，
不會丟。

### 新書推播

Web Push 是選用功能，需要本機 clone 與 pnpm（見〈第一本書〉B）：

```sh
pnpm exec node scripts/gen-vapid.mjs
gh secret set VAPID_PRIVATE_JWK --repo "$FORK"    # 貼上指令印出的 private JWK
printf '%s' "mailto:you@example.com" | gh secret set VAPID_SUBJECT --repo "$FORK"
gh workflow run deploy --repo "$FORK"
```

讀者之後可在書架頁尾訂閱新書通知，旁邊的**測試**按鈕驗證裝置、瀏覽器與推播服務的
整條路徑。要全鏈路實測，`push test` workflow 會上架一本測試書（真的發通知）再自動
刪掉：

```sh
gh workflow enable push-test.yml --repo "$FORK"
gh workflow run "push test" --repo "$FORK"
```

iPhone 只有已加入主畫面的 PWA 才有 `PushManager`，一般 Safari 分頁不會顯示訂閱
選項。更換 VAPID 金鑰會使既有訂閱失效，需要重新訂閱。圖示紅點是 service worker
收到推播時呼叫 `setAppBadge()` 畫上去的，下次打開 App 就清掉；有沒有成功會寫進
推播紀錄，
`curl -H "authorization: Bearer $ADMIN_TOKEN" "$URL/api/testlog?page=push&limit=5"`
讀得回來（寫紀錄不需要憑證，讀取則需要）。

### 語音朗讀

朗讀預設開啟，不需要 API key。Worker 使用 Microsoft Edge 的未公開朗讀協定，語音
固定為 `zh-TW-HsiaoChenNeural`；聽過的 MP3 片段快取在 R2 的 `_tts/`。這個端點沒有
穩定性承諾 — 朗讀突然失效時先查協定是否改變；語音快取不會自動淘汰，R2 用量異常
上升時檢查 `_tts/`。

## 日常維護

### 更新 Bookworm

```sh
gh repo sync "$FORK" --source enstw/bookworm
```

同步到 `main` 後 deploy workflow 自動執行；書籍與閱讀位置不會因部署而消失。

### 強制更新手機上的舊介面

書架頁尾 build 編號旁有**重新整理**：清掉 App 外殼快取與 service worker 後重新
載入，已下載的離線章節保留。

### 改書名、改代稱、刪書

開啟 `$URL/admin`（書架頁尾的**管理**就指向它）。上半部列出書架上每一本書：改書名
只動書目；改代稱只換網址 — 每本書實際存在一組永久書號（R2 的鍵前綴）底下，代稱
只是指過去的名字，所以檔案不搬、語音快取不掉、進度不動，舊代稱也還通得到；刪除
會連章節、語音快取與所有讀者的進度一起清掉，要打書籍代稱確認，無法復原。

### 健康檢查與修復

`/admin` 中段是兩顆按鈕：**健康檢查**只讀不寫，隨時可按，它說沒問題就是沒問題 —
R2 的檔案才是事實，書架索引只是被檢查的對象之一。**修復**是這頁唯一會寫的按鈕，
只處理剛剛檢查出來的那些：先重建書架索引（唯一把東西放回去的一步；索引與檔案
對不上、或代稱撞號，都在這一步解決或現形），再刪掉誰都讀不到的東西，最後把同一個
檢查再跑一次當證明。判準一句話：**書架上沒有的，就是誰都讀不到的** — 不必搶救，
刪掉重傳就好。

每個會刪東西的請求都帶著自己的前提，由伺服器對著 R2 重驗，對不上回 409 — 檢查與
修復之間就算有人上傳新書，也不會被一份過期的掃描誤刪。會整本刪掉的兩種發現
（**書不完整**、**書目檔壞了**）會先列出清單、等按一次確認才動手 — 整本刪掉連該書
所有人的閱讀進度一起清，重新上傳會拿到新書號。

| 發現 | 意思 |
|---|---|
| 有檔案沒書目 | 書號底下有章節檔但沒有 `manifest.json` — 上傳或搬移中斷 |
| 語音快取的書已不在 | `_tts/<書號>/` 的書早就刪了 — 通常最占空間 |
| 代稱指向不存在的書 | 網址解得到、書卻不在 |
| 進度屬於不存在的書 | 沒有人能打開的書的閱讀進度 |
| 桶子根目錄的雜物 | 不屬於任何書的物件 |
| 書目沒列到的多餘檔案 | 重新切章後留下的舊檔 |
| 書不完整 | 書目列的章節檔在 R2 缺了或大小不符 — 整本刪掉重傳 |
| 書目檔壞了 | `manifest.json` 不是合法 JSON — 跟沒有一樣讀不到 |

平常不用跑；上傳中斷、刪到一半、或搬家之後值得按一下檢查。修復後的複檢若還剩
東西，那是 bug，照 bug 回報。

## 存取模型與安全

書的內容、閱讀進度、語音朗讀都在讀者鑰匙後面：沒有有效鑰匙一律 401。鑰匙由伺服器
以 cookie 記在裝置上（一年效期，會自動修復），撤銷即失效；已存在裝置上的離線章節
不受撤銷影響 — 撤銷擋的是伺服器，不是手機裡已有的東西。維持開放的只有 App 外殼
（程式碼本來就公開）、`/api/feedback`，以及寫入 `/api/testlog`：紀錄是由拿不到
憑證的 service worker 寫的，但讀回來需要憑證，因為那些列會引用書的內容。管理與上傳端點一律由
`ADMIN_TOKEN` 保護，與讀者鑰匙互相獨立。讀者代號不是強式驗證，適用於小型可信任
群體。

## 本機開發

需要 pnpm 11 與其管理的 Node.js 22 以上環境；本機流程一律 pnpm，不需要 npm、npx、
yarn 或 corepack。

```sh
gh repo clone "$FORK" bookworm && cd bookworm && pnpm install
cp .dev.vars.example .dev.vars
pnpm run db:init:local
pnpm run dev            # http://localhost:8787
```

測試（端對端需要 Chromium；TTS 串流另需 `ffmpeg`）：

```sh
pnpm test               # 或 test:push、test:tts、test:vertical、test:bg、
                        #    test:admin、test:shelf、test:offline 單獨跑
```

不想用 GitHub Actions 的話，`deploy.sh` 在本機做一模一樣的部署：

```sh
cp .deploy.env.example .deploy.env
# 填 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、ADMIN_TOKEN
./scripts/deploy.sh
```

`.deploy.env` 已被 gitignore，切勿提交。`deploy.sh` 會把你帳戶的 D1 `database_id`
寫進 `wrangler.jsonc`，請將那個變更提交到自己的 fork。

## 疑難排解

| 症狀 | 處置 |
|---|---|
| `gh workflow run` 回 404 或 workflow 停用 | Fork 的 Actions 還沒啟用：`gh api -X PUT "repos/$FORK/actions/permissions" -F enabled=true`，再 `gh workflow enable deploy.yml --repo "$FORK"` |
| 部署在 `d1 create` 失敗，或說 R2 未啟用 | 🧑 到 Cloudflare 後台 R2 頁啟用一次（可能要求付款資料，免費額度不變），重跑 workflow |
| 第一次部署要求 `workers.dev` 子網域 | 🧑 新帳戶要先選子網域：**Workers & Pages → Add** 完成後重跑 |
| token 驗證立即失敗 | token 要同時有 `Account Settings · Read` 與 `User Details · Read`，且 Account Resources 含正確帳戶。成功時 workflow 故意不印 `wrangler whoami` — 公開記錄會洩漏 Cloudflare email |
| 部署完成但探測回 404 | Worker 還在傳播，等幾秒重試 |
| CI 在 `pnpm install --frozen-lockfile` 失敗 | 自己的 pnpm 設定含 `minimumReleaseAge` 時，剛發佈的依賴會暫時裝不了；稍後重建 lockfile 提交，或等時間窗過 |
| 切章只得到一個巨大章節 | 用 `--pattern` 傳能匹配標題行的 regex，或先切成 `NN_章名.txt` 再把資料夾餵給切章器 |
| 某台裝置跳到不對的位置 | 最後閱讀者勝出；同步位置與本機相差兩章以上時畫面會出現**回到上次位置**，一鍵恢復 |

## 已知限制

- 只直接支援純文字。EPUB、PDF 與漫畫需要先轉成 Bookworm 的章節與 manifest 格式。
- 每個 `(書籍, 讀者)` 只保存一個位置；沒有最遠閱讀位置、註記、畫線或全文搜尋。
- 介面為中英雙語，但語音、字體、切章與排版規則仍以中文為中心。
- Edge TTS 使用未公開協定，不能保證永久可用。
- 讀者代號不是強式驗證，只適用於小型可信任群體。

更底層的資料合約見 [REQUIREMENTS.md](REQUIREMENTS.md)，現行設計決策
（含真機調查的結論）見 [DESIGN.md](DESIGN.md)。
