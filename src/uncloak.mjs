// Independent implementation of the documented CPA uncloak behavior.
// Source reference and attribution are recorded in README.md.
export const BASE_URL = "https://api.anthropic.com/v1";
export const USER_AGENT = "magpie-anthropic-uncloak/0.1.1";
export const API_VERSION = "2023-06-01";

const identities = new Set([
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
]);
const billing = /^x-anthropic-billing-header:(?:\s*[A-Za-z_]+=[^;\r\n]*;)*\s*$/;
// Magpie's non-streaming bridge can concatenate system blocks without a
// newline. Limit prefix fields to known attribution keys so an instruction
// beginning with an assignment (tenant=alice;) is never swallowed.
const billingPrefix = /^[ \t]*x-anthropic-billing-header:(?:[ \t]*(?:cc_version|cc_entrypoint|cch|cc_turn_origin)=[^;\r\n]*;)+(?:[ \t]*\r?\n)?/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function stripLeadingIdentity(text) {
  let remaining = text;
  for (;;) {
    const prefix = billingPrefix.exec(remaining);
    if (prefix) { remaining = remaining.slice(prefix[0].length); continue; }
    const identity = [...identities].find(value => remaining.startsWith(value));
    if (identity) { remaining = remaining.slice(identity.length).replace(/^\r?\n/, ""); continue; }
    const match = /^([^\r\n]*)(?:\r?\n|$)/.exec(remaining);
    if (!match || (!identities.has(match[1].trim()) && !billing.test(match[1].trim()))) return remaining;
    remaining = remaining.slice(match[0].length);
    if (!remaining) return "";
  }
}

function cliUserID(value) {
  if (typeof value !== "string") return false;
  if (/^user_[a-f0-9]{64}_account_.*_session_[\w-]+$/i.test(value)) return true;
  try {
    const id = JSON.parse(value);
    return object(id) && /^[a-f0-9]{64}$/i.test(id.device_id ?? "") &&
      typeof id.account_uuid === "string" && typeof id.session_id === "string";
  } catch {
    return false;
  }
}

export function sanitizePayload(payload, confirmedClaudeCode = false) {
  if (!object(payload)) throw new TypeError("Uncloak requires a JSON object request.");
  const out = { ...payload };
  let hadIdentity = false;
  if (typeof payload.system === "string") {
    const text = stripLeadingIdentity(payload.system);
    hadIdentity = text !== payload.system;
    if (text) out.system = text;
    else delete out.system;
  } else if (Array.isArray(payload.system)) {
    const kept = [];
    const retainBreakpoint = control => {
      if (!object(control)) return;
      for (let index = kept.length - 1; index >= 0; index--) {
        if (kept[index]?.type === "text") {
          kept[index] = { ...kept[index], cache_control: { ...control } };
          return;
        }
      }
      // Tool definitions precede system text in Anthropic's cache prefix.
      if (Array.isArray(out.tools) && object(out.tools.at(-1))) {
        out.tools = out.tools.slice();
        out.tools[out.tools.length - 1] = { ...out.tools.at(-1), cache_control: { ...control } };
      }
    };
    for (const block of payload.system) {
      if (block?.type !== "text" || typeof block.text !== "string") { kept.push(block); continue; }
      const text = stripLeadingIdentity(block.text);
      if (text !== block.text) hadIdentity = true;
      if (text === block.text || text.trim()) kept.push({ ...block, text });
      else retainBreakpoint(block.cache_control);
    }
    out.system = kept;
    if (!out.system.length) delete out.system;
  }
  const fromCLI = confirmedClaudeCode || hadIdentity;
  if (object(payload.metadata) && Object.hasOwn(payload.metadata, "user_id") &&
      cliUserID(payload.metadata.user_id)) {
    out.metadata = { ...payload.metadata };
    delete out.metadata.user_id;
    if (!Object.keys(out.metadata).length) delete out.metadata;
  }
  if (Object.hasOwn(payload, "diagnostics") &&
      (fromCLI || (object(payload.diagnostics) && Object.hasOwn(payload.diagnostics, "previous_message_id")))) {
    delete out.diagnostics;
  }
  return out;
}

function hasOneHourCache(payload) {
  const stack = [payload];
  while (stack.length) {
    const item = stack.pop();
    if (item === null || typeof item !== "object") continue;
    if (item.cache_control?.ttl === "1h") return true;
    for (const value of Object.values(item)) {
      if (value !== null && typeof value === "object") stack.push(value);
    }
  }
  return false;
}

export function sanitizeHeaders(input, apiKey, payload = {}) {
  const headers = new Headers(input);
  for (const name of (headers.get("connection") ?? "").split(",").map(value => value.trim()).filter(Boolean)) {
    headers.delete(name);
  }
  for (const name of [...headers.keys()]) {
    if (/^(?:x-app|x-client-app|x-client-request-id|x-anthropic-additional-protection|anthropic-dangerous-direct-browser-access|authorization|cookie|cookie2|proxy-authorization|proxy-authenticate|proxy-connection|connection|keep-alive|transfer-encoding|te|trailer|upgrade|content-length|content-encoding|content-md5|digest|host)$/i.test(name) ||
        /^(?:x-stainless-|x-claude-code-|x-claude-remote-)/i.test(name)) headers.delete(name);
  }
  if (!headers.get("user-agent") || /^claude-cli\//i.test(headers.get("user-agent"))) headers.set("user-agent", USER_AGENT);
  const betas = (headers.get("anthropic-beta") ?? "").split(",").map(x => x.trim()).filter(Boolean).filter(beta => {
    if (/^(?:claude-code-|oauth-|redact-thinking-|afk-mode-)/.test(beta)) return false;
    if (beta.startsWith("cache-diagnosis-") && !Object.hasOwn(payload, "diagnostics")) return false;
    if (beta.startsWith("fallback-credit-") && !Object.hasOwn(payload, "fallback_credit_token")) return false;
    if (beta.startsWith("extended-cache-ttl-") && !hasOneHourCache(payload)) return false;
    return true;
  });
  if (betas.length) headers.set("anthropic-beta", [...new Set(betas)].join(","));
  else headers.delete("anthropic-beta");
  headers.set("x-api-key", apiKey);
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", API_VERSION);
  return headers;
}

function checkKey(key) {
  if (typeof key !== "string" || !/^sk-ant-[A-Za-z0-9_-]+$/.test(key) || /^sk-ant-(?:oat|ort)/.test(key)) {
    throw new TypeError("Use a valid Anthropic API key, not a subscription OAuth token.");
  }
}

function allowedURL(input, method) {
  const url = new URL(input);
  if (url.origin !== "https://api.anthropic.com" || url.username || url.password) {
    throw new TypeError("Credentials may only be sent to the official Anthropic API origin.");
  }
  if (!((method === "GET" && url.pathname === "/v1/models") ||
        (method === "POST" && ["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)))) {
    throw new TypeError("Unsupported Anthropic API endpoint or method.");
  }
  return url;
}

class RuntimeCompatibilityError extends Error {}

// JSON.rawJSON preserves large integers, exact decimals and -0 in untouched
// messages/tools. A runtime without this capability must fail rather than
// silently changing user data. Verified on Magpie's Bun 1.4.2.
function parseExactJSON(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value !== "number") return value;
    if (typeof JSON.rawJSON !== "function" || typeof context?.source !== "string") {
      throw new RuntimeCompatibilityError("Anthropic Uncloak needs a newer Bun runtime with lossless JSON support. Update Magpie's plugin runtime.");
    }
    return JSON.rawJSON(context.source);
  });
}

async function readPayload(request) {
  if (!request.body) throw new TypeError("Missing JSON request body.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel(request.signal.reason).catch(() => {}); };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    let text = "";
    for (;;) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      request.signal.throwIfAborted();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return parseExactJSON(text);
  } finally {
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** Final HTTP hop: preserves Magpie's fetch/proxy implementation and response stream. */
export function createUncloakFetch(apiKey, send = globalThis.fetch) {
  checkKey(apiKey);
  return async function uncloakFetch(input, init = {}) {
    const request = new Request(input, init);
    const url = allowedURL(request.url, request.method);
    request.signal.throwIfAborted();
    let payload = {};
    let body;
    if (request.method === "POST") {
      try { payload = await readPayload(request); }
      catch (error) {
        request.signal.throwIfAborted();
        if (error instanceof RuntimeCompatibilityError) throw error;
        throw new TypeError("Uncloak requires a valid UTF-8 JSON object request.");
      }
      const cli = /^claude-cli\//i.test(request.headers.get("user-agent") ?? "") ||
        request.headers.get("x-app") === "cli" ||
        (request.headers.get("anthropic-beta") ?? "").split(",").some(x => x.trim().startsWith("claude-code-"));
      payload = sanitizePayload(payload, cli);
      body = JSON.stringify(payload);
    }
    request.signal.throwIfAborted();
    const headers = sanitizeHeaders(request.headers, apiKey, payload);
    if (body !== undefined) headers.set("content-type", "application/json");
    return send(url.toString(), {
      ...init, method: request.method, headers, body,
      signal: request.signal, redirect: "error",
    });
  };
}
