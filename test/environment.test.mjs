import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isolatedEnvironment } from "./helpers/environment.mjs";

test("integration child receives no inherited credentials or profile overrides", () => {
  const parent = {
    SystemRoot: "C:\\Windows", PATH: "C:\\real-agent-bin",
    HOME: "/real/home", USERPROFILE: "C:\\real-user",
    CLAUDE_CONFIG_DIR: "C:\\real-claude", CODEX_HOME: "C:\\real-codex",
    CLAUDE_CODE_OAUTH_TOKEN: "fake-parent-token", ANTHROPIC_API_KEY: "fake-parent-key",
    MAGPIE_GATEWAY_KEY: "fake-parent-gateway", NODE_OPTIONS: "--require fake-injection.js",
  };
  const state = path.resolve("isolated-test-state");
  const env = isolatedEnvironment(parent, state, 40001, "http://127.0.0.1:40002");
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "MAGPIE_GATEWAY_KEY", "NODE_OPTIONS"]) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(env.SystemRoot, parent.SystemRoot);
  assert.equal(env.HOME, path.join(state, "profile"));
  assert.equal(env.USERPROFILE, path.join(state, "profile"));
  assert.equal(env.PATH, path.join(state, "bin"));
  assert.equal(env.MAGPIE_ADDR, "127.0.0.1:40001");
  assert.equal(parent.ANTHROPIC_API_KEY, "fake-parent-key", "parent environment stays unchanged");
});
