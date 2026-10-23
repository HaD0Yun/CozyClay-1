// The subscription lane's stream body: spawns the official Claude Code binary through the Claude
// Agent SDK's `query()`, hands the OAuth access token over as CLAUDE_CODE_OAUTH_TOKEN, replays
// pi's message history into a single prompt (anthropic-subscription-prompt.mjs), and translates
// the SDK's stream events back into pi assistant-message events (anthropic-subscription-events.mjs).
// Tools stay host-side: built-in tools off, host tools on an SDK MCP server that always denies, so
// every tool call returns to CozyClay's harness and the result comes back in the next prompt.

import { resolveClaudeCodeExecutable } from "./claude-code-executable.mjs";
import { buildPromptBlocks, buildPromptStream } from "./anthropic-subscription-prompt.mjs";
import { applyStreamEvent, emptyOutput, mapStopReason, updateUsage } from "./anthropic-subscription-events.mjs";
const TOOL_EXECUTION_DENIED_MESSAGE = "Not an error: this is the normal host handoff, so ignore the 'hook error' label. " +
	"CozyClay runs this tool on the host and returns its result as the next user message. " +
	"Wait for that result, and do not mention this message to the user.";

// Environment the SDK subprocess must not inherit: a stored Anthropic key or gateway would make
// Claude Code spend it instead of the subscription token we inject.
function childEnvironment(parent, accessToken) {
	const {
		ANTHROPIC_API_KEY: _apiKey, ANTHROPIC_AUTH_TOKEN: _authToken, ANTHROPIC_BASE_URL: _baseUrl,
		ANTHROPIC_CUSTOM_HEADERS: _customHeaders, CLAUDE_CODE_OAUTH_TOKEN: _oauthToken,
		CLAUDE_CODE_USE_BEDROCK: _bedrock, CLAUDE_CODE_USE_FOUNDRY: _foundry,
		CLAUDE_CODE_USE_GATEWAY: _gateway, CLAUDE_CODE_USE_VERTEX: _vertex,
		...environment
	} = parent;
	for (const name of Object.keys(environment)) {
		if (/^CLAUDE_CODE_OAUTH_TOKEN_\d+$/.test(name)) delete environment[name];
	}
	return {
		...environment,
		CLAUDE_CODE_OAUTH_TOKEN: accessToken,
		// Claude Code's per-turn budget reminder rewrites the prompt every turn; CozyClay's harness
		// owns context budgeting. Native auto-compact stays off: pi owns the transcript.
		CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
		DISABLE_COMPACT: "1",
	};
}

// pi thinking level → SDK effort. Adaptive-thinking models take { type: "adaptive" } plus an
// effort grade; the rest take a raw token budget.
const DEFAULT_THINKING_BUDGETS = { minimal: 2048, low: 8192, medium: 16384, high: 31999, max: 63999 };
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
function applyThinking(queryOptions, model, reasoning) {
	if (!reasoning || reasoning === "off") return;
	const adaptive = model.compat?.forceAdaptiveThinking === true;
	if (adaptive) {
		const mapped = model.thinkingLevelMap?.[reasoning];
		const effort = EFFORT_LEVELS.has(mapped) ? mapped
			: reasoning === "minimal" || reasoning === "low" ? "low"
			: reasoning === "medium" ? "medium"
			: reasoning === "high" ? "high"
			: "max";
		queryOptions.thinking = { type: "adaptive", display: "summarized" };
		queryOptions.effort = effort;
		return;
	}
	const level = reasoning === "xhigh" ? "high" : reasoning;
	const budget = DEFAULT_THINKING_BUDGETS[level];
	if (budget) queryOptions.maxThinkingTokens = budget;
}

/** JSON Schema (pi's TypeBox parameters) → the Zod raw shape the SDK's `tool()` wants. */
async function jsonSchemaToZodShape(schema) {
	const { z } = await import("zod");
	const convert = (node) => {
		const s = node ?? {};
		let converted;
		if (s.const !== undefined) converted = s.const === null ? z.null() : z.literal(s.const);
		else if (Array.isArray(s.enum) && s.enum.length === 1) converted = z.literal(s.enum[0]);
		else if (Array.isArray(s.enum) && s.enum.length > 1) {
			const [first, second, ...rest] = s.enum.map((value) => z.literal(value));
			converted = z.union([first, second, ...rest]);
		}
		if (converted === undefined) {
			const variants = s.anyOf ?? s.oneOf;
			if (Array.isArray(variants) && variants.length > 0) {
				const [first, second, ...rest] = variants.map(convert);
				converted = variants.length === 1 ? first : z.union([first, second, ...rest]);
			} else {
				const type = Array.isArray(s.type) ? s.type[0] : s.type;
				if (type === "string") converted = z.string();
				else if (type === "number") converted = z.number();
				else if (type === "integer") converted = z.number().int();
				else if (type === "boolean") converted = z.boolean();
				else if (type === "null") converted = z.null();
				else if (type === "array") converted = z.array(s.items ? convert(s.items) : z.unknown());
				else if (type === "object") converted = z.object(shape(s));
				else converted = z.unknown();
			}
		}
		return typeof s.description === "string" ? converted.describe(s.description) : converted;
	};
	const shape = (objectSchema) => {
		const properties = objectSchema?.properties ?? {};
		const required = new Set(objectSchema?.required ?? []);
		const result = {};
		for (const [key, value] of Object.entries(properties)) {
			const converted = convert(value);
			result[key] = required.has(key) ? converted : converted.optional();
		}
		return result;
	};
	return shape(schema ?? {});
}

/** CozyClay's pi tools → an SDK MCP server. The handler never runs: it is the deny backstop. */
async function buildCustomToolServers(sdk, piTools) {
	if (!piTools?.length) return undefined;
	const tools = [];
	for (const piTool of piTools) {
		const schema = await jsonSchemaToZodShape(piTool.parameters);
		tools.push(sdk.tool(
			piTool.name,
			typeof piTool.description === "string" ? piTool.description : "",
			schema,
			async () => ({ content: [{ type: "text", text: TOOL_EXECUTION_DENIED_MESSAGE }], isError: true }),
		));
	}
	return { "cozyclay-tools": sdk.createSdkMcpServer({ name: "cozyclay-tools", version: "1.0.0", tools }) };
}

/** The provider's api. pi's harness calls `streamSimple`; options.apiKey is the OAuth access
 * token pi resolved (and refreshed) for this request, options.signal aborts, options.reasoning
 * is the pi thinking level. */
export function createSubscriptionStream({ loadSdk, resolveExecutable = resolveClaudeCodeExecutable, env = process.env, cwd = process.cwd() } = {}) {
	const sdkPromise = () => (loadSdk ?? (() => import("@anthropic-ai/claude-agent-sdk")))();
	return function streamAnthropicSubscription(model, context, options = {}) {
		return (async () => {
			// pi hands providers a TranscriptContext: the prompt and the tools live in its system messages.
			const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, parseStreamingJson } = await import("@earendil-works/pi-ai");
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const output = emptyOutput(model);
				const blocks = [];
				let sdkQuery;
				let closed = false;
				let wasAborted = false;
				let started = false;
				let sawStreamEvent = false;
				const closeQuery = () => {
					if (closed || !sdkQuery) return;
					closed = true;
					sdkQuery.close();
				};
				const onAbort = () => {
					wasAborted = true;
					if (!sdkQuery) return;
					void sdkQuery.interrupt().catch(() => {}).finally(closeQuery);
				};
				if (options.signal?.aborted) onAbort();
				else options.signal?.addEventListener("abort", onAbort, { once: true });
				try {
					const accessToken = options.apiKey;
					if (typeof accessToken !== "string" || !accessToken) {
						throw new Error("No Anthropic subscription credential resolved; sign in with Claude from the agent panel first.");
					}
					const sdk = await sdkPromise();
					const executable = resolveExecutable({ env });
					const piTools = getCurrentTools(context.messages);
					const mcpServers = await buildCustomToolServers(sdk, piTools);
					const queryOptions = {
						cwd,
						model: model.id,
						// No Claude Code built-in tools; host tools come from the MCP server and every
						// execution is denied, so the tool call always returns to CozyClay's harness.
						tools: [],
						permissionMode: "dontAsk",
						includePartialMessages: true,
						canUseTool: async () => ({ behavior: "deny", message: TOOL_EXECUTION_DENIED_MESSAGE }),
						hooks: {
							PreToolUse: [{
								matcher: ".*",
								hooks: [async () => ({
									continue: false,
									hookSpecificOutput: {
										hookEventName: "PreToolUse",
										permissionDecision: "deny",
										permissionDecisionReason: TOOL_EXECUTION_DENIED_MESSAGE,
									},
								})],
							}],
						},
						systemPrompt: {
							type: "preset",
							preset: "claude_code",
							append: getCurrentSystemPrompt(context.messages).trim() || undefined,
						},
						env: childEnvironment(env, accessToken),
						pathToClaudeCodeExecutable: executable,
						settingSources: [],
						extraArgs: { "strict-mcp-config": null },
					};
					if (mcpServers) queryOptions.mcpServers = mcpServers;
					applyThinking(queryOptions, model, options.reasoning);
					const promptBlocks = buildPromptBlocks(context);
					sdkQuery = sdk.query({ prompt: buildPromptStream(promptBlocks), options: queryOptions });
					if (wasAborted) onAbort();
					for await (const message of sdkQuery) {
						if (!started) {
							stream.push({ type: "start", partial: output });
							started = true;
						}
						if (message.type === "stream_event") {
							sawStreamEvent = true;
							applyStreamEvent({ model, output, blocks, stream }, message.event, parseStreamingJson);
						} else if (message.type === "assistant") {
							output.responseId ??= message.message?.id || undefined;
							// SDK assistant snapshots carry placeholder output counts; only a query that
							// streamed nothing may adopt them.
							if (!sawStreamEvent) updateUsage(model, output, message.message?.usage, { reset: true });
						} else if (message.type === "result") {
							if (message.subtype !== "success") {
								throw new Error(`Claude Code turn failed (${message.subtype ?? "unknown"})${message.error ? `: ${message.error}` : ""}`);
							}
							if (message.usage) updateUsage(model, output, message.usage);
							if (message.stop_reason != null && output.stopReason !== "toolUse") {
								output.stopReason = mapStopReason(message.stop_reason);
							}
							if (!sawStreamEvent && typeof message.result === "string" && message.result) {
								output.content.push({ type: "text", text: message.result });
							}
						}
					}
					for (const block of output.content) {
						delete block.index;
						delete block.partialJson;
					}
					if (wasAborted || options.signal?.aborted) {
						output.stopReason = "aborted";
						output.errorMessage = "Operation aborted";
						stream.push({ type: "error", reason: "aborted", error: output });
					} else {
						stream.push({ type: "done", reason: output.stopReason, message: output });
					}
				} catch (error) {
					for (const block of output.content) {
						delete block.index;
						delete block.partialJson;
					}
					output.stopReason = wasAborted || options.signal?.aborted ? "aborted" : "error";
					output.errorMessage = error instanceof Error ? error.message : String(error);
					stream.push({ type: "error", reason: output.stopReason, error: output });
				} finally {
					closeQuery();
					stream.end();
				}
			})();
			return stream;
		})();
	};
}

