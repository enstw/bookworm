// Microsoft Edge "read aloud" TTS over WebSocket, runnable inside a Worker.
// Speaks the protocol of the edge-tts Python package: one wss connection per
// synthesis, speech.config + SSML in, MP3 audio frames out (24 kHz 48 kbps
// mono). Free, no API key — the endpoint authenticates with a time-derived
// Sec-MS-GEC hash of a public client token.

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_HOST = "speech.platform.bing.com";
const WSS_PATH = "/consumer/speech/synthesize/readaloud/edge/v1";
// keep in sync with the edge-tts Python package's CHROMIUM_FULL_VERSION —
// Microsoft appears to reject tokens claiming stale browser versions
const CHROMIUM_FULL = "143.0.3650.75";
const CHROMIUM_MAJOR = CHROMIUM_FULL.split(".")[0];
const SYNTH_TIMEOUT_MS = 30_000;

// Sec-MS-GEC: uppercase SHA-256 hex of "<windows ticks floored to 5 min><token>".
// The tick count deliberately goes through double-precision multiplication
// (ticks * 1e7 overflows 2^53): the server validates against the original
// Edge JS client's rounding, and the Python reference mimics it the same way.
// BigInt(double) then prints that double's exact integer value.
async function secMsGec() {
  const unix = Math.floor(Date.now() / 1000);
  const floored = unix - (unix % 300);
  const ticks = (floored + 11644473600) * 10_000_000;
  const data = new TextEncoder().encode(`${BigInt(ticks)}${TRUSTED_CLIENT_TOKEN}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

const escapeXml = (s) =>
  s.replace(/[&<>'"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" }[c]),
  );

function ssml(text, voice, lang) {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${voice}'>${escapeXml(text)}</voice></speak>`
  );
}

// text → Uint8Array of MP3 bytes
export async function edgeSynthesize(text, voice = "zh-TW-HsiaoChenNeural") {
  const lang = voice.split("-").slice(0, 2).join("-");
  const connectionId = crypto.randomUUID().replaceAll("-", "");
  const url =
    `https://${WSS_HOST}${WSS_PATH}` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${await secMsGec()}` +
    `&Sec-MS-GEC-Version=1-${CHROMIUM_FULL}` +
    `&ConnectionId=${connectionId}`;

  const resp = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
      Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
        `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 ` +
        `Edg/${CHROMIUM_MAJOR}.0.0.0`,
    },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`edge-tts upgrade failed: HTTP ${resp.status}`);
  ws.accept();

  const ts = new Date().toString();
  ws.send(
    `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`,
  );
  ws.send(
    `X-RequestId:${connectionId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n` +
    ssml(text, voice, lang),
  );

  const parts = []; // Promise<Uint8Array|null> per binary frame
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("edge-tts timed out"));
    }, SYNTH_TIMEOUT_MS);
    const fail = (err) => { clearTimeout(timer); reject(err); };

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        if (!ev.data.includes("Path:turn.end")) return; // turn.start / response / audio.metadata
        clearTimeout(timer);
        ws.close();
        // binary frames may still be draining (workerd delivers Blobs) —
        // settle them all before concatenating
        Promise.all(parts).then((frames) => {
          const audio = frames.filter(Boolean);
          if (!audio.length) return reject(new Error("edge-tts returned no audio"));
          const out = new Uint8Array(audio.reduce((n, p) => n + p.length, 0));
          let off = 0;
          for (const p of audio) { out.set(p, off); off += p.length; }
          resolve(out);
        }, fail);
        return;
      }
      // binary frame (ArrayBuffer or Blob depending on runtime):
      // 2-byte big-endian header length, then header, then audio payload
      const ab = ev.data instanceof ArrayBuffer ? Promise.resolve(ev.data) : ev.data.arrayBuffer();
      parts.push(
        ab.then((raw) => {
          const buf = new Uint8Array(raw);
          const headerLen = (buf[0] << 8) | buf[1];
          const header = new TextDecoder().decode(buf.subarray(2, 2 + headerLen));
          return header.includes("Path:audio") ? buf.subarray(2 + headerLen) : null;
        }),
      );
    });
    ws.addEventListener("error", () => fail(new Error("edge-tts socket error")));
    ws.addEventListener("close", (ev) => {
      // resolves above on turn.end; a close before that is a failure
      fail(new Error(`edge-tts closed early (${ev.code})`));
    });
  });
}
