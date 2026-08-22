# Bookworm 安裝與維護手冊

這份手冊寫給**替你安裝的 AI agent**。把整份檔案交給終端機裡的 agent（Claude Code、
Codex⋯⋯），說「照 `INSTALLATION.md` 把 Bookworm 裝到我的帳戶」即可；標了 🧑 的步驟
才需要人親自動手，其餘每一步都是 agent 能直接執行、也能自行驗證的指令。沒有 agent
也沒關係 — 同樣的指令照順序自己跑，結果相同。

安裝**不需要 fork、不需要 clone 這個 repo、不需要 GitHub Actions、也不需要 wrangler**。
一支從發行頁下載的 `bootstrap.mjs` 就把整台機器架起來：它自己去上游抓最新的讀者
版本、建 D1 與 R2、部署兩個 Worker、設好 secret、產生第一把鑰匙。裝好之後，這台
機器會**自己**去上游看有沒有新版本（見〈讓它自動更新〉）— 不必再回來跑任何指令。

想先了解產品定位與特色，請回到 [README](README.md)。要改程式再讀
[DESIGN.md](DESIGN.md)；安裝用不到它。

## 分工

🧑 **人要做的只有三件事**，前兩件在瀏覽器裡：

1. 準備一個免費的 [Cloudflare 帳號](https://dash.cloudflare.com/)，並進 R2 頁面啟用
   一次（首次啟用可能要求付款資料，免費額度內仍為 `$0`）。
2. 建立一個 Cloudflare API token（權限見第 1 步的表），抄下 Account ID，交給 agent —
   或者自己把 token 貼進執行 `bootstrap.mjs` 的那一行。
3. 裝好後，把 agent 印出的**讀者鑰匙連結**在手機上打開，加入主畫面。

其餘 — 下載 `bootstrap.mjs`、建資源、部署、驗證、產生鑰匙、上書 — agent 用 `node`
與 `curl` 完成。另外準備一本你有權保存與使用的 `.txt` 書檔（Bookworm 不附書），和
一個密碼管理器收 `ADMIN_TOKEN`。

## Agent 守則

- **Secret 只走環境變數（env）。** `bootstrap.mjs` 從 `CF_API_TOKEN`、`CF_ACCOUNT_ID`
  等環境變數讀值；密鑰不寫進檔案、不放進指令列參數、不出現在任何公開記錄。Cloudflare
  token 建議由人自己貼在指令前（見〈安裝〉第 2 步）。
- **一步一驗證。** 每一步都寫了預期結果，對不上就停在那一步查〈疑難排解〉，不要重試
  到過為止。
- **不 fork、不 clone、不用 Actions。** 安裝只需要一支下載下來的檔案。要改程式或本機
  測試才需要 clone，見〈本機開發〉。

## 前置檢查

```sh
node --version        # 需要 Node 20 以上（bootstrap 用內建的 fetch/crypto，無需安裝套件）
curl --version && openssl version
```

## 安裝

### 1. 🧑 建立 Cloudflare API token 與 Account ID

Cloudflare 後台 → **My Profile → API Tokens → Create Token → Create Custom Token**。
內建的「Edit Cloudflare Workers」樣板不含 R2 與 D1，請照下表加權限：

| 範圍 | 權限 | 等級 |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | Workers R2 Storage | Edit |
| Account | D1 | Edit |
| Account | Account Settings | Read |
| User | User Details | Read |

**Account Resources** 選自己的帳戶。這是**一次性**的寬權 token：安裝跑完就可以刪掉，
它和之後給更新器的那把窄權 token（見〈讓它自動更新〉）是不同的兩把。另外抄下
**Account ID**：後台 **Workers & Pages** 右側欄就有。

### 2. 下載並執行 bootstrap

```sh
curl -fsSL https://github.com/enstw/bookworm/releases/latest/download/bootstrap.mjs -o bootstrap.mjs

CF_API_TOKEN='貼上第 1 步的 token' \
CF_ACCOUNT_ID='貼上第 1 步的 Account ID' \
UPSTREAM_URL='https://github.com/enstw/bookworm/releases/latest/download/' \
VAPID_SUBJECT='mailto:you@example.com' \
node bootstrap.mjs
```

`bootstrap.mjs` 是一支自足的檔案（發行時已把 schema 與更新器打包進去，只在執行時
去 `UPSTREAM_URL` 抓 12 MB 的讀者版本）。它會依序建立 D1 資料庫 `bookworm` 與 R2
bucket `bookworm-books`、套用 `schema.sql`、部署讀者 Worker `bookworm` 連同整包
`public/`、開啟 workers.dev 子網域、部署 cron-only 更新器 `bookworm-updater`（**故意
不帶 `CF_API_TOKEN`，所以一開始不會自動更新** — 見〈讓它自動更新〉）、設好
`ADMIN_TOKEN` 與 VAPID 金鑰、並產生第一把管理者讀者鑰匙。整趟從筆電約 30 秒。

跑完，stdout 會印出三件要保存的東西：

```
instance is up.
  reader:       https://bookworm.<你的子網域>.workers.dev
  admin:        https://bookworm.<你的子網域>.workers.dev/admin
  owner key:    https://bookworm.<你的子網域>.workers.dev/?key=<32 位 hex>   (open on your phone, add to home screen)
  ADMIN_TOKEN:  <48 位 hex>   (save to a password manager now — it is not shown again)
```

🧑 立刻把 `ADMIN_TOKEN` 抄進密碼管理器 — 它是唯一一次印出。把 `URL` 記下來給後面
幾步用：

```sh
URL='https://bookworm.<你的子網域>.workers.dev'   # 用上面印出的實際網址
```

> **VAPID_SUBJECT** 是選用的：不給就用預設值，新書推播仍可運作（是推播服務聯絡你的
> email，不是使用者看得到的東西）。要自訂 `ADMIN_TOKEN` 或 VAPID 金鑰，先把
> `ADMIN_TOKEN=…` / `VAPID_PRIVATE_JWK=…` 放進環境變數再跑；不給就自動產生。

### 3. 驗證

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/books"          # 預期 401
curl -s -H "authorization: Bearer $ADMIN_TOKEN" "$URL/api/books"   # 預期 {"books":[]}
```

無鑰匙的 401 是對的：內容都在讀者鑰匙後面。用瀏覽器打開 `$URL` 會看到「需要鑰匙」
的門，同一件事。

### 4. 第一把讀者鑰匙

`bootstrap` 已經產生一把標為**管理者**的鑰匙，就是上面印出的 `owner key` 連結。
🧑 用 AirDrop 或訊息把它傳到閱讀裝置上打開 — 裝置便完成登入、落在書架上，之後不需
再輸入；App 也會提示一次「加入主畫面」，裝成全螢幕 PWA。

要再產第二把（另一台裝置、或另一位讀者）：

```sh
curl -s -X POST "$URL/api/admin/readers" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"label":"我的 iPad"}'
# 預期 {"ok":true,"key":"<32 位 hex>","user":"<自動產生的讀者代號>","label":"我的 iPad"}
```

- 同一位讀者（同 `user` 代號）可以有多把鑰匙，進度與設定跟著代號在裝置間同步。
  幫第二台裝置產鑰匙時帶同一個代號：`-d '{"user":"<代號>","label":"iPad"}'`。
- 那把管理者鑰匙（`is_owner`）還多一個用途：只有它會收到「有新版本待你決定」「安裝
  失敗已回復」「更新器失聯」這類**只給管理者**的推播（一般新書通知則所有訂閱者都
  收得到）。在 `/admin` 的〈讀者鑰匙〉可以把別把鑰匙也設為管理者。
- 裝置遺失就撤銷那把鑰匙，其他裝置不受影響：在 `/admin` 按撤銷，或
  `curl -X DELETE "$URL/api/admin/readers/<key>" -H "authorization: Bearer $ADMIN_TOKEN"`。
- 離線閱讀預設就是開的：翻開一本書，附近章節與 App 外殼自動留在裝置上；書架上按
  某本書的 ⇣ 整本先存，再按一次刪掉那本書的離線內容。

### 5. 第一本書

上書不用重新部署，兩條路選一條：

**A. 瀏覽器上傳（🧑，最私密，免工具）** — 打開 `$URL/admin`，貼上 `ADMIN_TOKEN`，
選 `.txt` 或 `.zip`，確認偵測到的書名、代稱與章節再上傳。解壓縮、編碼轉換
（UTF-8／GBK／Big5／Shift_JIS）、OpenCC `cn→tw` 簡轉繁與切章都在瀏覽器內完成；
章節辨識失敗可自填 regex（例如 `^第.+章`）。同代稱再傳一次是原地覆蓋，閱讀進度保留。

**B. 本機 CLI（agent；需 clone 與 [pnpm](https://pnpm.io/installation) 11、Node 22）** —
適合一次上很多本或想留腳本的情況：

```sh
gh repo clone enstw/bookworm bookworm && cd bookworm && pnpm install
pnpm run split -- ~/books/mybook.txt --title "書名" --slug mybook
pnpm run publish-book -- out/mybook --url "$URL" --token "$ADMIN_TOKEN"
```

常用切章參數：`--charset gbk|big5|shift_jis`（輸出一律 UTF-8）、`--s2t`（OpenCC
`cn→tw`，內文、標題、檔名一起轉）、`--pattern '^第.+章'`。標題匹配少於三個時改按
大小分段，過大的單章在行邊界續切；已切成 `NN_章名.txt` 的資料夾可整個當輸入。

安裝到此完成：書架在 `$URL`，管理在 `$URL/admin`。這台機器現在是獨立的，和這個
repo 再無關係 — 更新也一樣，見下一節。

## 讓它自動更新

裝好的更新器 `bookworm-updater` 是 cron-only、**尚未武裝**：它每 15 分鐘去上游看一次
有沒有新版本、把結果寫進 `/admin` 的〈更新〉面板，但因為手上沒有能改寫讀者 Worker
的 token，所以不會真的安裝。要開啟自動更新，🧑 給它一把**窄權** token：

1. 再建一把 Cloudflare API token，這次只要一個權限：

   | 範圍 | 權限 | 等級 |
   | --- | --- | --- |
   | Account | Workers Scripts | Edit |

   這把 token 只能改寫這個帳戶的 Worker，動不了 R2、D1 或帳戶設定 — 比安裝用的那把
   窄得多。它是更新器**唯一**的密鑰（連 `ADMIN_TOKEN` 都不給，見 [DESIGN.md](DESIGN.md)
   的 R4）。

2. 把它和 Account ID 設成更新器的兩個 secret。用 Cloudflare API（不需要 clone；
   `$ARM` 是剛才那把窄權 token，也可以用安裝時的寬權 token）：

   ```sh
   ACCT='貼上 Account ID'
   ARM='貼上窄權 token'
   for pair in "CF_API_TOKEN:$ARM" "CF_ACCOUNT_ID:$ACCT"; do
     curl -s -X PUT \
       "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/scripts/bookworm-updater/secrets" \
       -H "authorization: Bearer $ARM" -H "content-type: application/json" \
       -d "{\"name\":\"${pair%%:*}\",\"text\":\"${pair#*:}\",\"type\":\"secret_text\"}" >/dev/null
   done
   ```

   或在後台手動：**Workers & Pages → bookworm-updater → Settings → Variables and
   Secrets →** 加 `CF_API_TOKEN`（Secret，貼上那把窄權 token）與 `CF_ACCOUNT_ID`
   （Secret，貼上 Account ID）。加完**一定要到 Deployments 分頁確認 active 版本是最新
   的那個**（後台每加一個 secret 就產生一個新版本，但不一定會自動成為 active；實際
   發生過：active 停在只有 `CF_API_TOKEN` 的版本，更新器於是永遠「沒武裝」，面板只看
   到「上次安裝：尚無」）。不對就把最新版本 Promote 到 100%。

3. 到 `$URL/admin` 的〈更新〉面板挑安裝原則：**自動（滿 N 天後）**、**只通知我**、或
   **固定不動**。預設是自動、觀察 2 天 — 上游先跑一天當金絲雀，你的機器等版本穩定了
   再自己裝。面板上還看得到目前版本、上游最新、上次檢查與上次安裝的結果。

從此這台機器自己跟上游：檢查 → 依原則決定 → 下載驗證 → 裝上去 → 健康檢查，壞了自動
回復到前一版。這是**唯一**能改寫讀者的路徑，中間沒有任何人。要關掉自動更新，把面板
設成「固定不動」，或在後台刪掉 `CF_API_TOKEN`。

### 更新更新器本身（少見）

極少數情況下，某個新版本會要求比你手上更新的更新器（面板會標出所需版本號）。這時
把最新的 `bootstrap.mjs` 重下載一次，用 `BW_MODE=updater` 只換更新器、其餘一律不動
（讀者、D1、R2、每一把 secret 都保留，武裝狀態也保留）：

```sh
curl -fsSL https://github.com/enstw/bookworm/releases/latest/download/bootstrap.mjs -o bootstrap.mjs
CF_API_TOKEN='寬權 token' CF_ACCOUNT_ID='Account ID' \
UPSTREAM_URL='https://github.com/enstw/bookworm/releases/latest/download/' \
BW_MODE=updater node bootstrap.mjs
```

換好之後，更新器下次檢查就會裝上它原本拒絕的那個版本。

## 選用設定

### 自訂網域

🧑 在 Cloudflare 進入 **Workers → bookworm → Settings → Domains & Routes → Add**。
只在後台加網域即可。讀者鑰匙的 cookie 與離線快取都綁著 origin；換網域後，用原本的
讀者代號重發鑰匙（`-d '{"user":"<代號>"}'`），把新連結在每台裝置上打開；伺服器上的
進度跟著代號，不會丟。

### 新書推播

Web Push 已在安裝時設好（`bootstrap` 產生了 VAPID 金鑰）。讀者在書架頁尾就能訂閱
新書通知，旁邊的**測試**按鈕驗證裝置、瀏覽器與推播服務的整條路徑。`/admin` 的
〈讀者鑰匙〉有〈管理者通知測試〉可單獨驗證只給管理者的那條通道。

iPhone 只有已加入主畫面的 PWA 才有 `PushManager`，一般 Safari 分頁不會顯示訂閱
選項。要更換 VAPID 金鑰（會使既有訂閱失效、需重新訂閱），在後台把
`bookworm` 的 `VAPID_PRIVATE_JWK` secret 換掉即可。推播的收送結果會寫進紀錄，
`curl -H "authorization: Bearer $ADMIN_TOKEN" "$URL/api/testlog?page=push&limit=5"`
讀得回來（寫紀錄不需要憑證，讀取則需要）。

### 語音朗讀

朗讀預設開啟，不需要 API key。Worker 使用 Microsoft Edge 的未公開朗讀協定，語音
固定為 `zh-TW-HsiaoChenNeural`；聽過的 MP3 片段快取在 R2 的 `_tts/`。這個端點沒有
穩定性承諾 — 朗讀突然失效時先查協定是否改變；語音快取不會自動淘汰，R2 用量異常
上升時檢查 `_tts/`。

## 日常維護

### 更新 Bookworm

不用做任何事：武裝過的更新器（見〈讓它自動更新〉）會自己跟上游，依 `/admin` 的原則
決定何時安裝。書籍與閱讀位置不會因更新而消失。想立刻裝某個已看到的版本，用面板上的
**立即安裝**。沒武裝更新器的機器就停在目前版本，直到你武裝它。

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
（程式碼本來就公開）與 `/api/feedback`。`/api/testlog` 兩個方向都要憑證：讀要讀者
鑰匙（那些列會引用書的內容），寫要 `/admin` 簽發的 `bw_tlog` cookie。管理與上傳端點
一律由 `ADMIN_TOKEN` 保護，與讀者鑰匙互相獨立。

更新這一路只有更新器碰得到：讀者 Worker 手上沒有任何 Cloudflare token，`/admin` 的
〈更新〉面板全部讀自本機資料庫、不連上游。武裝更新器的那把 token 能改寫讀者，因此
是這台機器最敏感的東西 — 它只該有 Workers Scripts · Edit 一個權限，也只該存在更新器
上。讀者代號不是強式驗證，適用於小型可信任群體。

## 本機開發

安裝用不到這一節；要改程式或跑測試才需要。需要 pnpm 11 與其管理的 Node.js 22 以上
環境；本機流程一律 pnpm，不需要 npm、npx、yarn 或 corepack。

```sh
gh repo clone enstw/bookworm bookworm && cd bookworm && pnpm install
cp .dev.vars.example .dev.vars
pnpm run db:init:local
pnpm run dev            # http://localhost:8787
```

測試（端對端需要 Chromium；TTS 串流另需 `ffmpeg`）：

```sh
pnpm test               # 或 test:push、test:tts、test:vertical、test:bg、
                        #    test:admin、test:shelf、test:offline 單獨跑
```

從 clone 也能跑安裝（和下載 `bootstrap.mjs` 等效，只是 payload 從當前程式碼樹重建）：

```sh
CF_API_TOKEN=… CF_ACCOUNT_ID=… UPSTREAM_URL=…/releases/latest/download/ \
  node scripts/bootstrap-cli.mjs
```

上游自己這台（發行版本、當金絲雀）走 `scripts/deploy.sh`，那是 repo-backed 的部署路徑，
和一般 instance 的 bootstrap 不同 — 一般 instance 用不到 `deploy.sh`、也不需要 clone。

## 疑難排解

| 症狀 | 處置 |
|---|---|
| `bootstrap.mjs` 說 R2 未啟用（10004 以外的 R2 錯誤） | 🧑 到 Cloudflare 後台 R2 頁啟用一次（可能要求付款資料，免費額度不變），重跑 |
| `bootstrap.mjs` 抓不到 manifest | `UPSTREAM_URL` 要是 `…/releases/latest/download/`（結尾帶斜線），且該 repo 有發行版本 |
| token 立即被拒（403／10000） | token 要含上表五個權限，且 Account Resources 選了正確帳戶 |
| 部署完成但 `$URL` 打不開 | Worker 子網域還在傳播，等 10–60 秒重試；全新帳戶第一次可能要先在 **Workers & Pages → Add** 選一個 workers.dev 子網域，再重跑 |
| 讀者裝置跳到不對的位置 | 最後閱讀者勝出；同步位置與本機相差兩章以上時畫面會出現**回到上次位置**，一鍵恢復 |
| `/admin` 面板說更新器很久沒回報 | 更新器 cron 停了或 token 過期；到 **Workers & Pages → bookworm-updater** 查 cron 與 secret |
| 切章只得到一個巨大章節 | 用 `--pattern` 傳能匹配標題行的 regex，或先切成 `NN_章名.txt` 再把資料夾餵給切章器 |

## 已知限制

- 只直接支援純文字。EPUB、PDF 與漫畫需要先轉成 Bookworm 的章節與 manifest 格式。
- 每個 `(書籍, 讀者)` 只保存一個位置；沒有最遠閱讀位置、註記、畫線或全文搜尋。
- 介面為中英雙語，但語音、字體、切章與排版規則仍以中文為中心。
- Edge TTS 使用未公開協定，不能保證永久可用。
- 讀者代號不是強式驗證，只適用於小型可信任群體。
- 第一次安裝要一台有 Node 的機器跑一支指令；裝好之後更新是自動的，不再需要它。

更底層的資料合約見 [REQUIREMENTS.md](REQUIREMENTS.md)，現行設計決策
（含真機調查的結論）見 [DESIGN.md](DESIGN.md)。
