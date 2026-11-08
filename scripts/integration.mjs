import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { isolatedEnvironment } from "../test/helpers/environment.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, "test", "fixture-plugin");
const bin = process.env.MAGPIE_TEST_BIN;
assert.ok(bin, "Set MAGPIE_TEST_BIN to a Magpie CLI binary.");
await fs.access(path.join(fixture, "package.json"));
const fakeKey = "sk-ant-api03-fake-integration-only";
const state = path.join(root, ".superpowers", "integration-" + Date.now());
const records = [];
let child;
let logs = "";
const report = { magpie: bin, tests: [], state };

const model = {
  id: "claude-test-model", display_name: "Claude Integration Test", lifecycle: "active",
  type: "model", created_at: "2026-01-01T00:00:00Z",
  max_input_tokens: 200000, max_tokens: 64000,
  capabilities: { thinking: { supported: true }, image_input: { supported: true } },
};
const events = [
  ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_test", name: "read_file", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } }],
  ["message_stop", { type: "message_stop" }],
];
const mock = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : undefined;
    const content = body?.messages?.find(item => item.role === "user")?.content;
    const userText = typeof content === "string" ? content : (content ?? []).filter(item => item.type === "text").map(item => item.text).join("");
    records.push({ path: req.url, headers: req.headers, body, rawBody: text });
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/v1/models")) {
      res.end(JSON.stringify({ data: [model], has_more: false, first_id: model.id, last_id: model.id }));
    } else if (req.url.startsWith("/v1/messages/count_tokens")) {
      const allowed = new Set(["model", "messages", "system", "tools"]);
      assert.ok(Object.keys(body).every(name => allowed.has(name)), "CountTokens request contains generation-only parameters.");
      res.end('{"input_tokens":12}');
    } else if (userText === "return-error") {
      res.statusCode = 400;
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"mock credit balance is too low"}}');
    } else if (body?.stream) {
      res.setHeader("content-type", "text/event-stream");
      res.write("event: " + events[0][0] + "\ndata: " + JSON.stringify(events[0][1]) + "\n\n");
      setTimeout(() => {
        for (const [name, data] of events.slice(1)) res.write("event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n");
        res.end();
      }, 30);
    } else {
      res.end(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: model.id, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } }));
    }
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const gatewayPort = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const address = "http://127.0.0.1:" + gatewayPort;
const env = isolatedEnvironment(process.env, state, gatewayPort, "http://127.0.0.1:" + mock.address().port);
const config = path.join(env.XDG_CONFIG_HOME, "magpie");
await fs.mkdir(config, { recursive: true });
for (const folder of [env.HOME, env.PATH, env.TEMP]) await fs.mkdir(folder, { recursive: true });
await fs.writeFile(path.join(config, "plugins.json"), JSON.stringify({ plugins: [{ spec: fixture }] }));
await fs.writeFile(path.join(config, "plugin-auth.json"), JSON.stringify({ "anthropic-uncloak": { type: "api", key: fakeKey } }));
await fs.writeFile(path.join(config, "settings.json"), JSON.stringify({ noAccountDiscovery: false }));
try {
  // A bare gateway serves its cached provider catalog. Initialize the plugin
  // host first, as adding/signing in through Magpie's UI does.
  console.log("Initializing isolated Magpie plugin host...");
  const setup = spawn(bin, ["plugin", "list", "--json"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let setupOut = "";
  setup.stdout.on("data", value => { setupOut += value; });
  setup.stderr.on("data", value => { logs += value; process.stderr.write(value); });
  const setupTimer = setTimeout(() => setup.kill(), 90_000);
  const [setupCode] = await once(setup, "exit");
  clearTimeout(setupTimer);
  await fs.writeFile(path.join(state, "plugin-list.json"), setupOut);
  assert.equal(setupCode, 0, "Plugin host initialization failed: " + setupOut + logs);
  assert.match(setupOut, /anthropic-uncloak/, "Provider was not loaded: " + setupOut + logs);
  const initialized = JSON.parse(setupOut);
  const loadedModel = initialized.providers?.find(p => p.id === "anthropic-uncloak")?.models?.find(m => m.id === model.id);
  assert.equal(loadedModel?.reasoning, true);
  assert.equal(loadedModel?.image, true);
  assert.equal(loadedModel?.input, 200000);
  child = spawn(bin, ["serve"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", value => { logs += value; process.stdout.write(value); });
  child.stderr.on("data", value => { logs += value; process.stderr.write(value); });
  child.on("error", error => { logs += error.message; });
  const deadline = Date.now() + 100_000;
  let available;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Magpie exited: " + logs.slice(-4000));
    try {
      const response = await fetch(address + "/v1/models", { signal: AbortSignal.timeout(1500), headers: { authorization: "Bearer magpie" } });
      available = await response.json();
      if (available.data?.some(item => item.id === "anthropic-uncloak/" + model.id)) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(available?.data?.some(item => item.id === "anthropic-uncloak/" + model.id), "plugin model not exposed: " + JSON.stringify(available) + "\n" + logs.slice(-4000));
  report.tests.push("plugin loading, API-key credential and live model discovery");
  const input = {
    model: "anthropic-uncloak/" + model.id, max_tokens: 64,
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.280.d7b; cc_entrypoint=cli; cch=00000;" },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "Keep my project instructions.", cache_control: { type: "ephemeral" } },
    ],
    metadata: { user_id: JSON.stringify({ device_id: "a".repeat(64), account_uuid: "11111111-2222-4333-8444-555555555555", session_id: "11111111-2222-4333-8444-555555555555" }) }, diagnostics: { previous_message_id: null },
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "read_file", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
  };
  const headers = {
    authorization: "Bearer magpie", "content-type": "application/json",
    "user-agent": "claude-cli/2.1.280 (external, cli)", "x-app": "cli",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
    "x-stainless-lang": "js", "x-claude-code-session-id": "test-session",
  };
  const call = (endpoint, body) => fetch(address + endpoint, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const normal = await call("/v1/messages", input);
  assert.equal(normal.status, 200, await normal.clone().text());
  // Magpie asks the upstream for an SSE turn even for a non-streaming caller,
  // then returns the accumulated message as JSON.
  const normalBody = await normal.json();
  assert.equal(normalBody.content[0].type, "tool_use", JSON.stringify(normalBody));
  assert.equal(normalBody.content[0].name, "read_file");
  assert.deepEqual(normalBody.content[0].input, { path: "README.md" });
  report.tests.push("non-streaming message");
  const stream = await call("/v1/messages", { ...input, stream: true });
  if (stream.status !== 200) assert.fail(await stream.text());
  const text = await stream.text();
  assert.match(text, /input_json_delta/);
  assert.match(text, /read_file/);
  assert.match(text, /tool_use/);
  assert.match(text, /message_stop/);
  report.tests.push("SSE stream and tool-use JSON");
  const numeric = await call("/v1/messages", {
    ...input, stream: true,
    messages: [
      input.messages[0],
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_previous", name: "read_file", input: { integer: JSON.rawJSON("1234567890123456789") } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_previous", content: "previous result" }] },
    ],
  });
  assert.equal(numeric.status, 200);
  await numeric.text();
  assert.match(records.at(-1).rawBody, /"integer":1234567890123456789/);
  report.tests.push("exact large-integer tool input through real gateway");
  const countInput = { model: input.model, system: input.system, messages: input.messages, tools: input.tools };
  const count = await call("/v1/messages/count_tokens", countInput);
  assert.equal(count.status, 200, await count.clone().text());
  assert.equal((await count.json()).input_tokens, 12);
  report.tests.push("native count_tokens");
  const error = await call("/v1/messages", { ...input, messages: [{ role: "user", content: "return-error" }] });
  assert.equal(error.status, 400);
  assert.match(await error.text(), /mock credit balance is too low/);
  report.tests.push("upstream HTTP 400 passthrough");
  const sent = records.filter(item => item.body);
  assert.ok(sent.length >= 4);
  for (const request of sent) {
    assert.equal(request.headers["x-api-key"], fakeKey);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-app"], undefined);
    assert.equal(request.headers["x-stainless-lang"], undefined);
    assert.equal(request.headers["x-claude-code-session-id"], undefined);
    assert.doesNotMatch(request.headers["user-agent"] ?? "", /claude-cli/);
    assert.doesNotMatch(request.headers["anthropic-beta"] ?? "", /claude-code-|oauth-/);
    assert.equal(request.body.model, model.id);
    assert.equal(JSON.stringify(request.body).includes("x-anthropic-billing-header:"), false);
    assert.equal(request.body.diagnostics, undefined);
    assert.equal(request.body.metadata?.user_id, undefined);
    assert.equal(request.body.system.length, 1);
    assert.equal(request.body.system[0].text, input.system[2].text);
    assert.equal(request.body.system[0].cache_control.type, "ephemeral");
    assert.deepEqual(request.body.tools, input.tools);
  }
  report.tests.push("final outgoing headers/body sanitized; project rules and tools preserved");
  report.ok = true;
  console.log("PASS: real Magpie integration (" + report.tests.length + " checks)");
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
  mock.closeAllConnections();
  await new Promise(resolve => mock.close(resolve));
  await fs.writeFile(path.join(state, "magpie.log"), logs);
  await fs.writeFile(path.join(state, "upstream-requests.json"), JSON.stringify(records, null, 2));
  await fs.writeFile(path.join(state, "report.json"), JSON.stringify(report, null, 2));
}
