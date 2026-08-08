// Bookworm service worker: offline support.
//
// - app shell (/, app.css, app.js, player.mjs, tts-core.mjs) — network-first
//   with a short timeout, cache fallback: the page opens with no (or a
//   stalling) connection but updates normally when online
// - /books/**/*.txt — cache-first: chapter files are immutable, and the PAGE
//   decides which ones are cached (the ±window in app.js updateOfflineWindow)
// - /books/**/manifest.json — network-first, cache fallback
// - /api/* — untouched (position sync has its own offline handling)
//
// The timeout matters on iOS: a dying cellular connection doesn't reject
// fetches, it hangs them for 60+ s — which reads as "the app doesn't work
// offline". After NET_MS we serve the cached copy; the network fetch keeps
// running (waitUntil) so the cache still gets refreshed for next time.
//
// NET_MS only ever shortcuts to something already cached (see the
// `res ?? cached ?? net` in each handler): with no cached copy the handler
// still waits the network out, because there is nothing else to serve. That
// is what makes a cap this short safe — one second of patience is the most
// a re-open can cost, and a build that lost the race arrives on the next
// one (checkVersion in app.js is what makes that visible).

// NOTE: fonts and icons are served cache-first out of this cache and their
// URLs are unversioned — bump the shell version whenever either set changes,
// or installed devices keep the old asset forever.
const SHELL = "bw-shell-v14";
// The offline TTS engine's big binaries live in their own bw-wasmtts cache,
// but its four small same-origin files ride the shell, because /wasmtest
// downloads only the voice pack: without these, the first ensureEngine() on a
// device that has gone offline since would fetch them from a dead network and
// fail into the online engine, holding a complete voice pack it could not use.
// ort's loader glue additionally *has* to be a real URL — ort import()s it, and
// a blob cannot satisfy that in a classic worker. All are unversioned like the
// fonts: bump SHELL when the ort pin or any of the modules moves.
const SHELL_ASSETS = ["/", "/app.css", "/i18n.js", "/app.js", "/player.mjs", "/tts-core.mjs", "/wasm-tts.mjs", "/matcha-fst.js", "/matcha-frontend.js", "/matcha-synthesis.js", "/vendor/wasmtts/ort-wasm-simd-threaded.mjs", "/manifest.webmanifest"];
const NET_MS = 1000; // mirrors NET_MS in app.js — the same line, drawn twice

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys())
        if (k.startsWith("bw-shell-") && k !== SHELL) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/books/")) {
    e.respondWith(
      url.pathname.endsWith("manifest.json")
        ? manifestFetch(e)
        : cacheFirst(e.request),
    );
    return;
  }
  if (url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/icons/")) {
    e.respondWith(assetFetch(e.request));
    return;
  }
  if (e.request.mode === "navigate") {
    e.respondWith(navFetch(e));
    return;
  }
  if (SHELL_ASSETS.includes(url.pathname)) e.respondWith(shellFetch(e));
});

// the network fetch, kept alive past an early cache response so a late
// success still lands in `save`; resolves null instead of hanging > NET_MS
function timedNetwork(e, save) {
  const net = fetch(e.request).then((res) => {
    if (res.ok && save) e.waitUntil(save(res.clone()));
    return res;
  });
  e.waitUntil(net.catch(() => {}));
  return Promise.race([
    net.catch(() => null),
    new Promise((r) => setTimeout(() => r(null), NET_MS)),
  ]).then((res) => ({ res, net }));
}

async function cacheFirst(req) {
  return (await caches.match(req)) ?? fetch(req);
}

// fonts and PWA icons are immutable: serve from cache, fill on first fetch
// (kept out of SHELL_ASSETS so a slow 6 MB font can't fail SW install)
async function assetFetch(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
  return res;
}

// reader routes are all the same SPA shell — offline, any of them serves "/",
// and "/" itself now resumes the open book, so it is the navigation an
// installed phone makes on every reopen. Only "/" may refresh the cached
// copy: /admin is a DIFFERENT document served by the worker and must never
// be stored as the shell.
async function navFetch(e) {
  const path = new URL(e.request.url).pathname;
  const { res, net } = await timedNetwork(e, path === "/"
    ? (copy) => caches.open(SHELL).then((c) => c.put("/", copy))
    : null);
  return res ?? (await caches.match("/")) ?? net;
}

async function shellFetch(e) {
  const { res, net } = await timedNetwork(e, (copy) =>
    caches.open(SHELL).then((c) => c.put(e.request, copy)));
  return res ?? (await caches.match(e.request)) ?? net;
}

// A breadcrumb to the testlog table, one row per push. The service worker
// is the ONLY place that can say whether a push the push service accepted
// actually reached this device — there is no console to read on an iPhone,
// and the page is usually not even running when a push lands. It earned its
// keep immediately: "系統列出 2 則" is what proved iOS had DELIVERED two
// notifications and was suppressing them for 專注模式, rather than the app
// failing to send. Read it back with /api/testlog?page=push.
function swlog(data) {
  return fetch("/api/testlog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page: "push", device: "sw", data: `${SHELL} ${data}` }),
  }).catch(() => {});
}

// lets the page ask which service worker is actually in charge: an old
// cached SW simply never answers, which is itself the diagnosis
self.addEventListener("message", (e) => {
  if (e.data !== "version") return;
  const reply = { sw: SHELL };
  if (e.ports?.[0]) e.ports[0].postMessage(reply);
  else e.source?.postMessage(reply);
});

// Web Push: 新書上架 (pushNewBook) and 新版本已上線 (announceBuild), both in
// the worker. Nothing here is per-kind — the payload carries the title, body
// and tap target — so a new kind of announcement needs no service worker
// change, and therefore no SHELL bump to reach installed phones. iOS requires
// every push event to show a notification: no silent pushes, no quiet badge.
self.addEventListener("push", (e) => {
  let d = {};
  let parsed = "json";
  try {
    d = e.data?.json() ?? {};
  } catch {
    parsed = "opaque:" + (e.data?.text?.() ?? "").slice(0, 40);
  }
  e.waitUntil((async () => {
    let shown = "ok";
    try {
      await self.registration.showNotification(d.title ?? "Bookworm", {
        body: d.body ?? "",
        data: { url: d.url ?? "/" },
      });
    } catch (err) {
      shown = "showNotification 失敗 " + (err?.name ?? "") + " " + (err?.message ?? err);
    }
    let listed = -1;
    try { listed = (await self.registration.getNotifications()).length; } catch { /* iOS may not list */ }
    const badged = await setBadge(listed);
    await swlog(`收到推播 "${d.title ?? "?"}" (${parsed}) → ${shown}；系統列出 ${listed} 則；${badged}`);
  })());
});

// The red dot on the app icon is NOT a side effect of showing a notification —
// on iOS the app has to ask for it, through the Badging API, and only an
// installed (Home Screen) app with notification permission gets one. The count
// is however many of our notifications iOS still has in the tray; when it
// won't say (getNotifications unsupported), one push means at least one unread.
// Reported into the push log because a phone is the only place this can be
// observed and there is no console on it.
async function setBadge(listed) {
  const n = listed > 0 ? listed : 1;
  if (!self.navigator?.setAppBadge) return "無 badge API";
  try {
    await self.navigator.setAppBadge(n);
    return `badge ${n}`;
  } catch (err) {
    return "setAppBadge 失敗 " + (err?.name ?? "") + " " + (err?.message ?? err);
  }
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    // opening the app is what marks the news read (the page clears it too, for
    // the case where the app is opened from the Home Screen instead)
    try { await self.navigator?.clearAppBadge?.(); } catch { /* not installed */ }
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins[0]) return wins[0].focus();
    return self.clients.openWindow(e.notification.data?.url ?? "/");
  })());
});

// fresh manifest when online; keep the offline copy current if the book has
// an offline cache (created by the page when the toggle is on)
async function manifestFetch(e) {
  const { res, net } = await timedNetwork(e, async (copy) => {
    // /books/<book-id>/manifest.json — the id, not the slug: offline caches
    // are named after the thing that cannot be renamed out from under them
    const id = decodeURIComponent(new URL(e.request.url).pathname.split("/")[2]);
    if (await caches.has(`bw-book-${id}`))
      await (await caches.open(`bw-book-${id}`)).put(e.request, copy);
  });
  return res ?? (await caches.match(e.request)) ?? net;
}
