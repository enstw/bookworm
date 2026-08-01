// Shared CDP client — the part every browser-driving script had pasted in:
// spawn a headless Chromium (via find-browser.mjs discovery), wait for the
// DevTools endpoint, open the WebSocket, and expose the three primitives the
// callers are written in. Everything above this line of abstraction (nav
// settle times, waitFor loops, screenshots, finish/cleanup) deliberately
// stays in each script: those are the parts that differ, and hiding a
// 1200 ms vs 1500 ms settle inside a helper is how timings drift unreviewed.
//
// Runs under node ≥22 (native fetch/WebSocket).

import { spawn } from "node:child_process";
import { findBrowser } from "./find-browser.mjs";

// launch({ port, profile, args, onFail }) →
//   { proc, send, evalJs, close, sessionId, targetId }
//
// - args: extra browser flags (--window-size, autoplay policy, …)
// - onFail: cleanup to run if the browser never comes up (e.g. close the
//   script's static server) — the process is already killed by then
// - send is the raw CDP call, for the suites that reach past the basics
//   (Emulation.*, Page.addScriptToEvaluateOnNewDocument, screenshots)
export async function launch({ port, profile, args = [], onFail } = {}) {
  const { bin, env } = findBrowser();
  const proc = spawn(bin, [
    "--headless=new", `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu",
    "--no-sandbox", "--disable-dev-shm-usage", ...args,
  ], { stdio: "ignore", env });

  const deadline = Date.now() + 20000;
  let wsUrl;
  while (true) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
      break;
    } catch {
      if (Date.now() > deadline) {
        proc.kill();
        onFail?.();
        throw new Error("browser never came up");
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const sock = new WebSocket(wsUrl);
  await new Promise((r) => (sock.onopen = r));
  let id = 0;
  const pending = new Map();
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      sock.send(JSON.stringify({ id: i, method, params, sessionId }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);

  const evalJs = async (expression) => {
    const { result, exceptionDetails } = await send(
      "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (exceptionDetails) throw new Error("page threw: " + (exceptionDetails.exception?.description ?? exceptionDetails.text));
    return result.value;
  };

  const close = async () => {
    await send("Target.closeTarget", { targetId });
    proc.kill();
  };

  return { proc, send, evalJs, close, sessionId, targetId };
}
