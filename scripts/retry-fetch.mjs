// Shared fetch for the e2e scripts that drive a local `wrangler dev` while
// also shelling out to `wrangler d1 execute` / `r2 object put` between
// requests. Those shell-outs take seconds; undici keeps the HTTP connection
// pooled across them, and workerd closes a socket that has gone idle that
// long. The next request is written to the dead connection and throws
// UND_ERR_SOCKET ("other side closed") — bytes written, none read. Undici
// will not replay it, because it cannot know a PUT is safe to repeat. We can:
// the server never read the request, so nothing happened twice.
//
// Import it as `fetch` to shadow the global for the whole module:
//   import { fetch } from "./retry-fetch.mjs";
//
// Deliberately narrow. Only UND_ERR_SOCKET retries, so a worker that never
// booted still fails on the first try instead of three; and only the pooled
// -socket race is papered over, never a real 5xx from the worker under test.

const nativeFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const fetch = async (...args) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await nativeFetch(...args);
    } catch (e) {
      if (attempt >= 2 || e?.cause?.code !== "UND_ERR_SOCKET") throw e;
      await sleep(100);
    }
  }
};
