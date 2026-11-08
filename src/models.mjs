import { BASE_URL, createUncloakFetch } from "./uncloak.mjs";

class CatalogError extends Error {}

function mapModel(model, prior) {
  const entry = {
    ...prior,
    id: model.id,
    name: model.display_name || prior?.name || model.id,
    providerID: "anthropic-uncloak",
    api: { id: model.id, npm: "@ai-sdk/anthropic", url: BASE_URL },
    tool_call: true,
  };
  const capabilities = model.capabilities;
  if (capabilities?.thinking) entry.reasoning = capabilities.thinking.supported === true;
  if (capabilities?.image_input) {
    entry.modalities = {
      input: capabilities.image_input.supported ? ["text", "image"] : ["text"],
      output: ["text"],
    };
  }
  const limit = { ...prior?.limit };
  if (Number.isFinite(model.max_input_tokens) && model.max_input_tokens > 0) {
    limit.context = model.max_input_tokens;
    limit.input = model.max_input_tokens;
  }
  if (Number.isFinite(model.max_tokens) && model.max_tokens > 0) limit.output = model.max_tokens;
  if (Object.keys(limit).length) entry.limit = limit;
  entry.capabilities = {
    ...prior?.capabilities,
    toolcall: true,
    input: { text: true, ...prior?.capabilities?.input },
    output: { text: true, ...prior?.capabilities?.output },
  };
  if (typeof entry.reasoning === "boolean") entry.capabilities.reasoning = entry.reasoning;
  if (capabilities?.image_input) entry.capabilities.input.image = capabilities.image_input.supported === true;
  if (capabilities?.effort) {
    entry.variants = Object.fromEntries(Object.entries(capabilities.effort)
      .filter(([name, value]) => name !== "supported" && value?.supported === true)
      .map(([name]) => [name, {}]));
  }
  return entry;
}

/** Read this account's model list; never use subscription OAuth or invent a balance. */
export async function discoverModels(apiKey, prior = {}, send = globalThis.fetch, callerSignal) {
  const request = createUncloakFetch(apiKey, send);
  const timeout = AbortSignal.timeout(10_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const models = new Map();
  const cursors = new Set();
  let after;
  try {
    for (let page = 0; page < 20; page++) {
      const url = new URL(BASE_URL + "/models");
      url.searchParams.set("limit", "1000");
      if (after) url.searchParams.set("after_id", after);
      const response = await request(url, {
        signal, headers: { "anthropic-version": "2026-10-21" },
      });
      if (!response.ok) throw new CatalogError("Anthropic model discovery failed (HTTP " + response.status + ").");
      const result = await response.json();
      if (!Array.isArray(result?.data) || typeof result.has_more !== "boolean") throw new CatalogError("Anthropic model discovery returned an invalid catalog.");
      for (const model of result.data) {
        if (model?.lifecycle === "retired") continue;
        if (typeof model?.id !== "string" || !model.id) throw new CatalogError("Anthropic model discovery returned an invalid model.");
        models.set(model.id, mapModel(model, prior[model.id]));
      }
      if (!result.has_more) return Object.fromEntries(models);
      if (typeof result.last_id !== "string" || !result.last_id || cursors.has(result.last_id)) {
        throw new CatalogError("Anthropic model discovery returned an invalid pagination cursor.");
      }
      after = result.last_id;
      cursors.add(after);
    }
    throw new CatalogError("Anthropic model discovery exceeded its pagination limit.");
  } catch (error) {
    // Deliberately exclude upstream body text and exception details, which may carry credentials.
    if (error instanceof CatalogError) throw error;
    throw new Error("Anthropic model discovery failed. Check the API key, organization, workspace and Magpie network proxy.");
  }
}
