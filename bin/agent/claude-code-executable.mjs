// Resolving the Claude Code executable for the anthropic-subscription lane. The lane's API calls
// must come from the official Claude Code binary (Anthropic's subscription terms tie the OAuth
// token to it), so the provider spawns it through the Claude Agent SDK. Order: the
// CLAUDE_CODE_EXECUTABLE override, the platform sidecar package the SDK ships
// (@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude), then `claude` on PATH. Nothing is
// accepted on resolution alone: a candidate counts only once it stats as a file.
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, isAbsolute, join } from "node:path";

const require = createRequire(import.meta.url);

function executableName(platform = process.platform) {
	return platform === "win32" ? "claude.exe" : "claude";
}

function sidecarCandidates(platform = process.platform, arch = process.arch) {
	const ext = platform === "win32" ? ".exe" : "";
	if (platform === "linux") {
		return [
			`@anthropic-ai/claude-agent-sdk-linux-${arch}/claude${ext}`,
			`@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude${ext}`,
		];
	}
	return [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${ext}`];
}

function isFile(candidate) {
	try {
		return statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function findOnPath(command, env = process.env) {
	const pathEnv = env.PATH;
	if (!pathEnv) return null;
	for (const directory of pathEnv.split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, command);
		if (isFile(candidate)) return candidate;
	}
	return null;
}

/**
 * { executable, source, tried } on success, { executable: undefined, tried } when every source
 * missed. `tried` names every spelling checked so the error can say exactly what was probed.
 */
function describeClaudeCodeExecutable({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
	const tried = [];
	const accept = (candidate) => {
		tried.push(candidate);
		return isFile(candidate) ? candidate : undefined;
	};
	const override = env.CLAUDE_CODE_EXECUTABLE;
	if (override) {
		const accepted = accept(isAbsolute(override) ? override : join(process.cwd(), override));
		if (accepted !== undefined) return { executable: accepted, source: "override", tried };
	}
	for (const candidate of sidecarCandidates(platform, arch)) {
		let resolved;
		try {
			resolved = require.resolve(candidate);
		} catch {
			tried.push(candidate); // the sidecar package is not installed; name it by specifier
			continue;
		}
		const accepted = accept(resolved);
		if (accepted !== undefined) return { executable: accepted, source: "bundled", tried };
	}
	const onPath = findOnPath(executableName(platform), env);
	if (onPath !== null) {
		const accepted = accept(onPath);
		if (accepted !== undefined) return { executable: accepted, source: "path", tried };
	} else {
		tried.push("claude on PATH");
	}
	return { executable: undefined, source: undefined, tried };
}

/** The validated executable, or an error naming every candidate — the SDK never sees a miss. */
export function resolveClaudeCodeExecutable(deps = {}) {
	const resolution = describeClaudeCodeExecutable(deps);
	if (resolution.executable !== undefined) return resolution.executable;
	throw new Error([
		"Claude Code executable not found; the Anthropic subscription lane needs it.",
		"Reinstall cozyclay so the @anthropic-ai/claude-agent-sdk platform package is present,",
		"install Claude Code so `claude` is on PATH, or set CLAUDE_CODE_EXECUTABLE to the binary.",
		`Tried: ${resolution.tried.join(", ")}`,
	].join(" "));
}
