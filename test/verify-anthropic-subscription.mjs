// Verifies the anthropic-subscription lane without a real Anthropic account: the SDK boundary is
// faked, so what is checked is the contract — query options (token injection, executable, deny
// hooks, preset system prompt, custom tools), stream-event translation (text, tool call, usage),
// history replay, and graceful failure when no credential resolved.
import assert from "node:assert/strict";
import { createSubscriptionStream } from "../bin/agent/anthropic-subscription-stream.mjs";
import { anthropicSubscriptionProvider, SUBSCRIPTION_PROVIDER_ID } from "../bin/agent/anthropic-subscription.mjs";
import { buildPromptBlocks, RESPOND_TO_USER_INSTRUCTION, CONTINUE_TURN_INSTRUCTION } from "../bin/agent/anthropic-subscription-prompt.mjs";

const model = {
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: SUBSCRIPTION_PROVIDER_ID,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
	compat: { forceAdaptiveThinking: true },
};

function fakeSdk(queryImpl) {
	return {
		query: queryImpl,
		tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
		createSdkMcpServer: (config) => ({ type: "sdk", ...config }),
	};
}

const textTurn = [
	{ type: "stream_event", event: { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } } } },
	{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } } },
	{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
	{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 100, output_tokens: 5 } } },
	{ type: "result", subtype: "success", result: "Hello world", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } },
];

function fakeQuery(messages) {
	return () => ({
		interrupt: async () => {},
		close: () => {},
		[Symbol.asyncIterator]: () => (async function* () { for (const message of messages) yield message; })(),
	});
}

// --- full text turn through the fake SDK ---
{
	let seen;
	const stream = createSubscriptionStream({
		loadSdk: async () => fakeSdk((input) => { seen = input; return fakeQuery(textTurn)(); }),
		resolveExecutable: () => "/fake/claude",
		env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-should-not-leak", CLAUDE_CODE_OAUTH_TOKEN_2: "stale" },
	});
	const events = [];
	const eventStream = await stream(model, {
		systemPrompt: "You are a previs assistant.",
		messages: [{ role: "user", content: "say hi", timestamp: 1 }],
		tools: [],
	}, { apiKey: "access-token-123" });
	for await (const event of eventStream) events.push(event);
	const done = events.at(-1);
	assert.equal(done.type, "done");
	assert.equal(done.message.stopReason, "stop");
	assert.deepEqual(done.message.content, [{ type: "text", text: "Hello world" }]);
	assert.equal(done.message.usage.input, 100);
	assert.equal(done.message.usage.output, 5);
	assert.equal(done.message.usage.cacheRead, 50);
	assert.equal(done.message.usage.cacheWrite, 10);

	// token injection + env hygiene
	assert.equal(seen.options.env.CLAUDE_CODE_OAUTH_TOKEN, "access-token-123");
	assert.equal(seen.options.env.ANTHROPIC_API_KEY, undefined);
	assert.equal(seen.options.env.CLAUDE_CODE_OAUTH_TOKEN_2, undefined);
	assert.equal(seen.options.env.DISABLE_COMPACT, "1");
	// official binary + Claude Code identity
	assert.equal(seen.options.pathToClaudeCodeExecutable, "/fake/claude");
	assert.equal(seen.options.systemPrompt.type, "preset");
	assert.equal(seen.options.systemPrompt.preset, "claude_code");
	assert.ok(seen.options.systemPrompt.append.includes("previs assistant"));
	// no built-in tools, execution denied
	assert.deepEqual(seen.options.tools, []);
	const denial = await seen.options.canUseTool();
	assert.equal(denial.behavior, "deny");
	// adaptive thinking only when asked
	assert.equal(seen.options.thinking, undefined);
}

// --- tool call surfaces as a pi toolCall with the MCP prefix stripped ---
{
	const toolTurn = [
		{ type: "stream_event", event: { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 10, output_tokens: 1 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__cozyclay-tools__add_object", input: {} } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"shape":"box",' } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"size":2}' } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } } },
		{ type: "result", subtype: "success", stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 20 } },
	];
	let seen;
	const stream = createSubscriptionStream({
		loadSdk: async () => fakeSdk((input) => { seen = input; return fakeQuery(toolTurn)(); }),
		resolveExecutable: () => "/fake/claude",
		env: {},
	});
	const piTool = {
		name: "add_object",
		description: "Add a primitive to the scene",
		parameters: { type: "object", properties: { shape: { type: "string" }, size: { type: "number" } }, required: ["shape"] },
	};
	const eventStream = await stream(model, {
		systemPrompt: "s",
		messages: [{ role: "user", content: "add a box", timestamp: 1 }],
		tools: [piTool],
	}, { apiKey: "tok" });
	let done;
	for await (const event of eventStream) if (event.type === "done") done = event;
	assert.equal(done.reason, "toolUse");
	assert.equal(done.message.stopReason, "toolUse");
	const call = done.message.content[0];
	assert.equal(call.type, "toolCall");
	assert.equal(call.id, "toolu_1");
	assert.equal(call.name, "add_object");
	assert.deepEqual(call.arguments, { shape: "box", size: 2 });
	assert.equal(call.partialJson, undefined);
	// the pi tool reached the SDK as an MCP tool
	assert.ok(seen.options.mcpServers["cozyclay-tools"]);
	assert.equal(seen.options.mcpServers["cozyclay-tools"].tools[0].name, "add_object");
}

// --- thinking level maps to adaptive effort on a forceAdaptiveThinking model ---
{
	let seen;
	const stream = createSubscriptionStream({
		loadSdk: async () => fakeSdk((input) => { seen = input; return fakeQuery(textTurn)(); }),
		resolveExecutable: () => "/fake/claude",
		env: {},
	});
	const eventStream = await stream(model, { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] }, { apiKey: "tok", reasoning: "high" });
	await eventStream.result();
	assert.deepEqual(seen.options.thinking, { type: "adaptive", display: "summarized" });
	assert.equal(seen.options.effort, "high");
}

// --- no credential → graceful error, never a throw ---
{
	const stream = createSubscriptionStream({ loadSdk: async () => fakeSdk(fakeQuery(textTurn)), resolveExecutable: () => "/fake/claude", env: {} });
	const result = await (await stream(model, { systemPrompt: "s", messages: [], tools: [] }, {})).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage, /sign in/i);
}

// --- SDK turn failure → error message with the subtype ---
{
	const failTurn = [{ type: "result", subtype: "error_max_turns", usage: { input_tokens: 1, output_tokens: 1 } }];
	const stream = createSubscriptionStream({ loadSdk: async () => fakeSdk(fakeQuery(failTurn)), resolveExecutable: () => "/fake/claude", env: {} });
	const result = await (await stream(model, { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] }, { apiKey: "tok" })).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage, /error_max_turns/);
}

// --- abort while the query runs → aborted, query interrupted ---
{
	let interrupted = false;
	let markStarted;
	const started = new Promise((resolve) => { markStarted = resolve; });
	let endIteration;
	const ended = new Promise((resolve) => { endIteration = resolve; });
	// like the real SDK: the query yields nothing until interrupt() ends the iteration
	const hanging = () => {
		markStarted();
		return {
			interrupt: async () => { interrupted = true; endIteration(); },
			close: () => {},
			[Symbol.asyncIterator]: () => ({ next: () => ended.then(() => ({ done: true, value: undefined })) }),
		};
	};
	const controller = new AbortController();
	const stream = createSubscriptionStream({
		loadSdk: async () => fakeSdk(() => hanging()),
		resolveExecutable: () => "/fake/claude",
		env: {},
	});
	const eventStream = await stream(model, { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] }, { apiKey: "tok", signal: controller.signal });
	await started;
	controller.abort();
	const result = await eventStream.result();
	assert.equal(result.stopReason, "aborted");
	assert.equal(interrupted, true);
}

// --- prompt replay: history labels, tool results, final user message, image passthrough ---
{
	const blocks = buildPromptBlocks({
		messages: [
			{ role: "user", content: "make a scene", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "sure" }, { type: "toolCall", id: "t1", name: "add_object", arguments: { shape: "box" } }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "t1", toolName: "add_object", content: [{ type: "text", text: "added obj-1" }], timestamp: 3 },
			{ role: "user", content: [{ type: "text", text: "now blue" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }], timestamp: 4 },
		],
	});
	// blocks are split at content boundaries, so check the joined stream of text
	const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
	assert.ok(text.includes("<conversation_history>"));
	assert.ok(text.includes("USER:\nmake a scene"));
	assert.ok(text.includes("ASSISTANT:\nsure"));
	assert.ok(text.includes("Historical tool call (non-executable): add_object"));
	assert.ok(text.includes("TOOL RESULT (historical add_object, id=t1):"));
	assert.ok(text.includes("added obj-1"));
	assert.ok(text.includes(RESPOND_TO_USER_INSTRUCTION));
	assert.ok(text.includes("now blue"));
	const image = blocks.find((block) => block.type === "image");
	assert.deepEqual(image.source, { type: "base64", media_type: "image/png", data: "aGVsbG8=" });
}

// --- replay ending in tool results takes the continue-turn instruction ---
{
	const blocks = buildPromptBlocks({
		messages: [
			{ role: "user", content: "go", timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "inspect", arguments: {} }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "t1", toolName: "inspect", content: [{ type: "text", text: "scene has 2 objects" }], timestamp: 3 },
		],
	});
	const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
	assert.ok(text.includes(CONTINUE_TURN_INSTRUCTION));
	assert.ok(!text.includes(RESPOND_TO_USER_INSTRUCTION));
}

// --- provider shape: pi auth reused, catalogue rebound to the subscription lane ---
{
	const provider = await anthropicSubscriptionProvider();
	assert.equal(provider.id, SUBSCRIPTION_PROVIDER_ID);
	assert.equal(provider.auth.oauth.isSubscription, true);
	assert.equal(typeof provider.auth.oauth.login, "function");
	assert.equal(typeof provider.auth.oauth.refresh, "function");
	assert.ok(provider.getModels().length > 0);
	assert.ok(provider.getModels().every((entry) => entry.provider === SUBSCRIPTION_PROVIDER_ID));
	const fable = provider.getModels().find((entry) => entry.id === "claude-fable-5");
	assert.ok(fable.compat.allowedFallbackModels.every((fallback) => fallback.provider === SUBSCRIPTION_PROVIDER_ID));
}

console.log("anthropic-subscription lane: all checks passed");
