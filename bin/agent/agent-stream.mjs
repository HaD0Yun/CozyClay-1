// The provider call behind every model request of the agent runner (agent-runner.mjs). pi-agent-core 1.x's Agent does
// not retry a failed request (the removed AgentHarness did), so one request is retried here, in place:
//   - a transient failure, by pi-ai's own isRetryableAssistantError (429, 5xx, overload, dropped connections), up to
//     RETRY_POLICY.maxRetries times with pi-ai's backoff;
//   - an expired Codex sign-in (401), once per turn, after a forced credential refresh (refreshAuth, the runner's).
// An attempt is retried only while nothing of it reached the Agent: its events are held until its first content event,
// so the transcript and the panel only ever see the attempt that answered. A retried request carries the same context,
// so no failed assistant message is stored and no completed tool runs again.

const RETRY_POLICY = Object.freeze({ maxRetries: 2, baseDelayMs: 1000 });

const CONTENT_EVENT = /^(text|thinking|toolcall)_/;
const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) { resolve(); return; }
		const timer = setTimeout(done, ms);
		function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
		signal?.addEventListener("abort", done, { once: true });
	});
}

/** An assistant message for a request that never produced one (pi-ai throws when a request has no credential). */
function failedMessage(model, error, signal) {
	return {
		role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: EMPTY_USAGE,
		stopReason: signal?.aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/**
 * The Agent's streamFn. `ai` is @earendil-works/pi-ai, `models` the registry the request runs on. `refreshAuth(model,
 * message)` decides whether a failed attempt earns a credential refresh and one more try (it refreshes before answering
 * true); `onAttempt(message)` sees every attempt's final message, failed ones included.
 */
export function createRetryingStream({ ai, models, refreshAuth = async () => false, onAttempt = () => {} }) {
	return (model, context, options = {}) => {
		const { signal } = options;
		const out = ai.createAssistantMessageEventStream();
		const shouldRetry = async (message, retries) => {
			if (retries >= RETRY_POLICY.maxRetries || signal?.aborted) return false;
			if (ai.isRetryableAssistantError(message)) {
				await pause(ai.retryDelayMs(RETRY_POLICY, retries + 1), signal);
				return !signal?.aborted;
			}
			return refreshAuth(model, message);
		};
		const finish = (message, held = []) => {
			for (const early of held) out.push(early);
			const failed = message.stopReason === "error" || message.stopReason === "aborted";
			out.push(failed ? { type: "error", reason: message.stopReason, error: message } : { type: "done", reason: message.stopReason, message });
			out.end();
		};
		void (async () => {
			for (let retries = 0; ; retries += 1) {
				// The Agent asks for the next request even after a cancelled tool: an aborted run makes no further model call.
				if (signal?.aborted) { finish(failedMessage(model, new Error("Request was aborted"), signal)); return; }
				const held = [];
				let forwarding = false;
				let message;
				try {
					const response = await models.streamSimple(model, context, options);
					for await (const event of response) {
						if (event.type === "done" || event.type === "error") break;
						if (forwarding) { out.push(event); continue; }
						held.push(event);
						if (CONTENT_EVENT.test(event.type)) { forwarding = true; for (const early of held.splice(0)) out.push(early); }
					}
					message = await response.result();
				} catch (error) {
					message = failedMessage(model, error, signal);
				}
				onAttempt(message);
				if (!forwarding && message.stopReason === "error" && await shouldRetry(message, retries)) continue;
				// An abort that landed during a backoff ends the request as aborted, like any other cancellation.
				finish(message.stopReason === "error" && signal?.aborted ? { ...message, stopReason: "aborted" } : message, held);
				return;
			}
		})();
		return out;
	};
}
