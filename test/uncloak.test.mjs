import test from "node:test";
import assert from "node:assert/strict";
import { createUncloakFetch, sanitizePayload, sanitizeHeaders } from "../src/uncloak.mjs";

const key = "sk-ant-api03-fake-test-only";
const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
const billing = "x-anthropic-billing-header: cc_version=2.1.280.d7b; cc_entrypoint=cli; cch=00000; cc_turn_origin=human;";
const cliID = JSON.stringify({ device_id: "a".repeat(64), account_uuid: "11111111-2222-4333-8444-555555555555", session_id: "11111111-2222-4333-8444-555555555555" });
const messages = [{ role: "user", content: "Implement the requested change." }];
function fixture() {
  return {
    model: "claude-test-model", max_tokens: 64, stream: true,
    system: [
      { type: "text", text: billing },
      { type: "text", text: identity, cache_control: { type: "ephemeral" } },
      { type: "text", text: "Follow the project's coding rules.", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    messages: structuredClone(messages),
    tools: [{ name: "read_file", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } } }, cache_control: { type: "ephemeral" } }],
    metadata: { user_id: cliID, project: "keep-me" },
    diagnostics: { previous_message_id: null },
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  };
}
const incoming = () => ({
  "User-Agent": "claude-cli/2.1.280 (external, cli)",
  "X-App": "cli", "X-Client-App": "claude-code", "X-Client-Request-Id": "req-cli",
  "X-Anthropic-Additional-Protection": "true",
  "X-Stainless-Runtime": "node", "X-Claude-Code-Session-Id": "session",
  "X-Claude-Remote-Mode": "true", "Anthropic-Dangerous-Direct-Browser-Access": "true",
  "Authorization": "Bearer stale-caller-token", "X-Api-Key": "caller-token",
  "Anthropic-Version": "2023-06-01", "Content-Type": "application/json",
  "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,redact-thinking-2026-02-12,afk-mode-2026-01-31,cache-diagnosis-2026-04-07,interleaved-thinking-2025-05-14,context-1m-2025-08-07,extended-cache-ttl-2025-04-11",
});

test("removes CLI attribution while retaining task instructions and tool inputs", () => {
  const source = fixture(), before = structuredClone(source);
  const out = sanitizePayload(source, true);
  assert.deepEqual(out.system, [before.system[2]]);
  for (const name of ["messages", "tools", "thinking", "output_config", "model", "max_tokens", "stream"]) assert.deepEqual(out[name], before[name]);
  assert.deepEqual(out.metadata, { project: "keep-me" });
  assert.equal(out.diagnostics, undefined);
  assert.deepEqual(source, before, "the caller's input must not be mutated");
});

test("cleans leading combined attribution without losing task text or cache controls", () => {
  const source = { system: [{ type: "text", text: billing + "\n" + identity + "\nKeep this exact instruction.\n", cache_control: { type: "ephemeral" } }] };
  assert.deepEqual(sanitizePayload(source, true).system, [{ ...source.system[0], text: "Keep this exact instruction.\n" }]);
});

test("cleans Magpie's concatenated non-streaming system blocks without eating task assignments", () => {
  const task = "tenant=alice; Keep these project rules exactly.";
  const source = { system: [{ type: "text", text: billing + identity + task, cache_control: { type: "ephemeral", ttl: "5m" } }] };
  assert.deepEqual(sanitizePayload(source, true).system, [{ ...source.system[0], text: task }]);
});

test("preserves quoted attribution inside instructions and non-text system blocks", () => {
  const source = { system: [{ type: "text", text: "Explain this example:\n" + billing }, { type: "image", source: { data: "abc" } }] };
  assert.deepEqual(sanitizePayload(source, false), source);
});

test("omits system when it contains attribution only", () => {
  assert.equal(sanitizePayload({ system: billing + "\n" + identity }, true).system, undefined);
  assert.equal(sanitizePayload({ system: [{ type: "text", text: identity }] }, true).system, undefined);
});

test("supports Agent SDK identity variants", () => {
  for (const text of [
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  ]) assert.equal(sanitizePayload({ system: text }, false).system, undefined);
});

test("ordinary application user metadata and diagnostics survive", () => {
  const source = { messages, metadata: { user_id: "customer-42", other: 1 }, diagnostics: { application_trace: "retain" } };
  assert.deepEqual(sanitizePayload(source, false), source);
});

test("recognized CLI metadata is removed even when gateway headers lost its origin", () => {
  for (const id of [cliID, "user_" + "a".repeat(64) + "_account__session_11111111-2222-4333-8444-555555555555"]) {
    assert.equal(sanitizePayload({ metadata: { user_id: id } }, false).metadata, undefined);
  }
});

test("recognizes CLI diagnostics and keeps unrelated metadata fields", () => {
  assert.deepEqual(sanitizePayload({ metadata: { user_id: cliID, tenant: "x" }, diagnostics: { previous_message_id: "msg" } }, true), { metadata: { tenant: "x" } });
});

test("header cleaning pins credentials and preserves functional beta flags", () => {
  const h = sanitizeHeaders(incoming(), key, sanitizePayload(fixture(), true));
  for (const name of ["x-app", "x-client-app", "x-client-request-id", "x-anthropic-additional-protection", "x-stainless-runtime", "x-claude-code-session-id", "x-claude-remote-mode", "anthropic-dangerous-direct-browser-access", "authorization"]) assert.equal(h.has(name), false, name);
  assert.equal(h.get("x-api-key"), key);
  assert.match(h.get("user-agent"), /^magpie-anthropic-uncloak\//);
  assert.equal(h.get("anthropic-version"), "2023-06-01");
  assert.equal(h.get("anthropic-beta"), "interleaved-thinking-2025-05-14,context-1m-2025-08-07,extended-cache-ttl-2025-04-11");
});

test("removes helper betas when their corresponding payload features are absent", () => {
  const h = sanitizeHeaders({ "anthropic-beta": "cache-diagnosis-2026-04-07,fallback-credit-2026-01-01,extended-cache-ttl-2025-04-11,prompt-caching-scope-2026-01-05" }, key, { messages });
  assert.equal(h.get("anthropic-beta"), "prompt-caching-scope-2026-01-05");
});

test("preserves an ordinary caller's user-agent and workspace selection", () => {
  const h = sanitizeHeaders({ "user-agent": "my-app/1", "anthropic-workspace-id": "wrkspc_test" }, key, {});
  assert.equal(h.get("user-agent"), "my-app/1");
  assert.equal(h.get("anthropic-workspace-id"), "wrkspc_test");
});

test("sanitization is idempotent", () => {
  const once = sanitizePayload(fixture(), true);
  assert.deepEqual(sanitizePayload(once, false), once);
});

test("transport cleans the actual sent payload and removes stale body length", async () => {
  let sent;
  const reply = new Response('{"ok":true}', { status: 200 });
  const f = createUncloakFetch(key, async (url, init) => { sent = { url: String(url), init }; return reply; });
  assert.equal(await f("https://api.anthropic.com/v1/messages?beta=true", {
    method: "POST", headers: { ...incoming(), "content-length": "99999" }, body: JSON.stringify(fixture()),
  }), reply);
  assert.equal(sent.url, "https://api.anthropic.com/v1/messages?beta=true");
  assert.equal(sent.init.redirect, "error");
  assert.equal(sent.init.headers.has("content-length"), false);
  const actual = JSON.parse(sent.init.body);
  assert.equal(actual.system.length, 1);
  assert.deepEqual(actual.tools, fixture().tools);
  assert.equal(sent.init.headers.get("x-api-key"), key);
});

test("supports Request objects and UTF-8 byte bodies", async () => {
  const bodies = [];
  const f = createUncloakFetch(key, async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response("{}"); });
  await f(new Request("https://api.anthropic.com/v1/messages", { method: "POST", headers: incoming(), body: JSON.stringify({ ...fixture(), messages: [{ role: "user", content: "你好" }] }) }));
  await f("https://api.anthropic.com/v1/messages/count_tokens", { method: "POST", headers: incoming(), body: new TextEncoder().encode(JSON.stringify(fixture())) });
  assert.equal(bodies[0].messages[0].content, "你好");
  assert.equal(bodies[1].system.length, 1);
});

test("model listing sends no body", async () => {
  const f = createUncloakFetch(key, async (url, init) => {
    assert.equal(new URL(url).pathname, "/v1/models");
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    return new Response('{"data":[]}');
  });
  await f("https://api.anthropic.com/v1/models");
});

test("refuses foreign origins, unexpected endpoints, and credential URLs before sending", async () => {
  let calls = 0;
  const f = createUncloakFetch(key, async () => { calls++; return new Response("{}"); });
  for (const url of ["https://evil.example/v1/messages", "http://api.anthropic.com/v1/messages", "https://api.anthropic.com.evil.example/v1/messages", "https://api.anthropic.com/v1/other", "https://user:pass@api.anthropic.com/v1/models"]) {
    await assert.rejects(f(url), /Anthropic|endpoint|credentials/i);
  }
  assert.equal(calls, 0);
});

test("refuses missing and OAuth credentials without echoing their values", () => {
  for (const value of ["", "sk-ant-oat01-this-is-not-an-api-key", "sk-ant-api03-key with spaces"]) {
    assert.throws(() => createUncloakFetch(value), (err) => /API key/.test(err.message) && !err.message.includes("this-is-not"));
  }
});

test("malformed or non-object JSON never reaches upstream", async () => {
  let calls = 0;
  const f = createUncloakFetch(key, async () => { calls++; return new Response("{}"); });
  for (const body of ["not json", "null", "[]"]) {
    await assert.rejects(f("https://api.anthropic.com/v1/messages", { method: "POST", body }), /JSON|object/i);
  }
  assert.equal(calls, 0);
});

test("returns upstream errors and SSE without buffering or rewriting", async () => {
  const failure = new Response('{"error":{"message":"credit balance is too low"}}', { status: 400 });
  const f = createUncloakFetch(key, async () => failure);
  assert.equal(await f("https://api.anthropic.com/v1/models"), failure);
  let stream;
  const upstream = new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode("event: message_start\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
  const streaming = createUncloakFetch(key, async () => upstream);
  const res = await streaming("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ messages, stream: true }) });
  assert.equal(res, upstream);
  const reader = res.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "event: message_start\n\n");
  stream.enqueue(new TextEncoder().encode("event: message_stop\n\n"));
  stream.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "event: message_stop\n\n");
  assert.equal((await reader.read()).done, true);
});

test("propagates cancellation and never sends an already-aborted request", async () => {
  let calls = 0;
  const f = createUncloakFetch(key, async (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const ctl = new AbortController();
  const pending = f("https://api.anthropic.com/v1/models", { signal: ctl.signal });
  await new Promise(resolve => setTimeout(resolve, 0));
  ctl.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(f("https://api.anthropic.com/v1/models", { signal: ctl.signal }), /cancelled/);
  assert.equal(calls, 1);
});

test("retains application-owned user IDs even on requests with CLI identity", () => {
  const source = { system: identity, metadata: { user_id: "customer-42", tenant: "a" } };
  assert.deepEqual(sanitizePayload(source, true).metadata, source.metadata);
});

test("preserves task indentation following concatenated attribution", () => {
  const task = "    Indented code\n\tTabbed instruction";
  const out = sanitizePayload({ system: billing + task }, true);
  assert.equal(out.system, task);
});

test("moves a removed identity breakpoint to preceding project instructions", () => {
  const cache = { type: "ephemeral", ttl: "1h" };
  const source = { system: [{ type: "text", text: "Project rules." }, { type: "text", text: identity, cache_control: cache }] };
  const before = structuredClone(source);
  const out = sanitizePayload(source, true);
  assert.deepEqual(out.system, [{ type: "text", text: "Project rules.", cache_control: cache }]);
  assert.deepEqual(source, before);
});

test("retains a removed system breakpoint on the preceding tool prefix", () => {
  const cache = { type: "ephemeral", ttl: "1h" };
  const source = { tools: [{ name: "read_file", input_schema: { type: "object" } }], system: [{ type: "text", text: identity, cache_control: cache }] };
  const before = structuredClone(source);
  const out = sanitizePayload(source, true);
  assert.deepEqual(out.tools, [{ ...source.tools[0], cache_control: cache }]);
  assert.equal(out.system, undefined);
  assert.deepEqual(source, before);
});

test("does not forward caller cookies, proxy credentials or nominated hop headers", () => {
  const h = sanitizeHeaders({
    cookie: "gateway-session=fake", "proxy-authorization": "Basic fake",
    connection: "keep-alive, x-gateway-secret", "x-gateway-secret": "fake",
    "content-encoding": "gzip",
  }, key, {});
  for (const field of ["cookie", "proxy-authorization", "connection", "x-gateway-secret", "content-encoding"]) assert.equal(h.has(field), false, field);
});

test("aborts a slow request-body read with the original reason and zero sends", async () => {
  const ctl = new AbortController();
  const reason = new Error("cancel slow upload");
  let controller, cancelled, calls = 0;
  const body = new ReadableStream({
    start(value) { controller = value; value.enqueue(new TextEncoder().encode("{")); },
    cancel(value) { cancelled = value; },
  });
  const f = createUncloakFetch(key, async () => { calls++; return new Response("{}"); });
  const pending = f("https://api.anthropic.com/v1/messages", { method: "POST", body, duplex: "half", signal: ctl.signal });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    ctl.abort(reason);
    const result = await Promise.race([
      pending.then(() => "unexpected success", error => error),
      new Promise(resolve => setTimeout(() => resolve("timed out"), 100)),
    ]);
    assert.equal(result, reason);
    assert.equal(cancelled, reason);
    assert.equal(calls, 0);
  } finally {
    try { controller.close(); } catch {}
    await pending.catch(() => {});
  }
});

test("preserves exact numeric tokens in tool inputs and other unchanged fields", async () => {
  let sent;
  const f = createUncloakFetch(key, async (_url, init) => { sent = init.body; return new Response("{}"); });
  const source = '{"model":"claude-test-model","max_tokens":64,"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"read","input":{"integer":1234567890123456789,"fraction":1.234567890123456789,"zero":-0}}]}]}';
  await f("https://api.anthropic.com/v1/messages", { method: "POST", body: source });
  assert.match(sent, /"integer":1234567890123456789/);
  assert.match(sent, /"fraction":1\.234567890123456789/);
  assert.match(sent, /"zero":-0/);
});
