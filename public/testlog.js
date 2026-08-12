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
// What it is NOT: protection for the endpoint. POST /api/testlog is
// deliberately open — the service worker has no way to hold a credential, and
// gating the write would blind the log in exactly the case it exists to
// diagnose — so anything that wants to write can still write, curl included.
// A frontend switch is a door on your own house, not on the street.
//
// The service worker's push breadcrumb deliberately does NOT ride this. A SW
// cannot read localStorage, so reaching it would cost a message channel or an
// IndexedDB hop; it is one row per push rather than a loop; and it is the line
// you most want surviving in the field, where "did the phone get it" has no
// other witness.

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
