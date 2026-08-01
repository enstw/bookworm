# Bookworm 安裝與維護指南

這份文件收納 Bookworm 的部署、上書、日常維護、本機開發與疑難排解。想先了解產品
定位與特色，請回到 [README](README.md)。

最省事的安裝方式是 **fork 這個 repo，再讓 GitHub Actions 部署到你自己的 Cloudflare
帳戶**。整個過程約 15 分鐘，不需要在本機安裝開發工具，Windows、macOS 與 Linux
都可以。

## 安裝前準備

- 一個免費的 [Cloudflare 帳號](https://dash.cloudflare.com/)。如果從未用過 R2，
  先進入 R2 頁面啟用；Cloudflare 可能要求填寫付款資料，但免費額度內仍為 `$0`。
- 一個 GitHub 帳號。
- 一本你有權保存與使用的 `.txt` 書檔。Bookworm 不附書籍內容。
- 一個密碼管理器，用來保存稍後產生的 `ADMIN_TOKEN`。

## 用 GitHub Actions 部署

### 1. Fork 專案並啟用 Actions

按 GitHub 頁面右上角的 **Fork**。進入自己的 fork 後，打開 **Actions** 分頁，按下
「I understand my workflows, go ahead and enable them」。GitHub 預設會停用 fork
帶來的 workflow，不先啟用就無法部署。

### 2. 建立 Cloudflare API token

進入 Cloudflare 後台的 **My Profile → API Tokens → Create Token → Create Custom
Token**。內建的「Edit Cloudflare Workers」樣板不包含 R2 與 D1，請自行加入以下權限：

| 範圍 | 權限 | 等級 |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | Workers R2 Storage | Edit |
| Account | D1 | Edit |
| Account | Account Settings | Read |
| User | User Details | Read |

在 **Account Resources** 選取自己的 Cloudflare 帳戶。兩個 Read 權限只用於部署前的
`wrangler whoami` 驗證。

另外記下 **Account ID**：Cloudflare 後台 → **Workers & Pages**，右側欄位即可看到。

### 3. 在 GitHub 設定三個 secret

進入自己 fork 的 **Settings → Secrets and variables → Actions → New repository
secret**，新增：

| Secret | 內容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 上一步建立的 Cloudflare token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `ADMIN_TOKEN` | 自己產生、至少 32 字元的隨機管理密鑰 |

如果手邊有終端機，可以用 `openssl rand -hex 24` 產生 `ADMIN_TOKEN`。請先放進密碼
管理器再貼到 GitHub：GitHub secret 是唯寫的，儲存後無法重新顯示原值。

### 4. 執行第一次部署

進入 **Actions → deploy → Run workflow**。workflow 會自動：

1. 驗證 Cloudflare token。
1. 建立 D1 資料庫 `bookworm`，並把 ID 寫入 `wrangler.jsonc`。
1. 建立 R2 bucket `bookworm-books`。
1. 套用 `schema.sql`。
1. 準備瀏覽器端依賴並寫入 build 編號。
1. 部署 Worker。
1. 將 `ADMIN_TOKEN` 設為 Worker secret。
1. 探測線上的 `/api/books`。

完成後，執行摘要最上方會出現你的網址，例如：

```text
https://bookworm.<你的子網域>.workers.dev
```

打開後會先看到「需要鑰匙」的門 — 這是正常的：先到 `/admin` 產生第一把讀者鑰匙
（見下文〈讀者鑰匙〉）。此後每次 push 到 `main` 都會自動部署；只修改 Markdown 時
會略過部署。要取得上游更新，可在 fork 頁面按 **Sync fork**。

## 放上第一本書

### 從瀏覽器上傳

前往：

```text
https://<你的伺服器>/admin
```

貼上 `ADMIN_TOKEN`，選取 `.txt` 或 `.zip`，檢查偵測到的書名、網址代稱與章節，再按
上傳。管理密鑰會存在該瀏覽器的 `localStorage`，不必每次重填。

解壓縮、編碼轉換、簡轉繁與切章都在瀏覽器內完成：

- 輸入編碼支援 UTF-8、GBK、Big5 與 Shift_JIS。
- 簡轉繁使用 OpenCC `cn→tw`，會處理字形與台灣詞彙。
- 章節標題若未正確辨識，可自行輸入 regex，例如 `^第.+章`。
- 同一個網址代稱再次上傳會原地覆蓋，既有閱讀進度保留。

瀏覽器上傳最適合一般使用，也避免把書名與章節資訊留在公開的 GitHub Actions 記錄中。

### 從 GitHub Actions 上書

大型書檔或只有下載網址時，可使用 **Actions → publish book → Run workflow**。它支援：

- `.txt`，或包含一個／多個 `.txt` 的 `.zip`。
- 指定書名、網址代稱、編碼、簡轉繁與章節 regex。
- `dry_run`：只切章並在摘要顯示結果，不上傳。

先在 **Settings → Secrets and variables → Actions → Variables** 新增：

| 類型 | 名稱 | 內容 |
| --- | --- | --- |
| Secret | `BOOKWORM_URL` | 你的 Bookworm 網址 |
| Secret（選用） | `BOOK_SOURCE_URL` | 預設書檔網址 |
| Secret（選用） | `BOOK_SOURCE_HEADER` | 下載來源需要的認證 header |

> 公開 repo 的 Actions 輸入與執行記錄任何人都看得到，書名與章節名也可能出現在摘要。
> 有版權或不想公開的內容，請用私有 fork 或瀏覽器 `/admin` 上傳。

### 從本機 CLI 上書

本機已完成[開發環境](#本機開發)後，可先切章再上傳：

```sh
pnpm run split -- ~/books/mybook.txt --title "書名" --slug mybook
pnpm run publish-book -- out/mybook \
  --url https://<你的伺服器> --token "$ADMIN_TOKEN"
```

切好的內容位於 `out/<slug>/`，已被 gitignore。常用切章參數：

- `--charset gbk`、`big5` 或 `shift_jis`：指定來源編碼，輸出一律為 UTF-8。
- `--pattern '^第.+章'`：覆寫章節標題規則。
- `--s2t`：使用 OpenCC `cn→tw` 轉換內文、標題與檔名。
- 已切成 `NN_章名.txt` 的內容，可以直接將整個資料夾當成輸入。

若偵測到的標題少於三個，切章器會依大小分段；過大的單章則會在行邊界繼續切開。

## 讀者鑰匙：第一次開書之前

閱讀需要**讀者鑰匙**。部署完成後打開 `/admin`，在「讀者鑰匙」區產生第一把：

1. 讀者代號留空（自動產生）或填一個你想要的短代號。
2. 備註填裝置名稱（例如「我的 iPhone」），方便日後撤銷。
3. 按**產生鑰匙** — 登入連結會自動複製，形式是 `https://<你的伺服器>/?key=…`。

把連結用 AirDrop 或訊息傳到要閱讀的裝置上打開，該裝置就完成登入，之後不需再輸入。
一台裝置一把鑰匙；同一位讀者（同代號）可以有多把，進度與設定會跟著代號同步。
裝置遺失時，回到 `/admin` 撤銷那把鑰匙即可 — 其他裝置不受影響。

書籍網址的形式是 `https://<你的伺服器>/<書籍代稱>`（舊的
`/<書籍代稱>/<讀者代號>` 連結仍可開啟，代號部分已不再使用）。

在手機上選擇「加入主畫面」即可安裝成全螢幕 PWA。無論當時停在哪一頁，安裝後的
入口一律是書架（manifest 的 `start_url`）— 書架記著每本書的進度，點進去就回到
上次的位置。裝置登入完成後，App 也會主動提示一次安裝步驟。離線閱讀預設就是開
的：翻開一本書，目前附近的章節與 App 外殼會自動留在裝置上；在書架上按某本書的
⇣ 可以先存起來，再按一次則把那本書的離線內容刪掉。

## 存取模型與安全

書的內容、閱讀進度、語音朗讀都在讀者鑰匙後面：沒有有效鑰匙的請求一律 401。鑰匙
由伺服器以 cookie 形式記在裝置上（一年效期，會自動修復），撤銷即失效；已存在裝置
上的離線章節不受撤銷影響 — 撤銷擋的是伺服器，不是手機裡已有的東西。

維持開放的只有：App 外殼（程式碼本來就是公開的）、`/api/feedback`（改進建議，
設計上就是無鑰匙讀取）與 `/api/testlog`（裝置診斷回報）。管理與上傳端點一律由
`ADMIN_TOKEN` 保護，與讀者鑰匙互相獨立。

## 選用設定

### 自訂網域

在 Cloudflare 進入 **Workers → bookworm → Settings → Domains & Routes → Add**。

如果部署 token 沒有 zone 權限，請只在後台加入網域，不要把 `routes` 寫進
`wrangler.jsonc`，否則下次部署會失敗。

讀者代號與離線快取都綁定 origin。更換網域後，每台裝置需要在新書架按 **更換**，
重新輸入原本的讀者代號；伺服器上的閱讀進度會跟著代號保留。

### 新書推播

Web Push 是選用功能。先在本機產生 VAPID 金鑰：

```sh
pnpm exec node scripts/gen-vapid.mjs
```

將輸出加入 GitHub repository secrets：

| Secret | 內容 |
| --- | --- |
| `VAPID_PRIVATE_JWK` | 指令輸出的 private JWK |
| `VAPID_SUBJECT` | 你的聯絡方式，例如 `mailto:you@example.com` |

重新執行 deploy workflow。讀者之後可在書架頁尾訂閱新書通知，並用旁邊的**測試**按鈕
驗證裝置、瀏覽器與推播服務的整條路徑。

iPhone 只有已加入主畫面的 PWA 會提供 `PushManager`；一般 Safari 分頁不會顯示訂閱
選項。更換 VAPID 金鑰會使既有訂閱失效，需要讓讀者重新訂閱。

圖示上的紅點（badge）不是通知的附帶效果 —— 要自己呼叫 Badging API。service worker
收到推播時會呼叫 `setAppBadge()`，數字取自系統通知匣裡還留著幾則；下次打開 App
（或從通知點進來）就清掉。同樣只有加到主畫面、且已允許通知的 App 才看得到；有沒有
成功會寫進推播紀錄，用 `/api/testlog?page=push` 讀得回來。

### 語音朗讀

朗讀預設開啟，不需要 API key。Worker 使用 Microsoft Edge 的未公開朗讀協定，語音
目前固定為 `zh-TW-HsiaoChenNeural`；聽過的 MP3 片段快取在 R2 的 `_tts/`。

這個端點沒有穩定性承諾，若未來朗讀突然失效，應先檢查協定是否改變。語音快取目前
不會自動淘汰，可在 R2 用量異常上升時檢查 `_tts/`。

## 日常維護

### 更新 Bookworm

在 GitHub fork 頁面按 **Sync fork**。同步到 `main` 後，deploy workflow 會自動執行；
書籍與閱讀位置不會因部署而消失。

### 強制更新手機上的舊介面

書架頁尾的 build 編號旁有**重新整理**。它會清除 App 外殼快取與 service worker 後
重新載入，但保留已下載的離線章節。

### 改書名、改網址代稱或刪書

開啟 `/admin`（書架頁尾的**管理**就指向它），輸入 `ADMIN_TOKEN`。驗證後，頁面上半
部列出書架上每一本書，各自可以：

- **改書名**：只改書目裡的書名，章節與語音快取原封不動。
- **改代號**：只換網址。每本書實際存在一組永久的書號（R2 的鍵前綴）底下，代號只是
  指向書號的一個名字，所以改代號一個請求就好：檔案不搬、語音快取不掉、閱讀進度不
  動，連舊代號都還通得到（舊書籤不會壞）。
- **刪除**：章節、語音快取與所有讀者的閱讀位置一起清掉，無法復原；必須把書籍代稱
  打進去才會執行。

### 檢查與修復

`/admin` 中段是兩顆按鈕，兩個階段：**健康檢查**先看，**修復**才動手 —— 像
`brew doctor` 和 `brew doctor --fix` 分開。判準就一句話 ——
**書架上沒有的，就是誰都讀不到的**，不必搶救，刪掉重傳就好。

**健康檢查**只讀不寫，從頭到尾都是。它隨時可以按，而且不預設任何修復已經跑過：
R2 的檔案才是事實，索引只是被檢查的東西之一，不是前提。所以它說沒問題就是沒問題 ——
一句能相信的沉默，是它存在的意義。（它以前只能接在重建索引後面跑，那時一筆發現
可能只是「索引還沒跟上」而不是「壞了」，於是它既不能單獨按，沉默也不值錢。）

**修復**是這頁唯一會寫東西的按鈕，而且只處理剛剛檢查出來的那些。它會：先重建索引，
再把讀不到的東西刪掉，最後把同一個檢查再跑一次當作證明。順序是有理由的 —— 重建
索引是唯一把東西放回去而不是拿走的一步，也是其中兩種發現的完整解答。

**重建索引**單獨沒有按鈕，因為它會寫：它是修復的第一步，別的地方都不需要它。書架是
照著各書 `manifest.json` 建出來的索引，索引和實際檔案對不上時（或第一次升級到書號
制時），按修復就會一起處理掉。它唯一會回報的是**代號撞號** —— 那要寫進資料庫才看得
出來，也是健康檢查唯一看不到的問題。結果報在上半部的書單底下，因為它講的是書架。

檢查與修復之間有個空窗：中間可能有人上傳了新書。所以每個會刪東西的請求都會自己再
確認一次它憑什麼刪 —— 送出的前提（「這本書的檔案不見了」、「這本書缺章」、「這本
書的書目讀不出來」）由伺服器對著 R2 重驗，對不上就回 409 拒絕，而不是照著一份可能
過期的掃描結果動手。

會被清掉的：

| 發現 | 意思 |
|---|---|
| 有檔案沒書目 | 某個書號底下有章節檔，但沒有 `manifest.json` —— 上傳或搬移中斷 |
| 語音快取的書已不在 | `_tts/<書號>/` 的書早就刪了 —— 通常最占空間 |
| 代號指向不存在的書 | 網址解得到、書卻不在 |
| 進度屬於不存在的書 | 沒有人能打開的書的閱讀進度 |
| 桶子根目錄的雜物 | 不屬於任何書的物件 |
| 書目沒列到的多餘檔案 | 書號底下有書目沒提到的檔案 —— 重新切章後留下的舊檔 |
| 書不完整 | 書目列的章節檔，R2 裡少了或大小不符 —— 整本刪掉，重新上傳 |
| 書目檔壞了，讀不出來 | `manifest.json` 在，但不是合法的 JSON —— 跟沒有一樣讀不到 |

「書不完整」是唯一會逐章比對的檢查：書架上的章數與字數都來自各書的 `manifest.json`
—— 那是上傳端的說法，不是量出來的。這一項會把說法和桶子裡實際有的檔案對一次（有
記錄位元組大小的書還會比大小）。缺章的書會整本清掉：讀者翻到一半撞牆比沒有這本書
更糟，而且沒什麼好搶救的 —— 重新上傳就是了。（注意：整本刪掉會連同該書的閱讀進度
一起清；重新上傳會拿到新的書號。）這一項也是唯一連書架沒收錄的書都會數的檢查 ——
沒有索引列的書，正好就是沒人數過章節的那種。

「書目檔壞了」跟「有檔案沒書目」一樣讀不到：進書的每條路都要經過索引，而索引是照
`manifest.json` 建的，讀不出來就沒有任何一條路進得去。它只能在真的去讀書目的那一
輪被發現 —— 掃書那一輪只 HEAD 一下，而 HEAD 分不出好書目和壞書目。

會整本刪掉的兩種（**書不完整**、**書目檔壞了**）會先停下來問：其他東西早就沒人讀得
到，刪了不會有人少東西，但一本書不一樣 —— 它還在書架上、還半能用，整本掃掉會連每個
人讀到哪都一起沒了。所以修復會把要刪的書列出來，等按一次確認才動；取消就什麼都不動。

只報告、不動手的：**書架索引漏掉**、**索引有書、檔案不見** —— 修復的第一步重建索引
就處理掉了，不需要另外的動作；**不合法的書號前綴** 則是伺服器根本定址不到，要從
Cloudflare R2 後台處理。

修復完會再檢查一次確認。因為檢查是完整的，這一次跑出來的東西就是修復沒修好的 ——
不是它挖出來的新問題，所以剩東西就是 bug，可以照 bug 講。平常不用跑；上傳中斷、
刪到一半、或搬過家之後值得按一下檢查。

## 本機開發

需要 [pnpm](https://pnpm.io/installation) 11 與其管理的 Node.js 22 以上環境。本機流程
一律使用 pnpm；不需要 npm、npx、yarn 或 corepack。

```sh
git clone https://github.com/<你>/bookworm.git
cd bookworm
pnpm install

cp .deploy.env.example .deploy.env
# 填入 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、ADMIN_TOKEN
./scripts/deploy.sh
```

`.deploy.env` 已被 gitignore，切勿提交。`deploy.sh` 會建立或找到 D1、建立 R2、套用
schema、部署 Worker 並設定 secret；它也會把你帳戶的 D1 `database_id` 寫進
`wrangler.jsonc`，請將該變更提交到自己的 fork。

若偏好逐步執行：

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create bookworm
# 把得到的 ID 寫入 wrangler.jsonc
pnpm exec wrangler r2 bucket create bookworm-books
pnpm run db:init
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm run deploy
```

本機開發伺服器：

```sh
cp .dev.vars.example .dev.vars
pnpm run db:init:local
pnpm run dev
```

預設網址是 <http://localhost:8787>。

### 測試

```sh
pnpm test
```

完整測試涵蓋推播加密與 API、書架管理、直排與背景切換、TTS 串流與離線行為。單獨
執行時可使用：

```sh
pnpm run test:push
pnpm run test:tts
pnpm run test:vertical
pnpm run test:bg
pnpm run test:admin
pnpm run test:shelf
pnpm run test:offline
```

端對端測試需要 Chromium；TTS 串流測試另需 `PATH` 上有 `ffmpeg`。

## 疑難排解

### Actions 分頁是空的，或 workflow 無法執行

Fork 帶來的 workflow 預設停用。到 Actions 分頁按一次「I understand my workflows,
go ahead and enable them」。

### `wrangler d1 create` 失敗，或顯示 R2 尚未啟用

先到 Cloudflare 後台的 R2 頁面啟用服務，再重新執行 workflow。首次啟用可能要求付款
資料，但不會改變免費額度。

### 第一次部署要求設定 `workers.dev` 子網域

新 Cloudflare 帳戶必須先選一個子網域。進入 **Workers & Pages → Add** 完成設定後，
重新執行部署。

### token 驗證立即失敗

確認 token 同時具備 `Account Settings · Read` 與 `User Details · Read`，並在 Account
Resources 包含正確帳戶。成功時 workflow 不會印出 `wrangler whoami` 的內容，以免
公開 Actions 記錄洩漏 Cloudflare email。

### 第一次部署完成，但探測回 404

Worker 可能仍在傳播。等待幾秒後重新開啟執行摘要中的網址。

### `pnpm install --frozen-lockfile` 在 CI 失敗

若自己的 pnpm 設定含 `minimumReleaseAge`，剛發佈的依賴可能暫時無法安裝。稍後重建
lockfile 並提交，或等待設定的時間窗結束。

### 切章後只得到一個巨大章節

來源標題不符合內建規則。用 `--pattern` 傳入能匹配標題行的 regex，或自行切成
`NN_章名.txt` 後，把整個資料夾交給切章器。

### 某台裝置跳到不正確的位置

Bookworm 採最後閱讀者勝出。同一讀者代號在另一台裝置讀得更晚時，會以較新的時間戳
為準。若同步位置與本機上次位置相差兩章以上，畫面會顯示**回到上次位置**，可一鍵恢復
並重新同步。

## 已知限制

- 只直接支援純文字。EPUB、PDF 與漫畫需要先轉成 Bookworm 的章節與 manifest 格式。
- 每個 `(書籍, 讀者)` 只保存一個位置；沒有最遠閱讀位置、註記、畫線或全文搜尋。
- 介面為中英雙語，但語音、字體、切章與排版規則仍以中文為中心。
- Edge TTS 使用未公開協定，不能保證永久可用。
- 讀者代號不是強式驗證，只適用於小型可信任群體。

更底層的資料合約見 [REQUIREMENTS.md](REQUIREMENTS.md)，現行設計決策見
[DESIGN.md](DESIGN.md)，實作與真機調查見 git 提交記錄。
