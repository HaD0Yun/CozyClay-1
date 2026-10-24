// A custom OpenAI-compatible endpoint (#885): LM Studio, Ollama, vLLM, llama.cpp's server or any server that
// answers GET /v1/models and POST /v1/chat/completions, connected without CLIProxyAPI. Like CLIProxyAPI's lane,
// its login is pi's api-key login: it asks for the server address and an optional key, checks that
// <address>/v1/models answers, and returns one api-key credential carrying the address as provider env, which the
// credential store keeps in auth.json. The models are the server's own /v1/models list (pi's fetchModels, run by
// refreshOpenAICompatible), and turns stream through pi-ai's openai-completions API.
import { cleanBase, fetchModelList } from "./cliproxy-provider.mjs";

export const OPENAI_COMPATIBLE_ID = "openai-compatible";
const BASE_ENV = "OPENAI_COMPATIBLE_BASE_URL";
const DEFAULT_BASE = "http://127.0.0.1:11434";
// openai-completions needs some key; a keyless local server ignores the Authorization header it carries.
const NO_KEY = "no-key";

const v1 = (base) => `${base}/v1`;

/** One chat model the server listed. The server does not say which of its models read images, so every model is
 * offered with image input (the panel only lists those); a text-only model refuses an image turn with its own error. */
function endpointModel(id, base) {
	return {
		id,
		name: id,
		type: "chat",
		api: "openai-completions",
		provider: OPENAI_COMPATIBLE_ID,
		baseUrl: v1(base),
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 8192,
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: "max_tokens" },
	};
}

/** The server's model ids, or an error that says what went wrong in words the login and the picker can show. */
async function listEndpoint(base, key, signal) {
	let data;
	try {
		data = await fetchModelList(v1(base), key, "The OpenAI-compatible server", signal);
	} catch (error) {
		if (error?.status === 401 || error?.status === 403) throw new Error(`The server at ${base} refused ${key ? "the key" : "a request without a key"} (${error.status}).`, { cause: error });
		if (error?.status) throw new Error(`The server at ${base} answered GET /v1/models with ${error.status}.`, { cause: error });
		throw new Error(`Could not reach ${v1(base)}/models (${error?.cause?.code || error?.name || error?.message || error}).`, { cause: error });
	}
	return data.map((entry) => (typeof entry === "string" ? entry : entry?.id)).filter((id) => typeof id === "string" && id);
}

/** pi ApiKeyAuth: the address, then an optional key; the login only succeeds once the server lists its models. */
function endpointAuth() {
	return {
		name: "Server address and optional key",
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const address = await interaction.prompt({ type: "text", message: "Server address (LM Studio, Ollama, or another OpenAI-compatible server)", placeholder: v1(DEFAULT_BASE) });
			const base = cleanBase(address.trim() || DEFAULT_BASE);
			interaction.signal.throwIfAborted();
			const key = String(await interaction.prompt({ type: "secret", optional: true, message: "API key (leave empty when the server needs none)" })).trim();
			interaction.signal.throwIfAborted();
			const ids = await listEndpoint(base, key, interaction.signal);
			interaction.notify?.({ type: "info", message: `${base} lists ${ids.length} model${ids.length === 1 ? "" : "s"}.` });
			return { type: "api_key", key, env: { [BASE_ENV]: base } };
		},
		resolve: async ({ credential, signal }) => {
			signal.throwIfAborted();
			if (!credential?.env?.[BASE_ENV]) return undefined;
			return { auth: { apiKey: credential.key || NO_KEY }, env: credential.env, source: "stored credential" };
		},
	};
}

export async function openaiCompatibleProvider() {
	const [{ createProvider }, completionsApi] = await Promise.all([
		import("@earendil-works/pi-ai"),
		import("@earendil-works/pi-ai/api/openai-completions"),
	]);
	return createProvider({
		id: OPENAI_COMPATIBLE_ID,
		name: "OpenAI-compatible server (LM Studio, Ollama)",
		auth: { apiKey: endpointAuth() },
		models: [],
		api: { "openai-completions": completionsApi },
		fetchModels: async ({ credential, signal }) => {
			const base = credential?.env?.[BASE_ENV];
			return base ? (await listEndpoint(base, credential.key, signal)).map((id) => endpointModel(id, base)) : [];
		},
	});
}

/** Re-reads the server's /v1/models into the registry; the reason it failed, or null. */
export async function refreshOpenAICompatible(models) {
	if (typeof models?.refresh !== "function") return null;
	const { errors } = await models.refresh({ providers: [OPENAI_COMPATIBLE_ID] });
	return errors.get(OPENAI_COMPATIBLE_ID)?.message ?? null;
}
