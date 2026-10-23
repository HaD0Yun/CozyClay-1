// The Anthropic subscription lane (#claude-subscription): Claude Pro/Max OAuth sign-in, with the
// actual API calls made by the official Claude Code binary through the Claude Agent SDK.
//
// Why the indirection: Anthropic ties a subscription OAuth token to Claude Code. A third-party
// client calling api.anthropic.com with it gets refused and risks the account; a request the
// official binary sends is the sanctioned path. So this provider's `api.stream` never touches the
// Anthropic API itself — the stream implementation lives in anthropic-subscription-stream.mjs.
//
// Auth itself is pi's machinery: the provider reuses pi-ai's bundled Anthropic OAuth flow
// (login / refresh / toAuth), so login, the five-minute refresh window and auth.json storage work
// exactly like any other pi provider. `toAuth` yields `{ apiKey: <access token> }`, which pi's
// ModelsImpl passes to `stream` as `options.apiKey` — that is the token the stream injects.

import { createSubscriptionStream } from "./anthropic-subscription-stream.mjs";

export const SUBSCRIPTION_PROVIDER_ID = "anthropic-subscription";
// named like the ChatGPT lane ("ChatGPT (OpenAI Codex)"): the subscription product first
export const SUBSCRIPTION_PROVIDER_NAME = "Claude (Anthropic)";

/**
 * The provider. Claude's catalogue is pi-ai's own anthropic list with the provider id rebound, so
 * costs, context windows and thinking levels stay in sync with the API-key lane; auth is pi-ai's
 * bundled Anthropic OAuth flow untouched.
 */
export async function anthropicSubscriptionProvider() {
	const [{ anthropicProvider }, { createProvider }] = await Promise.all([
		import("@earendil-works/pi-ai/providers/anthropic"),
		import("@earendil-works/pi-ai"),
	]);
	const base = anthropicProvider();
	const streamImpl = createSubscriptionStream();
	const models = base.getModels().map((model) => ({
		...model,
		provider: SUBSCRIPTION_PROVIDER_ID,
		compat: model.compat
			? {
				...model.compat,
				allowedFallbackModels: model.compat.allowedFallbackModels?.map((fallback) => ({ ...fallback, provider: SUBSCRIPTION_PROVIDER_ID })),
			}
		: model.compat,
	}));
	return createProvider({
		id: SUBSCRIPTION_PROVIDER_ID,
		name: SUBSCRIPTION_PROVIDER_NAME,
		auth: {
			oauth: {
				name: SUBSCRIPTION_PROVIDER_NAME,
				// same convention as the ChatGPT lane's "Sign in with ChatGPT (Plus/Pro)"
				loginLabel: "Sign in with Claude (Pro/Max)",
				isSubscription: true,
				login: (interaction) => base.auth.oauth.login(interaction),
				refresh: (credential, signal) => base.auth.oauth.refresh(credential, signal),
				toAuth: (credential) => base.auth.oauth.toAuth(credential),
			},
		},
		models,
		api: { stream: streamImpl, streamSimple: streamImpl },
	});
}
