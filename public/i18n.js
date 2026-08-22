"use strict";

// Bookworm speaks 中文 first.
//
// The reader exists for 直排 paged Chinese text, so the chrome around it
// defaults to zh-TW instead of following navigator.language — a book set in
// vertical columns under an English toolbar was always the odd pairing.
// English is one tap away in the library footer and, like theme, is
// remembered per device: it describes THIS screen, not the reader id, so it
// deliberately does not sync.
//
// Loaded as a classic script before app.js (which is not a module);
// player.mjs and admin.html read the same globals. Every user-facing string
// belongs here. Values are plain strings, or functions when a number or a
// name lands in the middle of the sentence — the two languages put them in
// different places, which is exactly why the whole sentence is the unit of
// translation and not a prefix plus a suffix.

const BW_DEFAULT_LANG = "zh";

// Which language backfills a key the current one is missing — deliberately
// NOT the default. The owner reads this chrome in zh, so a zh gap patched
// from zh shows the raw key and an en gap patched from zh shows Chinese in
// an English interface nobody here opens: the half that breaks is the half
// that stays invisible. Backfilling from en instead puts every gap in front
// of the person who can fix it — an English phrase surfacing mid-Chinese
// toolbar is impossible to miss — and leaves the en side degrading to the
// key, which is equally loud.
const BW_FALLBACK_LANG = "en";

// KB/MB reads the same in both languages, and "0.0 MB" for a stray text file
// reads as "nothing to see" when the point of showing a size is to say how
// much a leftover is costing.
const bwBytes = (n) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024 ? `${(n / 1024).toFixed(1)} KB`
      : `${n} bytes`;

const BW_STRINGS = {
  zh: {
    // --- 書架 ---
    "lib.loading": "載入書目…",
    "lib.loadFail": (msg) => `無法載入書目（${msg}）。 `,
    "lib.retry": "重試",
    "lib.offlineList": "離線 — 顯示上次看到的書目。 ",
    // 中文讀者數字典的單位是萬，不是 k
    "lib.meta": (chapters, chars) =>
      `${chapters} 章 · ` + (chars >= 10000 ? `${Math.round(chars / 10000)} 萬字` : `${chars} 字`),
    "lib.chapterN": (n) => `第 ${n} 章`,
    "lib.empty": "書架還是空的 — 用 scripts/split-book.mjs 切好章節，再用 scripts/publish-book.mjs 上傳。",
    // 書架上每本書的 ⇣：說的是「這台裝置有沒有這本書」
    "lib.offlineSave": "存到這台裝置，沒有網路也讀得到",
    "lib.offlineSaved": (n) => `已存 ${n} 章 · 點按刪除`,
    "lib.offlineFail": "下載失敗 — 存離線內容需要網路連線。",
    // 書衣書架:「續讀」大卡與封面格的進度句
    "lib.continue": "續讀",
    "lib.notStarted": "未開始",
    "lib.readPct": (pct) => `讀到 ${pct}%`,
    "lib.readingAs": "閱讀身分 ",
    "lib.change": "更換",
    "lib.bookmarkHint": "進度與設定跟著鑰匙對應的代號，在每台裝置自動同步。",

    // --- 讀者鑰匙（門） ---
    "auth.need": "這是私人書房，要有鑰匙才能開書。把鑰匙連結傳到這台裝置上打開，或把鑰匙貼在下面。",
    "auth.bad": "鑰匙無效，或已被撤銷 — 請向管理者要一把新的。",
    "auth.placeholder": "鑰匙或鑰匙連結",
    "auth.submit": "開門",
    "auth.hint": "鑰匙由管理者在 /admin 產生，一台裝置一把。",
    "auth.changePrompt": "貼上新的鑰匙或鑰匙連結：",

    // --- 加入主畫面指南 ---
    "lib.installHint": "加入主畫面",
    "guide.h": "加入主畫面",
    "guide.why": "安裝成 App 之後全螢幕開啟、離線閱讀更可靠，也才能收到新書通知。",
    "guide.ios1": "在 Safari 點底部的分享按鈕（方框加向上箭頭）。",
    "guide.ios2": "往下捲，選「加入主畫面」，再按「加入」。",
    "guide.other1": "打開瀏覽器選單（⋮）。",
    "guide.other2": "選「安裝應用程式」或「加入主畫面」。",
    "guide.done": "之後就從主畫面開啟 Bookworm。",
    "guide.continue": "先繼續閱讀",

    // --- 新版本通知 ---
    "update.available": (b) => `新版本已上線（${b}）。`,
    "update.reload": "立即更新",
    "update.whatsNew": "有什麼新的",
    "update.hideNew": "收起來",
    "lib.build": (b) => `版本 ${b}`,
    "lib.relnotes": "版本紀錄",
    "lib.relnotesTitle": "歷來更新對讀者說了什麼",
    "lib.relnotesNone": "沒有可顯示的版本紀錄。",
    "lib.refresh": "重新整理",
    "lib.refreshTitle": "從伺服器重新下載程式（保留離線章節）",
    "lib.refreshOffline": "目前看起來是離線 — 仍要重新整理嗎？",
    // 切換鍵標示的是「切過去會變成什麼」，所以中文介面上寫 English
    "lib.langSwitch": "English",
    "lib.langTitle": "切換介面語言",

    // 書架頁尾唯一一個需要密鑰的入口，指向 /admin
    "lib.admin": "管理",
    "lib.adminTitle": "上傳、改書名、改網址代稱、刪除（需要管理密鑰）",

    // --- 推播通知（新書上架、新版本已上線）---
    "push.label": "新書與更新通知：",
    "push.blocked": "通知已被封鎖（在系統設定解除）",
    "push.subscribed": "已訂閱 · 點按取消",
    "push.subscribe": "點按訂閱",
    "push.test": "測試",
    "push.sending": "傳送中…",
    "push.notSubscribed": "尚未訂閱",
    "push.noRow": "伺服器沒有這個訂閱，請重新訂閱",
    "push.sent": (status) => `已送出 ${status}，通知應該幾秒內出現`,
    "push.rejected": (status, detail) => `推播服務回 ${status} ${detail}`.trim(),
    "push.fail": (msg) => `失敗：${msg}`,
    "push.noSW": "service worker 未註冊",
    "push.noVapid": "伺服器未設定推播",

    // --- 路由與錯誤 ---
    "err.badUrl": "網址不正確",
    "err.expected": "網址格式應為 /",
    "err.toLibrary": "回到書架",
    "err.backToLibrary": "← 回到書架",
    "reader.loading": "載入中…",
    "err.offlineTitle": "離線",
    // 離線快取現在預設就是開的，所以要說的不再是「去打開它」，而是這台裝置還
    // 沒下載過這本書 — 連上網路開啟一次，或先在書架上按 ⇣ 存起來
    "err.offlineBody": (slug) => `這台裝置沒有《${slug}》的離線內容。連著網路開啟一次，或在書架上按 `,
    "err.offlineBodyTail": " 先存起來，之後沒有網路也讀得到。 ",
    "err.notFoundTitle": "找不到這本書",
    "err.notFoundBody": (slug) => `沒有名為《${slug}》的書。 `,
    "err.chapterFail": (msg) => `章節載入失敗（${msg}）。 `,

    // --- 閱讀器工具列 ---
    "ui.library": "書架",
    "ui.contents": "目錄",
    "ui.listen": "朗讀",
    "ui.offlineCache": "離線快取",
    "ui.smaller": "縮小字級",
    "ui.larger": "放大字級",
    "ui.wake": "保持螢幕恆亮",
    "ui.theme": "主題（自動／亮／暗）",
    "ui.bg": (name) => `背景顏色：${name}`,
    "ui.writingMode": "直排／橫排",
    "ui.vertBtn": "直",
    "ui.next": "‹ 下一章",
    "ui.prev": "上一章 ›",
    "ui.close": "關閉",
    "ui.syncStatus": "同步狀態",
    "ui.offlineOff": "離線快取：關",
    "ui.offlineOn": (n) => `離線快取：已存 ${n} 章`,
    "ui.offlineAuto": (n) => `自動快取附近章節（已存 ${n} 章）· 點按保存完整範圍`,

    // --- 跨裝置書籤提示 ---
    "jump.synced": (here, there) => `已同步到「${here}」；此裝置上次讀到「${there}」`,
    "jump.back": "回到上次位置",
    "jump.remote": (there) => `另一台裝置讀到「${there}」`,
    "jump.go": "跳過去",

    // --- 背景紙色 ---
    "bg.default": "預設",
    "bg.light-brown": "淺褐",
    "bg.mid-brown": "中褐",
    "bg.gold-brown": "金褐",
    "bg.dark-brown": "深褐",
    "bg.snow-white": "雪白",
    "bg.pink": "粉紅",
    "bg.light-orange": "淡橙",
    "bg.light-yellow": "淡黃",
    "bg.light-green": "淡綠",
    "bg.light-cyan": "淺青",
    "bg.light-blue": "淺藍",
    "bg.light-purple": "淺紫",
    "bg.magenta": "紫紅",

    // --- 朗讀 ---
    "player.playPause": "播放／暫停",
    "player.back": "倒回一段",
    "player.forward": "快進一段",
    "player.stop": "結束朗讀",
    "player.generating": "語音產生中…",
    "player.error": "語音失敗 — 按 ▶ 重試",
    "player.chunk": (i, n) => `語音 ${i}/${n}`,
    "player.packStale": "離線語音包需要更新，暫時改用線上語音。",
    "player.packGo": (mb) => `重新下載（${mb}MB）`,
    "player.packOffer": "下載離線語音包，朗讀就不需要網路。",
    "player.packGet": (mb) => `下載（${mb}MB）`,
    "player.packBusy": (pct) => `下載中 ${pct}%`,
    "player.packDone": "語音包已就緒，下次播放改用離線語音。",
    "player.packFail": "下載失敗，可重試；已完成的部分不會重抓。",
    "player.report": "回報這一句",
    "player.reported": "已回報",
    "player.reportFail": "回報失敗（此裝置未開測試上傳）",

    // --- 暫時的裝置診斷頁 ---
    "diag.vh": "vh 測試",
    "diag.pg": "翻頁測試",
    "diag.paged": "整頁測試",
    "diag.scroll": "雙捲動測試",
    "diag.speech": "系統朗讀測試",
    "diag.wasm": "WASM 朗讀測試",
    "diag.upload": "上傳診斷讀數",
    "diag.uploadHint": "關掉之後，這台裝置的診斷頁就不再把讀數傳回伺服器；推播的收送記錄不受影響。",

    // --- 上傳新書 (/admin) ---
    "admin.docTitle": "Bookworm · 管理",
    "admin.toShelf": "← 回書架",
    "admin.h1": "管理",
    "admin.token": "管理密鑰（ADMIN_TOKEN）",
    "admin.verify": "驗證並儲存",
    "admin.verified": "✓ 已驗證",
    "admin.badToken": "✗ 密鑰無效",
    "admin.file": "書檔（.txt 或 .zip；可附 meta.json 與封面）",
    "admin.bookTitle": "書名",
    "admin.slug": "網址代稱（slug）",
    "admin.charset": "編碼",
    "admin.s2t": "簡→繁轉換",
    "admin.s2tYes": "轉換（預設）",
    "admin.s2tAuto": "自動偵測",
    "admin.s2tNo": "不轉換",
    "admin.pattern": "章節標題 regex（偵測失敗時才需要）",
    "admin.analyze": "分析章節",
    "admin.upload": "上傳",
    "admin.noTxtInZip": "zip 裡沒有 .txt 檔",
    "admin.fromZip": (name, mb) => `從 zip 取出 ${name}（${mb} MB）`,
    "admin.enriched": "偵測到 meta.json — 書名、作者、簡介取自附檔（文字依約定為 UTF-8）",
    "admin.badMeta": "meta.json 不是有效的 JSON",
    "admin.metaAuthorLine": (a) => `作者：${a}`,
    "admin.coverReady": (w, h, kb) => `封面 ${w}×${h}（${kb} KB）`,
    "admin.coverFail": (msg) => `⚠ 封面處理失敗，略過：${msg}`,
    "admin.converting": "簡→繁轉換中（OpenCC cn→tw）…",
    "admin.alreadyTrad": "偵測為繁體，略過轉換",
    "admin.fewHeadings": (n) => `⚠ 只偵測到 ${n} 個章節標題 — 整本視為單一檔案；可用 regex 欄位指定標題格式`,
    "admin.badSlug": "slug 無效",
    "admin.summary": (n, chars) => `${n} 章，共 ${chars.toLocaleString()} 字`,
    "admin.chapterLine": (title, chars) => `${title}（${chars.toLocaleString()} 字）`,
    "admin.tokenExpired": "密鑰失效 — 請重新驗證",
    "admin.uploaded": (title) => `✓ 已上傳《${title}》— 開始閱讀`,
    "admin.uploadStats": (n, mb, s) => `${n} 章，${mb} MB，${s} 秒`,
    "admin.putRetry": (name, why) => `⚠ 重試 ${name}（${why}）`,
    "admin.uploadFail": (msg) => `✗ 上傳失敗：${msg}`,

    // 書架管理（同一頁，驗證後才出現）
    "admin.booksH": "書架上的書",
    "admin.booksEmpty": "書架還是空的 — 用下面的表單上傳第一本。",
    "admin.booksFail": (msg) => `無法載入書目（${msg}）`,
    "admin.edit": "修改",
    "admin.remove": "刪除",
    "admin.save": "儲存",
    "admin.cancel": "取消",
    "admin.uploadH": "上傳新書",
    "admin.working": "處理中…",
    "admin.noChange": "沒有變更",
    "admin.titleRequired": "書名不能空白",
    "admin.slugHint": "書檔存在固定的書號下，改代號只動網址：檔案不搬、進度不動，舊網址也還通得到。",
    "admin.badSlugChars": "代號只能用小寫英數、中日文字與連字號，最多 40 個字",
    "admin.reservedSlug": "這個代號被網站自己的頁面佔用了，請換一個",
    "admin.idIs": (id) => `書號 ${id}`,
    "admin.titleSaved": (title) => `✓ 書名改成《${title}》`,
    "admin.sweeping": (n) => `清理舊檔… 已刪 ${n} 個`,
    "admin.stuck": "沒有進展 — 已中止",
    "admin.reslugged": (slug) => `✓ 代號改成 ${slug}（舊網址仍可用）`,
    "admin.reindexed": (n, pruned) =>
      `✓ 已重建索引：${n} 本書` + (pruned ? `，清掉 ${pruned} 筆失效資料` : ""),
    "admin.deleteWarn": (title) =>
      `永久刪除《${title}》：章節、語音快取、所有人的閱讀進度都會一起消失，無法復原。`,
    "admin.deleteConfirm": (slug) => `輸入代號「${slug}」以確認`,
    "admin.deleteGo": "確定刪除",
    "admin.deleteMismatch": "代號不符 — 沒有刪除",
    "admin.deleted": (title) => `✓ 已刪除《${title}》`,
    "admin.fail": (msg) => `✗ ${msg}`,

    // 檢查與修復：先看，有問題再動。檢查只讀不寫；修復重建索引，再把讀不到的清掉
    "clean.h": "檢查與修復",
    "clean.hint": "先檢查，有問題再修。檢查只讀不寫，隨時可以按。修復會重建索引，再把讀不到的東西刪掉 —— 書架上沒有的，就是誰都讀不到的，不必搶救，刪掉重傳就好。",
    "clean.check": "健康檢查",
    "clean.fix": "修復",
    "clean.reindexing": "重建索引中…",
    "clean.scanning": (n) => `檢查中…（第 ${n} 輪）`,
    "clean.healthy": "✓ 一切正常",
    "clean.found": (n, fixable) =>
      `找到 ${n} 項問題` +
      (fixable === n ? " —— 按「修復」" : `，其中 ${fixable} 項可以修（見下）`),
    "clean.dropped": (n) => `另有 ${n} 項超過這次列出的上限 —— 修完再檢查一次`,
    "clean.done": (items, removed) => `✓ 修好 ${items} 項，共清掉 ${removed} 筆`,
    "clean.reportOnly": (n) => `${n} 項只能報告，沒有可以自動清除的東西（見下）`,
    "clean.left": (n) => `還有 ${n} 項沒清乾淨 — 再跑一次`,
    "clean.cleared": (n) => `✓ 已清除 ${n} 筆`,
    // 整本刪掉一本書是這顆按鈕唯一會讓人少掉東西的動作，所以會先停下來問
    "clean.confirmWarn": (n) =>
      `以下 ${n} 本書會被整本刪掉：章節、語音快取、書架資料，` +
      `還有每個人在${n === 1 ? "這本書" : "這些書"}裡讀到哪，都會一起清掉。清完請重新上傳。`,
    "clean.confirmGo": (n) => `確定刪除這 ${n} 本`,
    "clean.cancelled": "已取消 —— 什麼都沒有清",
    "clean.note.swept": "這一輪已經跟著整本書清掉了",
    // 重建索引唯一自己才會發現的問題：代號撞號要寫進資料庫才看得出來
    "clean.reindexNote.slug-taken": (id, slug) => `${id}：代號「${slug}」已被占用，改用 ${id}`,
    "clean.note.bad-prefix": "伺服器碰不到這個前綴，需要從 R2 後台處理",
    "clean.note.unindexed": "重建索引已經處理",
    "clean.note.ghost-book": "重建索引已經處理",
    "clean.incomplete": (missing, wrongSize, chapters, sample) =>
      `${chapters} 章裡` +
      (missing ? `少了 ${missing} 個檔案` : "") +
      (missing && wrongSize ? "、" : "") +
      (wrongSize ? `${wrongSize} 個大小不符` : "") +
      (sample ? `（例如 ${sample}）` : ""),
    "clean.size": (files, bytes, more) =>
      `${files}${more ? "+" : ""} 個檔案，${bwBytes(bytes)}`,
    "clean.bytes": bwBytes,
    "clean.positions": (n) => `${n} 筆閱讀進度`,
    "clean.pointsAt": (id) => `指向 ${id}`,
    "clean.kind.orphan-files": "有檔案沒書目",
    "clean.kind.unindexed": "書架索引漏掉",
    "clean.kind.ghost-book": "索引有書、檔案不見",
    "clean.kind.orphan-audio": "語音快取的書已不在",
    "clean.kind.orphan-slug": "代號指向不存在的書",
    "clean.kind.orphan-position": "進度屬於不存在的書",
    "clean.kind.stray-object": "桶子根目錄的雜物",
    "clean.kind.incomplete-book": "書不完整",
    "clean.kind.bad-manifest": "書目檔壞了，讀不出來",
    "clean.kind.stale-file": "書目沒列到的多餘檔案",
    "clean.kind.bad-prefix": "不合法的書號前綴",

    // 暫時的裝置診斷頁：從書架頁尾搬過來，讀者不需要看到
    "admin.diagH": "裝置診斷",

    // --- 讀者鑰匙管理 (/admin) ---
    "rd.h": "讀者鑰匙",
    "rd.hint": "每台裝置一把鑰匙：把連結傳到裝置上打開就完成登入；裝置遺失就撤銷那把鑰匙。同一位讀者（同代號）可以有多把鑰匙。",
    "rd.user": "讀者代號（留空自動產生）",
    "rd.label": "備註（哪台裝置）",
    "rd.create": "產生鑰匙",
    "rd.empty": "還沒有鑰匙 — 產生第一把，傳到手機上打開。",
    "rd.copy": "複製連結",
    "rd.copied": "已複製",
    "rd.copyFail": "自動複製失敗 — 請手動複製這個連結：",
    "rd.revoke": "撤銷",
    "rd.revokeSure": (user, label) =>
      `撤銷 ${user}${label ? `（${label}）` : ""} 的這把鑰匙？該裝置會被登出，已存的離線章節不受影響。`,
    "rd.created": (user) => `已產生 ${user} 的鑰匙，連結已複製 — 傳到裝置上打開即可。`,
    "rd.createdShown": (user) => `已產生 ${user} 的鑰匙。`,
    "rd.ownerTag": "管理者",
    "rd.ownerOn": "設為管理者",
    "rd.ownerOff": "取消管理者",
    "rd.noOwner": "尚未標記管理者裝置 — 管理者專屬通知（更新等候決定、安裝失敗已回退、更新器失聯）現在不會送給任何人。把自己手機的那把鑰匙設為管理者。",
    "rd.ownerCount": (n) => `管理者裝置：${n} 把鑰匙。只有這些裝置會收到管理者專屬通知。`,
    "rd.ownerTest": "測試管理者通知",
    "rd.ownerTested": (subs, ok) => `已送到 ${subs} 台管理者裝置（推播服務接受 ${ok} 則）。`,
    "rd.ownerNoSubs": "管理者鑰匙都還沒有推播訂閱 — 在那台手機上開一次 app，並在書架底部訂閱通知。",

    // --- 更新（pull-mode 面板） ---
    "up.h": "更新",
    "up.hint": "這台機器自己去上游看有沒有新版本、依照下面的原則決定要不要安裝。全部讀自本機資料庫，這個頁面不會連到上游。",
    "up.running": "目前版本",
    "up.upstream": "上游最新",
    "up.armed": "自動安裝",
    "up.armedYes": "已啟用（更新器持有安裝權杖）",
    "up.armedUnknown": "—（更新器版本太舊，無法回報；重新部署更新器後才看得到）",
    "up.armedNo": "未啟用：更新器沒有安裝權杖，只會檢查、不會安裝。要啟用，請照安裝手冊〈讓它自動更新〉給它 CF_API_TOKEN 與 CF_ACCOUNT_ID。",
    "up.source": "更新來源",
    "up.sourceUnset": "尚未設定更新來源：這台機器收不到任何新版本。請重新執行安裝程式（bootstrap）設定來源，或聯絡當初幫你安裝的人。",
    "up.current": "已是最新",
    "up.waiting": "待您決定",
    "up.waitAttention": "需要您先處理（可能要新增密鑰）",
    "up.unknown": "尚未查到（可能還沒設定更新器）",
    "up.lastCheck": "上次檢查",
    "up.silent": "⚠ 更新器已很久沒有回報 —— 可能已停擺（權杖過期、cron 停了）。到 Cloudflare 檢查 bookworm-updater。",
    "up.updaterVer": "更新器版本",
    "up.lastInstall": "上次安裝",
    "up.never": "尚無",
    "up.mode": "安裝原則",
    "up.modeAuto": "自動（滿 N 天後）",
    "up.modeNotify": "只通知我",
    "up.modePinned": "固定不動",
    "up.soak": "觀察天數",
    "up.save": "儲存原則",
    "up.saved": "✓ 已儲存",
    "up.now": "立即安裝",
    "up.queued": (v) => `已排入安裝：${v}（更新器最多 15 分鐘內開始，完成後這裡會顯示結果）`,
    "up.queuedRow": "已排定安裝",
    "up.queuedPending": (v, at) => `${v}（${at} 排定；更新器最多 15 分鐘內開始）`,
    "up.queuedStale": (v, latest) => `${v} — 但上游已經是 ${latest}，這筆不會執行；請再按一次「立即安裝」`,

    // --- 改進建議（在這裡寫，AI 之後不用密鑰就讀得到，部署時清空） ---
    "fb.h": "改進建議",
    "fb.hint": "隨手記下想改進的地方。AI 開工時會從 GET /api/feedback 讀取（不需密鑰）。做好上線後，AI 會回報處理了哪一則，由你按「完成」清掉 — 還留在這裡的，就是還沒做的。",
    "fb.done": "完成",
    "fb.send": "記下",
    "fb.posted": "✓ 已記下",
  },

  en: {
    // --- library ---
    "lib.loading": "Loading books…",
    "lib.loadFail": (msg) => `Could not load the book list (${msg}). `,
    "lib.retry": "Retry",
    "lib.offlineList": "Offline — showing the last book list. ",
    "lib.meta": (chapters, chars) => `${chapters} chapters · ${Math.round(chars / 1000)}k chars`,
    "lib.chapterN": (n) => `Chapter ${n}`,
    "lib.empty": "No books yet — split one with scripts/split-book.mjs and upload it with scripts/publish-book.mjs.",
    "lib.offlineSave": "Save on this device — reads without a connection",
    "lib.offlineSaved": (n) => `${n} chapters saved — tap to remove`,
    "lib.offlineFail": "Download failed — saving for offline needs a connection.",
    "lib.continue": "Continue",
    "lib.notStarted": "not started",
    "lib.readPct": (pct) => `${pct}% read`,
    "lib.readingAs": "Reading as ",
    "lib.change": "change",
    "lib.bookmarkHint": "Positions and settings follow the key's reader id — synced on every device.",

    // --- the reader key (the door) ---
    "auth.need": "This is a private reader — a key opens the books. Open your key link on this device, or paste the key below.",
    "auth.bad": "That key is not valid, or has been revoked — ask the owner for a new one.",
    "auth.placeholder": "Key or key link",
    "auth.submit": "Unlock",
    "auth.hint": "Keys are minted on /admin — one per device.",
    "auth.changePrompt": "Paste a new key or key link:",

    // --- add-to-Home-Screen guide ---
    "lib.installHint": "Add to Home Screen",
    "guide.h": "Add to Home Screen",
    "guide.why": "Installed as an app, Bookworm opens full-screen, keeps offline reading reliable, and can receive new-book alerts.",
    "guide.ios1": "In Safari, tap the Share button at the bottom (the square with an upward arrow).",
    "guide.ios2": "Scroll down, choose “Add to Home Screen”, then tap “Add”.",
    "guide.other1": "Open the browser menu (⋮).",
    "guide.other2": "Choose “Install app” or “Add to Home Screen”.",
    "guide.done": "From then on, open Bookworm from your Home Screen.",
    "guide.continue": "Keep reading for now",

    // --- new-version notice ---
    "update.available": (b) => `A new version is live (${b}).`,
    "update.reload": "Update now",
    "update.whatsNew": "What's new",
    "update.hideNew": "Hide",
    "lib.build": (b) => `build ${b}`,
    "lib.relnotes": "release notes",
    "lib.relnotesTitle": "What past updates said to readers",
    "lib.relnotesNone": "No release notes to show.",
    "lib.refresh": "refresh",
    "lib.refreshTitle": "Re-download the app from the server (keeps offline chapters)",
    "lib.refreshOffline": "You look offline — refresh anyway?",
    "lib.langSwitch": "中文",
    "lib.langTitle": "Switch interface language",

    // the one key-guarded door in the library footer; it points at /admin
    "lib.admin": "manage",
    "lib.adminTitle": "Upload, retitle, re-slug, delete (needs the admin key)",

    // --- push (new books, new versions) ---
    "push.label": "New-book & update alerts: ",
    "push.blocked": "Blocked — allow notifications in system settings",
    "push.subscribed": "Subscribed · tap to stop",
    "push.subscribe": "Tap to subscribe",
    "push.test": "Test",
    "push.sending": "Sending…",
    "push.notSubscribed": "Not subscribed yet",
    "push.noRow": "The server has no such subscription — subscribe again",
    "push.sent": (status) => `Sent ${status} — the notification should arrive within seconds`,
    "push.rejected": (status, detail) => `Push service replied ${status} ${detail}`.trim(),
    "push.fail": (msg) => `Failed: ${msg}`,
    "push.noSW": "service worker not registered",
    "push.noVapid": "the server has no push key configured",

    // --- routing and errors ---
    "err.badUrl": "Invalid URL",
    "err.expected": "Expected /",
    "err.toLibrary": "go to the library",
    "err.backToLibrary": "← back to the library",
    "reader.loading": "Loading…",
    "err.offlineTitle": "Offline",
    "err.offlineBody": (slug) => `“${slug}” isn't cached on this device. Open it online once, or tap `,
    "err.offlineBodyTail": " on the shelf to save it first, and it will read without a connection. ",
    "err.notFoundTitle": "Book not found",
    "err.notFoundBody": (slug) => `There is no book called “${slug}”. `,
    "err.chapterFail": (msg) => `Failed to load chapter (${msg}). `,

    // --- reader chrome ---
    "ui.library": "Library",
    "ui.contents": "Contents",
    "ui.listen": "Listen",
    "ui.offlineCache": "Offline cache",
    "ui.smaller": "Smaller text",
    "ui.larger": "Larger text",
    "ui.wake": "Keep the screen awake",
    "ui.theme": "Theme (auto/light/dark)",
    "ui.bg": (name) => `Paper colour: ${name}`,
    "ui.writingMode": "Vertical / horizontal",
    "ui.vertBtn": "↕",
    "ui.next": "‹ Next",
    "ui.prev": "Prev ›",
    "ui.close": "Close",
    "ui.syncStatus": "sync status",
    "ui.offlineOff": "Offline cache off",
    "ui.offlineOn": (n) => `Offline cache on — ${n} chapters stored`,
    "ui.offlineAuto": (n) => `Auto-caching nearby chapters (${n} stored) — tap to keep the full window`,

    // --- cross-device bookmark ---
    "jump.synced": (here, there) => `Synced to “${here}”; this device last read “${there}”`,
    "jump.back": "Back to where I was",
    "jump.remote": (there) => `Another device is reading “${there}”`,
    "jump.go": "Go there",

    // --- paper colours ---
    "bg.default": "Default",
    "bg.light-brown": "Light brown",
    "bg.mid-brown": "Mid brown",
    "bg.gold-brown": "Gold brown",
    "bg.dark-brown": "Dark brown",
    "bg.snow-white": "Snow white",
    "bg.pink": "Pink",
    "bg.light-orange": "Light orange",
    "bg.light-yellow": "Light yellow",
    "bg.light-green": "Light green",
    "bg.light-cyan": "Light cyan",
    "bg.light-blue": "Light blue",
    "bg.light-purple": "Light purple",
    "bg.magenta": "Magenta",

    // --- narration ---
    "player.playPause": "Play / pause",
    "player.back": "Back one chunk",
    "player.forward": "Forward one chunk",
    "player.stop": "Stop listening",
    "player.generating": "Generating audio…",
    "player.error": "Audio failed — ▶ retries",
    "player.chunk": (i, n) => `audio ${i}/${n}`,
    "player.packStale": "The offline voice pack needs an update; using the online voice for now.",
    "player.packGo": (mb) => `Re-download (${mb} MB)`,
    "player.packOffer": "Download the offline voice pack to listen without the network.",
    "player.packGet": (mb) => `Download (${mb} MB)`,
    "player.packBusy": (pct) => `Downloading ${pct}%`,
    "player.packDone": "Voice pack ready; the next playback uses the offline voice.",
    "player.packFail": "Download failed — a retry keeps what already landed.",
    "player.report": "Report this sentence",
    "player.reported": "Reported",
    "player.reportFail": "Report failed (test uploads are off on this device)",

    // --- temporary on-device diagnostics ---
    "diag.vh": "vh test",
    "diag.pg": "page-turn test",
    "diag.paged": "full-page test",
    "diag.scroll": "dual-scroll test",
    "diag.speech": "system TTS test",
    "diag.wasm": "WASM TTS test",
    "diag.upload": "Upload diagnostic readouts",
    "diag.uploadHint": "Off means this device's diagnostic pages stop sending readouts to the server; push delivery records are unaffected.",

    // --- upload a book (/admin) ---
    "admin.docTitle": "Bookworm · Manage",
    "admin.toShelf": "← library",
    "admin.h1": "Manage",
    "admin.token": "Admin key (ADMIN_TOKEN)",
    "admin.verify": "Verify and save",
    "admin.verified": "✓ Verified",
    "admin.badToken": "✗ Invalid key",
    "admin.file": "Book file (.txt or .zip; meta.json and a cover may ride along)",
    "admin.bookTitle": "Title",
    "admin.slug": "URL slug",
    "admin.charset": "Encoding",
    "admin.s2t": "Simplified → Traditional",
    "admin.s2tYes": "Convert (default)",
    "admin.s2tAuto": "Auto-detect",
    "admin.s2tNo": "Leave as is",
    "admin.pattern": "Chapter-heading regex (only if detection fails)",
    "admin.analyze": "Find chapters",
    "admin.upload": "Upload",
    "admin.noTxtInZip": "no .txt inside the zip",
    "admin.fromZip": (name, mb) => `Took ${name} out of the zip (${mb} MB)`,
    "admin.enriched": "meta.json found — title, author and synopsis come from the payload (text is UTF-8 by contract)",
    "admin.badMeta": "meta.json is not valid JSON",
    "admin.metaAuthorLine": (a) => `Author: ${a}`,
    "admin.coverReady": (w, h, kb) => `Cover ${w}×${h} (${kb} KB)`,
    "admin.coverFail": (msg) => `⚠ Cover failed, skipped: ${msg}`,
    "admin.converting": "Converting Simplified → Traditional (OpenCC cn→tw)…",
    "admin.alreadyTrad": "Looks Traditional already — skipping conversion",
    "admin.fewHeadings": (n) => `⚠ Only ${n} chapter headings found — the whole book becomes one file; set the heading format in the regex field`,
    "admin.badSlug": "invalid slug",
    "admin.summary": (n, chars) => `${n} chapters, ${chars.toLocaleString()} chars`,
    "admin.chapterLine": (title, chars) => `${title} (${chars.toLocaleString()} chars)`,
    "admin.tokenExpired": "Key no longer valid — verify again",
    "admin.uploaded": (title) => `✓ Uploaded “${title}” — start reading`,
    "admin.uploadStats": (n, mb, s) => `${n} chapters, ${mb} MB, ${s}s`,
    "admin.putRetry": (name, why) => `⚠ Retrying ${name} (${why})`,
    "admin.uploadFail": (msg) => `✗ Upload failed: ${msg}`,

    // book management (same page, revealed once the key checks out)
    "admin.booksH": "Books on the shelf",
    "admin.booksEmpty": "No books yet — upload the first one below.",
    "admin.booksFail": (msg) => `Could not load the book list (${msg})`,
    "admin.edit": "edit",
    "admin.remove": "delete",
    "admin.save": "Save",
    "admin.cancel": "Cancel",
    "admin.uploadH": "Add a book",
    "admin.working": "Working…",
    "admin.noChange": "Nothing changed",
    "admin.titleRequired": "A book needs a title",
    "admin.slugHint": "Files live under a fixed book id, so a new slug only changes the URL: nothing moves, positions stay put, and the old link still resolves.",
    "admin.badSlugChars": "A slug takes lowercase letters, digits, CJK and hyphens, up to 40 characters",
    "admin.reservedSlug": "That name belongs to one of the site's own pages — pick another",
    "admin.idIs": (id) => `book id ${id}`,
    "admin.titleSaved": (title) => `✓ Retitled to “${title}”`,
    "admin.sweeping": (n) => `Cleaning up… ${n} files removed`,
    "admin.stuck": "No progress — aborted",
    "admin.reslugged": (slug) => `✓ Slug is now ${slug} (the old one still works)`,
    "admin.reindexed": (n, pruned) =>
      `✓ Index rebuilt: ${n} books` + (pruned ? `, ${pruned} stale rows dropped` : ""),
    "admin.deleteWarn": (title) =>
      `Permanently delete “${title}”: chapters, cached audio and everyone's reading positions go with it. This cannot be undone.`,
    "admin.deleteConfirm": (slug) => `Type the slug “${slug}” to confirm`,
    "admin.deleteGo": "Delete for good",
    "admin.deleteMismatch": "Slug did not match — nothing was deleted",
    "admin.deleted": (title) => `✓ Deleted “${title}”`,
    "admin.fail": (msg) => `✗ ${msg}`,

    // check, then repair: look first and change nothing, fix only what the
    // check found
    "clean.h": "Check and repair",
    "clean.hint": "Check first, repair only if something turns up. The check only reads, so it is safe to press any time. Repair rebuilds the index, then deletes what nothing can reach — if the shelf does not know about it, nobody can read it, so there is no point rescuing it: delete and upload again.",
    "clean.check": "Health check",
    "clean.fix": "Repair",
    "clean.reindexing": "Rebuilding the index…",
    "clean.scanning": (n) => `Checking… (round ${n})`,
    "clean.healthy": "✓ Everything checks out",
    "clean.found": (n, fixable) =>
      `${n} problem${n === 1 ? "" : "s"} found` +
      (fixable === n ? " — press Repair" : `, ${fixable} of them fixable (see below)`),
    "clean.dropped": (n) => `${n} more than this run would list — check again after repairing`,
    "clean.done": (items, removed) => `✓ Repaired ${items} finding${items === 1 ? "" : "s"}, ${removed} cleared in all`,
    "clean.reportOnly": (n) => `${n} finding${n === 1 ? "" : "s"}, none of them something this page can clear (see below)`,
    "clean.left": (n) => `${n} still not clear — run it again`,
    "clean.cleared": (n) => `✓ Cleared ${n}`,
    // deleting a book whole is the only thing this button does that costs
    // anyone something, so it stops and asks first
    "clean.confirmWarn": (n) =>
      `${n} book${n === 1 ? "" : "s"} will be deleted whole: chapters, cached audio, ` +
      `the shelf entry, and everyone's place in ${n === 1 ? "it" : "them"}. ` +
      `Upload ${n === 1 ? "it" : "them"} again afterwards.`,
    "clean.confirmGo": (n) => n === 1 ? "Delete it for good" : `Delete ${n} books for good`,
    "clean.cancelled": "Cancelled — nothing was cleared",
    "clean.note.swept": "Already gone with the whole book, this run",
    // the one problem only the rebuild can find: a slug collision shows itself
    // when the row is written and nowhere else
    "clean.reindexNote.slug-taken": (id, slug) => `${id}: slug “${slug}” is taken, using ${id}`,
    "clean.note.bad-prefix": "The server cannot address this prefix — handle it in the R2 dashboard",
    "clean.note.unindexed": "Already handled by the index rebuild",
    "clean.note.ghost-book": "Already handled by the index rebuild",
    "clean.incomplete": (missing, wrongSize, chapters, sample) =>
      `of ${chapters} chapters, ` +
      (missing ? `${missing} file${missing === 1 ? "" : "s"} missing` : "") +
      (missing && wrongSize ? ", " : "") +
      (wrongSize ? `${wrongSize} the wrong size` : "") +
      (sample ? ` (e.g. ${sample})` : ""),
    "clean.size": (files, bytes, more) =>
      `${files}${more ? "+" : ""} files, ${bwBytes(bytes)}`,
    "clean.bytes": bwBytes,
    "clean.positions": (n) => `${n} reading position${n === 1 ? "" : "s"}`,
    "clean.pointsAt": (id) => `points at ${id}`,
    "clean.kind.orphan-files": "Files with no manifest",
    "clean.kind.unindexed": "Missing from the shelf index",
    "clean.kind.ghost-book": "Indexed, but the files are gone",
    "clean.kind.orphan-audio": "Audio cache for a book that is gone",
    "clean.kind.orphan-slug": "Slug pointing at a missing book",
    "clean.kind.orphan-position": "Bookmarks for a missing book",
    "clean.kind.stray-object": "Loose object at the bucket root",
    "clean.kind.incomplete-book": "Incomplete book",
    "clean.kind.bad-manifest": "The manifest will not parse",
    "clean.kind.stale-file": "Files the manifest does not name",
    "clean.kind.bad-prefix": "Prefix outside the id alphabet",

    // the temporary on-device diagnostic pages, moved off the library footer
    "admin.diagH": "On-device diagnostics",

    // --- reader keys (/admin) ---
    "rd.h": "Reader keys",
    "rd.hint": "One key per device: open the link on the device and it is signed in; lose a device, revoke its key. One reader id can hold several keys.",
    "rd.user": "Reader id (leave empty to mint one)",
    "rd.label": "Note (which device)",
    "rd.create": "Mint a key",
    "rd.empty": "No keys yet — mint the first one and open its link on your phone.",
    "rd.copy": "copy link",
    "rd.copied": "copied",
    "rd.copyFail": "Copy failed — copy this link by hand:",
    "rd.revoke": "revoke",
    "rd.revokeSure": (user, label) =>
      `Revoke this key for ${user}${label ? ` (${label})` : ""}? That device is signed out; chapters it saved offline are unaffected.`,
    "rd.created": (user) => `Key for ${user} minted, link copied — send it to the device and open it.`,
    "rd.createdShown": (user) => `Key for ${user} minted.`,
    "rd.ownerTag": "owner",
    "rd.ownerOn": "mark as owner",
    "rd.ownerOff": "unmark owner",
    "rd.noOwner": "No device is marked as the owner's — the owner-only notifications (an update waiting for your decision, an install rolled back, the updater gone silent) are not being sent to anyone. Mark the key of your own phone.",
    "rd.ownerCount": (n) => `Owner devices: ${n} key${n === 1 ? "" : "s"}. Only these receive the owner-only notifications.`,
    "rd.ownerTest": "Test owner notification",
    "rd.ownerTested": (subs, ok) => `Sent to ${subs} owner device${subs === 1 ? "" : "s"} (push service accepted ${ok}).`,
    "rd.ownerNoSubs": "None of the owner keys has a push subscription yet — open the app once on that phone and subscribe at the bottom of the shelf.",

    "up.h": "Updates",
    "up.hint": "This machine checks upstream for a new version on its own and decides whether to install it by the policy below. All of it is read from this machine's database — this page never contacts upstream.",
    "up.running": "Running",
    "up.upstream": "Upstream latest",
    "up.armed": "Auto-install",
    "up.armedYes": "Enabled (the updater holds its install token)",
    "up.armedUnknown": "— (this updater is too old to report it; redeploy the updater to see it)",
    "up.armedNo": "Disabled: the updater has no install token, so it only checks and never installs. To enable it, give it CF_API_TOKEN and CF_ACCOUNT_ID as in the install manual's \"Let it update itself\".",
    "up.source": "Update source",
    "up.sourceUnset": "No update source is set — this machine cannot receive new versions. Re-run the installer (bootstrap) to set one, or contact whoever set this machine up.",
    "up.current": "up to date",
    "up.waiting": "Waiting for you",
    "up.waitAttention": "needs a step from you first (maybe a new secret)",
    "up.unknown": "not seen yet (updater may be unconfigured)",
    "up.lastCheck": "Last checked",
    "up.silent": "⚠ The updater hasn't reported in a long time — it may be stuck (expired token, cron stopped). Check bookworm-updater in Cloudflare.",
    "up.updaterVer": "Updater version",
    "up.lastInstall": "Last install",
    "up.never": "never",
    "up.mode": "Install policy",
    "up.modeAuto": "Automatic (after N days)",
    "up.modeNotify": "Notify me only",
    "up.modePinned": "Pinned (stay put)",
    "up.soak": "Soak days",
    "up.save": "Save policy",
    "up.saved": "✓ saved",
    "up.now": "Install now",
    "up.queued": (v) => `Queued for install: ${v} (the updater starts within 15 minutes; the result shows here when done)`,
    "up.queuedRow": "Queued install",
    "up.queuedPending": (v, at) => `${v} (queued ${at}; the updater starts within 15 minutes)`,
    "up.queuedStale": (v, latest) => `${v} — but upstream is now ${latest}, so this will not run; press Install now again`,

    "fb.h": "Improvement notes",
    "fb.hint": "Jot down what should improve. The AI reads these from GET /api/feedback (no key needed) when work starts. Once a fix is live the AI reports which note it addressed and you press Done to clear it — whatever is still here is still undone.",
    "fb.done": "Done",
    "fb.send": "Note it",
    "fb.posted": "✓ noted",
  },
};

function bwLang() {
  const v = localStorage.getItem("bw_lang");
  return v && BW_STRINGS[v] ? v : BW_DEFAULT_LANG;
}

function bwOtherLang() {
  return bwLang() === "zh" ? "en" : "zh";
}

// The document language is not cosmetic: it picks the CJK font fallback when
// ENS Font misses a glyph, and on iOS it decides which dictionary a
// long-press lookup opens.
function bwApplyLang() {
  document.documentElement.lang = bwLang() === "zh" ? "zh-Hant" : "en";
}

function bwSetLang(v) {
  try { localStorage.setItem("bw_lang", v); } catch { /* private mode: this session only */ }
  bwApplyLang();
}

// Missing key → the en string → the key itself, so a half-finished
// translation degrades to something readable instead of blank chrome, and
// stays visible while it does (see BW_FALLBACK_LANG).
function t(key, ...args) {
  const v = BW_STRINGS[bwLang()]?.[key] ?? BW_STRINGS[BW_FALLBACK_LANG][key] ?? key;
  return typeof v === "function" ? v(...args) : v;
}

// One pass over static markup: every [data-i18n] node takes its text from
// the table, [data-i18n-title] its tooltip — so a page ships readable zh
// in its HTML and a language switch re-sweeps in place instead of
// re-rendering (or, on the shelf, re-fetching). Strings with arguments
// stay JS-filled; textContent assignment is also why decorated nodes keep
// their decoration in CSS (see .brand::before), never in child elements.
function applyI18n() {
  for (const node of document.querySelectorAll("[data-i18n]"))
    node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll("[data-i18n-title]"))
    node.title = t(node.dataset.i18nTitle);
}

bwApplyLang();
