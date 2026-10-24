// CLIProxyAPI, the one provider CozyClay adds to pi's built-ins (moved out of providers.mjs for #pi-login).
// Its login is pi's own api-key login shape: the flow asks for the server address and then the key, and
// returns one api-key credential that carries the address as provider env (CLIPROXY_BASE_URL), so an app
// opened from the Dock needs no shell variable. The address is read when the registry is built: the
// environment wins, then the stored credential's env, then the default local port.

const CLIPROXY_DEFAULT_BASE = "http://127.0.0.1:8317";
const BASE_ENV = "CLIPROXY_BASE_URL";
const KEY_ENV = "CLIPROXY_API_KEY";

/** A server address as typed, cleaned: http(s), no trailing slash, no trailing /v1 (the models add it). */
function cleanBase(value) {
	const url = new URL(String(value ?? "").trim());
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("The server address must start with http:// or https://.");
	return url.href.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The address the registry builds CLIProxyAPI's models on: environment, then the stored credential, then the default. */
export function cliproxyBase({ env = process.env, credential } = {}) {
	const fromEnv = typeof env?.[BASE_ENV] === "string" ? env[BASE_ENV].trim() : "";
	return (fromEnv || credential?.env?.[BASE_ENV] || CLIPROXY_DEFAULT_BASE).replace(/\/$/, "");
}

/** pi ApiKeyAuth: login asks for the address, then the key; resolve prefers the stored key, then CLIPROXY_API_KEY. */
function cliproxyAuth() {
	return {
		name: "CLIProxyAPI server and key",
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const address = await interaction.prompt({ type: "text", message: "CLIProxyAPI server address", placeholder: CLIPROXY_DEFAULT_BASE });
			const base = cleanBase(address.trim() || CLIPROXY_DEFAULT_BASE);
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: "CLIProxyAPI key" });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key, env: { [BASE_ENV]: base } };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			if (credential?.key) return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			const key = await ctx.env(KEY_ENV);
			return key ? { auth: { apiKey: key }, source: KEY_ENV } : undefined;
		},
	};
}

export async function cliproxyProvider({ baseUrl, env = process.env } = {}) {
	const base = (baseUrl ?? cliproxyBase({ env })).replace(/\/$/, "");
	const [{ createProvider }, { openaiProvider }, { anthropicProvider }, openaiResponsesApi, anthropicMessagesApi] = await Promise.all([
		import("@earendil-works/pi-ai"),
		import("@earendil-works/pi-ai/providers/openai"),
		import("@earendil-works/pi-ai/providers/anthropic"),
		import("@earendil-works/pi-ai/api/openai-responses"),
		import("@earendil-works/pi-ai/api/anthropic-messages"),
	]);
	const ids = new Set();
	const models = [
		...openaiProvider().getModels().map((model) => ({ ...model, provider: "cliproxy", baseUrl: `${base}/v1` })),
		...anthropicProvider().getModels().map((model) => ({
			...model,
			provider: "cliproxy",
			baseUrl: base,
			// CLIProxyAPI's /v1/messages rejects messages[].output_config and thinking.block_binding, so keep
			// adaptive thinking (forceAdaptiveThinking) but drop the mid-conversation output_config shape.
			compat: { ...model.compat, supportsMidConvoEffort: false },
		})),
	].filter((model) => !ids.has(model.id) && ids.add(model.id));
	return createProvider({
		id: "cliproxy",
		name: "CLIProxyAPI",
		baseUrl: base,
		auth: { apiKey: cliproxyAuth() },
		models,
		api: { "openai-responses": openaiResponsesApi, "anthropic-messages": anthropicMessagesApi },
	});
}

/** The proxy's own /v1/models (id -> owner), fetched once per registry; a failed fetch is asked again next time. */
export async function registryLiveCliproxy(models, apiKey, state) {
	if (!state.cliproxyFetch) {
		state.cliproxyFetch = Promise.resolve().then(async () => {
			const provider = models?.getProvider?.("cliproxy");
			const model = provider?.getModels?.().find((entry) => entry.api === "openai-responses");
			if (!model?.baseUrl || !apiKey) throw new Error("CLIProxyAPI is not configured");
			const response = await fetch(`${model.baseUrl}/models`, {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(5000),
			});
			if (!response.ok) throw new Error(`CLIProxyAPI models request failed: ${response.status}`);
			const body = await response.json();
			// id -> owned_by: the owner is how CLIProxyAPI routes a model (openai, anthropic, or an
			// openai-compatibility upstream name), so it picks the wire format for models pi does not know.
			return new Map((Array.isArray(body?.data) ? body.data : [])
				.map((entry) => typeof entry === "string" ? [entry, undefined] : [entry?.id, typeof entry?.owned_by === "string" ? entry.owned_by : undefined])
				.filter(([id]) => id));
		}).catch(() => { state.cliproxyFetch = null; return null; });
	}
	return state.cliproxyFetch;
}

const CLIPROXY_NON_CHAT = /^gpt-image-|-auto-review$/;

/** A live CLIProxyAPI model pi's catalogue does not know yet (#400 follow-up), built on the newest
 * catalogue model of the same family and wire format: `owned_by: openai` rides openai-responses,
 * `owned_by: anthropic` rides anthropic-messages. Other owners (openai-compatibility upstreams such as
 * opencode-go) are left out: they need upstream-specific headers the proxy does not pass through. */
export function cliproxyLiveModel(id, owner, knownModels) {
	if (CLIPROXY_NON_CHAT.test(id)) return null;
	const api = owner === "openai" ? "openai-responses" : owner === "anthropic" ? "anthropic-messages" : null;
	if (!api) return null;
	const candidates = knownModels.filter((model) => model.api === api);
	const family = owner === "anthropic" ? id.match(/^claude-[a-z]+/)?.[0] : id.match(/^gpt-\d+/)?.[0];
	const sameFamily = family ? candidates.filter((model) => model.id.startsWith(family)) : [];
	const template = [...(sameFamily.length ? sameFamily : candidates)].sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
	if (!template) return null;
	// The 5-5 claude generation rejects thinking {type:"disabled"}; a null "off" makes pi-ai send no thinking block (#723).
	const generation = owner === "anthropic" ? id.match(/-(\d+)-(\d+)$/) : null;
	if (generation && Number(generation[1]) >= 5) return { ...template, id, name: id, thinkingLevelMap: { ...template.thinkingLevelMap, off: null } };
	return { ...template, id, name: id };
}

export function extendCliproxyProvider(provider, live, state) {
	if (state.extendedProviders.has(provider)) return false;
	const getModels = provider.getModels.bind(provider);
	const knownModels = getModels();
	const known = new Set(knownModels.map((model) => model.id));
	const additions = [...live]
		.filter(([id]) => !known.has(id))
		.map(([id, owner]) => cliproxyLiveModel(id, owner, knownModels))
		.filter(Boolean)
		.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
	if (!additions.length) return false;
	provider.getModels = () => [...getModels(), ...additions];
	state.extendedProviders.add(provider);
	return true;
}
