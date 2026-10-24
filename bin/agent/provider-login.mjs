// pi's provider login (the coding agent's /login) over HTTP for the agent panel (#pi-login). The sidecar
// runs `models.login(providerId, type, interaction)` itself; the interaction is a queue the panel reads:
//   { type: "prompt", promptId, prompt: { type: text|secret|select|manual_code, message, placeholder?, options? } }
//   { type: "event", event: pi AuthEvent (info, auth_url, device_code, progress) }
//   { type: "prompt_closed", promptId }      pi withdrew a prompt (e.g. a callback beat the pasted code)
//   { type: "done", ok, message? }
// and answers with the prompt's value. Nothing the user types is ever put in the queue. pi persists the
// credential through the registry's CredentialStore (credential-store.mjs); onSignedIn rebuilds the registry.
import { randomUUID } from "node:crypto";

const WAIT_MS = 25_000;
const KEEP_MS = 60_000;

/** The login methods pi offers for each provider, as the panel lists them (subscriptions first). */
export async function loginOptions(models, { chatgpt } = {}) {
	const options = [];
	for (const provider of models.getProviders()) {
		const auth = provider.auth ?? {};
		// ChatGPT keeps CozyClay's own sign-in: its id_token carries the plan and account the image routes read.
		const methods = provider.id === "openai-codex"
			? [{ type: "chatgpt", label: "Sign in with ChatGPT (Plus/Pro)", subscription: true }]
			: [
				...(auth.oauth?.login ? [{ type: "oauth", label: auth.oauth.loginLabel || auth.oauth.name, subscription: !!auth.oauth.isSubscription }] : []),
				...(auth.apiKey?.login ? [{ type: "api_key", label: auth.apiKey.name }] : []),
			];
		if (!methods.length) continue;
		const check = provider.id === "openai-codex"
			? (chatgpt?.() ? { type: "oauth", source: "ChatGPT" } : undefined)
			: await models.checkAuth(provider.id).catch(() => undefined);
		// pi 0.99 renamed its Codex lane "OpenAI Codex (legacy)"; here it is CozyClay's ChatGPT sign-in, so it keeps its name
		const name = provider.id === "openai-codex" ? "OpenAI Codex" : provider.name ?? provider.id;
		options.push({ id: provider.id, name, methods, connected: !!check, via: check?.type ?? null, source: check?.source ?? null });
	}
	const rank = (entry) => (entry.connected ? 0 : entry.methods.some((method) => method.subscription) ? 1 : 2);
	return options.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function createLoginFlows({ getModels, onSignedIn }) {
	const flows = new Map();
	const wake = (flow) => { for (const waiter of [...flow.waiters]) waiter(); };
	const push = (flow, entry) => { flow.events.push(entry); wake(flow); };
	const finish = (flow, entry) => {
		flow.done = true;
		for (const pending of flow.pending.values()) pending.reject(new Error("The login ended."));
		flow.pending.clear();
		push(flow, entry);
		setTimeout(() => flows.delete(flow.id), KEEP_MS).unref?.();
	};

	function start(providerId, type) {
		const flow = { id: randomUUID(), providerId, type, events: [], waiters: new Set(), pending: new Map(), controller: new AbortController(), done: false };
		const interaction = {
			signal: flow.controller.signal,
			prompt(prompt) {
				return new Promise((resolve, reject) => {
					const promptId = randomUUID();
					flow.pending.set(promptId, { resolve, reject });
					const { signal, ...shown } = prompt;
					push(flow, { type: "prompt", promptId, prompt: shown });
					signal?.addEventListener("abort", () => {
						if (!flow.pending.delete(promptId)) return;
						push(flow, { type: "prompt_closed", promptId });
						reject(signal.reason ?? new Error("The prompt was withdrawn."));
					}, { once: true });
				});
			},
			notify(event) { push(flow, { type: "event", event }); },
		};
		flows.set(flow.id, flow);
		void (async () => {
			try {
				await (await getModels()).login(providerId, type, interaction);
				await onSignedIn?.(providerId);
				finish(flow, { type: "done", ok: true });
			} catch (error) {
				finish(flow, { type: "done", ok: false, message: flow.controller.signal.aborted ? "The login was cancelled." : String(error?.message || error || "The login failed.") });
			}
		})();
		return flow.id;
	}

	/** Entries after `after`, waiting up to WAIT_MS for the first new one; null for an unknown flow. */
	async function read(id, after = 0) {
		const flow = flows.get(id);
		if (!flow) return null;
		if (flow.events.length <= after && !flow.done) {
			await new Promise((resolve) => {
				const done = () => { clearTimeout(timer); flow.waiters.delete(done); resolve(); };
				const timer = setTimeout(done, WAIT_MS);
				flow.waiters.add(done);
			});
		}
		return { events: flow.events.slice(after), next: flow.events.length, done: flow.done };
	}

	function answer(id, promptId, value) {
		const pending = flows.get(id)?.pending.get(promptId);
		if (!pending) return false;
		flows.get(id).pending.delete(promptId);
		pending.resolve(String(value ?? ""));
		return true;
	}

	function cancel(id) {
		const flow = flows.get(id);
		if (!flow || flow.done) return false;
		flow.controller.abort();
		return true;
	}

	return { start, read, answer, cancel };
}
