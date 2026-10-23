// SDK stream-event → pi assistant-message event translation for the subscription lane, plus the
// output message scaffolding. The lane receives Anthropic's raw SSE protocol re-exported by the
// SDK (`stream_event` messages), so this mirrors what pi-ai's anthropic-messages api does with
// the same events.

/** The SDK names host tools mcp__cozyclay-tools__<name>; pi knows them by the bare name. */
const CUSTOM_TOOLS_MCP_PREFIX = "mcp__cozyclay-tools__";

const asRecord = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});

export function mapStopReason(reason) {
	if (reason === "tool_use") return "toolUse";
	if (reason === "max_tokens") return "length";
	return "stop";
}

function mapSdkToolNameToPi(name) {
	return typeof name === "string" && name.startsWith(CUSTOM_TOOLS_MCP_PREFIX) ? name.slice(CUSTOM_TOOLS_MCP_PREFIX.length) : name;
}
export function updateUsage(model, output, usage, { reset = false, contextUsage = true } = {}) {
	if (!usage) return;
	if (reset) {
		output.usage.input = 0;
		output.usage.output = 0;
		output.usage.cacheRead = 0;
		output.usage.cacheWrite = 0;
	}
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
}

/** SDK raw stream_event (the Anthropic SSE protocol, re-exported) → pi assistant-message events. */
export function applyStreamEvent(state, event, parseStreamingJson) {
	const { output, blocks, stream } = state;
	const openBlock = (block, kind) => {
		blocks.push(block);
		output.content.push(block);
		stream.push({ type: `${kind}_start`, contentIndex: output.content.length - 1, partial: output });
	};
	if (event.type === "message_start") {
		output.responseId ??= event.message?.id || undefined;
		updateUsage(state.model, output, event.message?.usage, { reset: true });
		return;
	}
	if (event.type === "content_block_start") {
		const block = event.content_block;
		if (block?.type === "text") openBlock({ type: "text", text: "", index: event.index }, "text");
		else if (block?.type === "thinking") openBlock({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index }, "thinking");
		else if (block?.type === "tool_use") {
			openBlock({
				type: "toolCall",
				id: block.id,
				name: mapSdkToolNameToPi(block.name),
				arguments: asRecord(block.input),
				partialJson: "",
				index: event.index,
			}, "toolcall");
		}
		return;
	}
	if (event.type === "content_block_delta") {
		const contentIndex = blocks.findIndex((candidate) => candidate.index === event.index);
		const block = blocks[contentIndex];
		const delta = event.delta;
		if (delta?.type === "text_delta" && block?.type === "text") {
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex, delta: delta.text, partial: output });
		} else if (delta?.type === "thinking_delta" && block?.type === "thinking") {
			block.thinking += delta.thinking;
			stream.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial: output });
		} else if (delta?.type === "signature_delta" && block?.type === "thinking") {
			block.thinkingSignature += delta.signature;
		} else if (delta?.type === "input_json_delta" && block?.type === "toolCall") {
			block.partialJson = `${block.partialJson ?? ""}${delta.partial_json}`;
			block.arguments = parseStreamingJson(block.partialJson);
			stream.push({ type: "toolcall_delta", contentIndex, delta: delta.partial_json, partial: output });
		}
		return;
	}
	if (event.type === "content_block_stop") {
		const contentIndex = blocks.findIndex((candidate) => candidate.index === event.index);
		const block = blocks[contentIndex];
		if (block?.type === "text") stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
		else if (block?.type === "thinking") stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
		else if (block?.type === "toolCall") {
			block.arguments = parseStreamingJson(block.partialJson);
			delete block.partialJson;
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
		}
		if (block) delete block.index;
		return;
	}
	if (event.type === "message_delta") {
		if (event.delta?.stop_reason) {
			output.rawStopReason = event.delta.stop_reason;
			output.stopReason = mapStopReason(event.delta.stop_reason);
		}
		updateUsage(state.model, output, event.usage);
	}
}

export function emptyOutput(model) {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			contextUsage: null,
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
