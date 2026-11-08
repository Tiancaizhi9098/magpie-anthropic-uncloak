import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.mjs";
import { discoverModels } from "../src/models.mjs";

const key = "sk-ant-api03-fake-test-only";
const auth = { type: "api", key };
async function withFetch(send, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = send;
  try { return await callback(); } finally { globalThis.fetch = original; }
}
const model = {
  id: "claude-test-model", display_name: "Claude Test", lifecycle: "active",
  max_input_tokens: 200000, max_tokens: 64000,
  capabilities: {
    thinking: { supported: true }, image_input: { supported: true },
    effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: false } },
  },
};

test("registers a distinct API-key provider with an official API endpoint", async () => {
  const hooks = await plugin({});
  const cfg = {};
  await hooks.config(cfg);
  const p = cfg.provider["anthropic-uncloak"];
  assert.equal(p.name, "Anthropic Uncloak");
  assert.equal(p.npm, "@ai-sdk/anthropic");
  assert.equal(p.api, "https://api.anthropic.com/v1");
  assert.equal(p.searches, true);
  assert.equal(hooks.auth.provider, "anthropic-uncloak");
  assert.equal(hooks.auth.methods.length, 1);
  assert.equal(hooks.auth.methods[0].type, "api");
  assert.equal(hooks.provider.id, "anthropic-uncloak");
  assert.equal(hooks.auth.usage, undefined, "must not invent a promotional credit balance");
});

test("respects a user's existing provider declaration", async () => {
  const hooks = await plugin({});
  const original = { name: "My label", models: { x: {} } };
  const cfg = { provider: { "anthropic-uncloak": original } };
  await hooks.config(cfg);
  assert.equal(cfg.provider["anthropic-uncloak"], original);
});

test("loader does not create a transport for a missing or OAuth credential", async () => {
  const hooks = await plugin({});
  assert.deepEqual(await hooks.auth.loader(async () => undefined), {});
  await assert.rejects(hooks.auth.loader(async () => ({ type: "oauth", access: "private-value" })), /API key/);
});

test("loader uses the final uncloak hop rather than ordinary Anthropic passthrough", async () => {
  let sent;
  await withFetch(async (url, init) => { sent = { url, init }; return new Response('{"ok":true}'); }, async () => {
    const hooks = await plugin({});
    const opts = await hooks.auth.loader(async () => auth);
    assert.equal(opts.baseURL, "https://api.anthropic.com/v1");
    const response = await opts.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "user-agent": "claude-cli/2.1.280", "x-app": "cli" },
      body: JSON.stringify({ model: "claude-test-model", system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(sent.init.headers.get("x-api-key"), key);
    assert.equal(sent.init.headers.has("x-app"), false);
    assert.equal(JSON.parse(sent.init.body).system, undefined);
  });
});

test("separate account loaders never reuse each other's API keys", async () => {
  const keys = [];
  await withFetch(async (_url, init) => { keys.push(init.headers.get("x-api-key")); return new Response("{}"); }, async () => {
    const hooks = await plugin({});
    const first = await hooks.auth.loader(async () => auth);
    const second = await hooks.auth.loader(async () => ({ type: "api", key: "sk-ant-api03-second-fake-key" }));
    await first.fetch("https://api.anthropic.com/v1/models");
    await second.fetch("https://api.anthropic.com/v1/models");
    assert.deepEqual(keys, [key, "sk-ant-api03-second-fake-key"]);
  });
});

test("discovers paginated account models and maps documented capabilities", async () => {
  const urls = [];
  const prior = { "claude-test-model": { cost: { input: 3 }, variants: { medium: {} } } };
  const found = await discoverModels(key, prior, async (url, init) => {
    urls.push(new URL(url));
    assert.equal(init.headers.get("x-api-key"), key);
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(urls.length === 1 ?
      { data: [model], has_more: true, last_id: model.id } :
      { data: [{ id: "claude-small-test", display_name: "Small", capabilities: { thinking: { supported: false }, image_input: { supported: false } } }, { id: "claude-retired", lifecycle: "retired" }], has_more: false });
  });
  assert.equal(urls[1].searchParams.get("after_id"), model.id);
  assert.deepEqual(Object.keys(found), ["claude-test-model", "claude-small-test"]);
  assert.equal(found[model.id].name, "Claude Test");
  assert.deepEqual(found[model.id].cost, { input: 3 });
  assert.deepEqual(found[model.id].limit, { context: 200000, input: 200000, output: 64000 });
  assert.deepEqual(found[model.id].modalities, { input: ["text", "image"], output: ["text"] });
  assert.deepEqual(found[model.id].variants, { low: {}, high: {} });
  assert.equal(found["claude-small-test"].reasoning, false);
  assert.deepEqual(found["claude-small-test"].modalities.input, ["text"]);
  assert.equal(found["claude-small-test"].limit, undefined, "unknown limits must not be invented");
});

test("model hook obtains the current account key", async () => {
  await withFetch(async (_url, init) => {
    assert.equal(init.headers.get("x-api-key"), key);
    return Response.json({ data: [model], has_more: false });
  }, async () => {
    const hooks = await plugin({});
    const found = await hooks.provider.models({ models: {} }, { auth });
    assert.deepEqual(Object.keys(found), [model.id]);
  });
});

test("no-key discovery retains the supplied catalog without network access", async () => {
  await withFetch(async () => { assert.fail("should not call network"); }, async () => {
    const hooks = await plugin({});
    const prior = { old: { id: "old" } };
    assert.equal(await hooks.provider.models({ models: prior }, {}), prior);
  });
});

test("discovery failure is explicit and cannot leak a key or response body", async () => {
  for (const send of [
    async () => new Response(key, { status: 401 }),
    async () => { throw new Error("network error " + key); },
    async () => new Response("invalid-json"),
    async () => Response.json({ data: "unexpected", has_more: false }),
    async () => Response.json({ data: [model], has_more: true, last_id: model.id }),
  ]) {
    await assert.rejects(discoverModels(key, {}, send), error =>
      /model|Anthropic/i.test(error.message) && !error.message.includes(key));
  }
});

test("empty model catalog and models without capability metadata are supported", async () => {
  assert.deepEqual(await discoverModels(key, {}, async () => Response.json({ data: [], has_more: false })), {});
  const found = await discoverModels(key, { [model.id]: { reasoning: true, limit: { context: 123, output: 45 } } }, async () => Response.json({ data: [{ id: model.id, display_name: "Old API" }], has_more: false }));
  assert.equal(found[model.id].reasoning, true);
  assert.deepEqual(found[model.id].limit, { context: 123, output: 45 });
});

test("model hook returns OpenCode runtime models rather than config-only fields", async () => {
  const found = await discoverModels(key, {}, async () => Response.json({ data: [model], has_more: false }));
  const entry = found[model.id];
  assert.deepEqual(entry.api, { id: model.id, npm: "@ai-sdk/anthropic", url: "https://api.anthropic.com/v1" });
  assert.equal(entry.providerID, "anthropic-uncloak");
  assert.equal(entry.capabilities.reasoning, true);
  assert.equal(entry.capabilities.input.image, true);
  assert.equal(entry.capabilities.output.text, true);
  assert.equal(entry.capabilities.toolcall, true);
  assert.equal(entry.limit.input, 200000);
});

test("model discovery honors the host's cancellation signal before sending", async () => {
  const ctl = new AbortController();
  ctl.abort();
  let calls = 0;
  await assert.rejects(discoverModels(key, {}, async () => {
    calls++;
    return Response.json({ data: [], has_more: false });
  }, ctl.signal));
  assert.equal(calls, 0);
});

test("model discovery requires an explicit boolean pagination flag", async () => {
  for (const has_more of [undefined, null, 0, "false"]) {
    await assert.rejects(discoverModels(key, {}, async () => Response.json({ data: [], has_more })), /catalog|model/i);
  }
});

test("network errors cannot impersonate locally safe model-discovery errors", async () => {
  await assert.rejects(discoverModels(key, {}, async () => {
    throw new Error("Anthropic model discovery network error " + key);
  }), error => !error.message.includes(key));
});
