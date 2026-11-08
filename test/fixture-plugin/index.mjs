// TEST ONLY: production origin validation still runs, then this adapter
// rewrites the HTTP hop to a local fake Anthropic server. Never packaged.
import plugin from "../../index.mjs";

const target = new URL(process.env.MAGPIE_UNCLOAK_TEST_UPSTREAM);
if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") throw new Error("Integration fixture requires a loopback mock.");
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const source = new URL(input instanceof Request ? input.url : input);
  if (source.origin === "https://api.anthropic.com") {
    return originalFetch(new URL(source.pathname + source.search, target), init);
  }
  return originalFetch(input, init);
};
export default plugin;
