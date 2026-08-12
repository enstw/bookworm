"use strict";
// The one place the on-device diagnostic pages POST their readouts through,
// and the one place the switch that silences them lives.
//
// It used to be five copies of the same six lines — one per page — which is
// five places to forget when the rule changes. The switch is the reason to
// finally collapse them: a flag checked in five copies is a flag that works in
// four.
//
// What this switch IS: a courtesy to your own phones. Six pages uploading on a
// 1 s re-render loop will bury the newest-500 window by themselves, and the
// window is the whole point of the table.
//
// What it is NOT: the gate. POST /api/testlog wants the bw_tlog cookie that
// /admin mints (see testlogSessionOk in the worker) — a door on the street,
// and a different door from this one. Nothing here reads or sends that cookie:
// it rides sendBeacon by itself, which is the entire reason the credential is
// a cookie and not a header. This switch is the door on your own house, and
// its job is that six pages on a re-render loop do not bury the log.
//
// The service worker's push breadcrumb deliberately does NOT ride this. A SW
// cannot read localStorage, so reaching it would cost a message channel or an
// IndexedDB hop; it is one row per push rather than a loop; and it is the line
// you most want surviving in the field, where "did the phone get it" has no
// other witness. The cookie it needs, it gets for free.

var BW_TESTLOG_KEY = "bw_testlog";

function bwTestlogOn() {
  try {
    return localStorage.getItem(BW_TESTLOG_KEY) !== "0";
  } catch {
    return true; // private mode: default to useful over quiet
  }
}

function bwTestlogSet(on) {
  try { localStorage.setItem(BW_TESTLOG_KEY, on ? "1" : "0"); } catch { /* private mode */ }
}

// Announced once per page, because the failure mode of a forgotten switch is
// silent: you curl the log, see nothing, and blame the phone. These pages are
// read through a remote inspector anyway — that is what they are for.
var bwTestlogWarned = false;

function bwTestlogSend(page, device, data) {
  if (!bwTestlogOn()) {
    if (!bwTestlogWarned) {
      bwTestlogWarned = true;
      console.log("bookworm: testlog uploads are OFF for this device (/admin → 裝置診斷)");
    }
    return false;
  }
  var body = JSON.stringify({ page: page, device: device, data: data });
  try {
    if (!navigator.sendBeacon?.("/api/testlog", new Blob([body], { type: "application/json" })))
      fetch("/api/testlog", {
        method: "POST", headers: { "content-type": "application/json" }, body: body,
      }).catch(() => {});
  } catch { /* offline is fine */ }
  return true;
}
