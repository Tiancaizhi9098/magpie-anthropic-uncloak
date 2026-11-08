import { BASE_URL, createUncloakFetch } from "./src/uncloak.mjs";
import { discoverModels } from "./src/models.mjs";

const PROVIDER = "anthropic-uncloak";

/** OpenCode v1-shaped provider, loaded natively by Magpie's Bun host. */
export default async function AnthropicUncloakPlugin() {
  return {
    config: async cfg => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "Anthropic Uncloak",
        npm: "@ai-sdk/anthropic",
        api: BASE_URL,
        searches: true,
        models: {},
      };
    },
    auth: {
      provider: PROVIDER,
      methods: [{
        type: "api",
        label: "Anthropic API Key（领取赠金的组织）",
        placeholder: "sk-ant-api03-…",
      }],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        if (auth.type !== "api") throw new TypeError("Anthropic Uncloak requires an API key sign-in.");
        return {
          baseURL: BASE_URL,
          apiKey: auth.key,
          fetch: createUncloakFetch(auth.key, globalThis.fetch),
        };
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth, signal } = {}) {
        if (auth?.type !== "api") return provider.models ?? {};
        return discoverModels(auth.key, provider.models ?? {}, globalThis.fetch, signal);
      },
    },
  };
}
