#!/usr/bin/env node
// A custom OpenAI-compatible endpoint (#885), against a local fake server that speaks LM Studio's / Ollama's
// OpenAI surface (GET /v1/models, POST /v1/chat/completions with SSE), through the routes the panel uses:
// 1. Connect a model lists the lane; its login takes an address (a pasted /v1 is fine) and no key, checks the
//    server, and stores the address in auth.json; /agent/models then lists the server's own models;
// 2. a turn on one of them streams through pi-ai's openai-completions API to the fake server;
// 3. a server that wants a key refuses the keyless login with a readable reason, and takes the key;
// 4. an unreachable address fails the login, and a server gone after connecting shows as the provider's error.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootDir = mkdtempSync(join(tmpdir(), "cozyclay-openai-compatible-"));
process.env.COZYCLAY_CONFIG_DIR = join(rootDir, "config");
process.env.COZYCLAY_CODEX_AUTH_FILE = join(rootDir, "config", "codex-auth.json");
process.env.COZYCLAY_AGENT_SESSIONS_DIR = join(rootDir, "sessions");

const [{ createAgentHandler }, keys, providers, { createAgentRunner }] = await Promise.all([
	import("../bin/agent/agent-routes.mjs"),
	import("../bin/agent/provider-keys.mjs"),
	import("../bin/agent/providers.mjs"),
	import("../bin/agent/agent-runner.mjs"),
]);

let failures = 0;
const check = async (name, fn) => {
	try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name} — ${error.stack || error.message}`); }
};
const listen = async (server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${server.address().port}`; };
const close = async (server) => { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; };
const readAuthFile = () => { try { return JSON.parse(readFileSync(join(process.env.COZYCLAY_CONFIG_DIR, "auth.json"), "utf8")); } catch { return {}; } };

/** A fake OpenAI-compatible server; `key` makes it refuse requests without that bearer key. */
function fakeServer({ key } = {}) {
	const seen = [];
	const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "fake-llama", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const part of req) body += part;
		seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
		if (key && req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"message":"invalid api key"}}'); return; }
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "fake-llama", object: "model", owned_by: "library" }, { id: "fake-qwen", object: "model", owned_by: "library" }] }));
			return;
		}
		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(chunk({ role: "assistant", content: "Hello " }));
			res.write(chunk({ content: "from fake" }));
			res.write(chunk({}, "stop"));
			res.end("data: [DONE]\n\n");
			return;
		}
		res.writeHead(404); res.end();
	});
	return { server, seen };
}

const auth = { readStored() {}, writeStored() {}, logout() {}, status() { return { signedIn: false }; }, getAccessToken: async () => null };
const models = await providers.createModels({ auth, keys, env: {} });
const handler = createAgentHandler({ auth, models, liveHub: {}, port: () => sidecar.address().port, env: {} });
const sidecar = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
const origin = await listen(sidecar);
const request = async (path, init = {}) => {
	const response = await fetch(`${origin}${path}`, { ...init, headers: { origin, ...(init.body ? { "content-type": "application/json" } : {}) } });
	return { status: response.status, body: await response.json().catch(() => null) };
};
/** Runs the lane's login over the panel's routes, answering its two prompts; returns pi's done entry. */
async function connect(address, key) {
	const answers = [address, key];
	const { body: started } = await request("/agent/logins", { method: "POST", body: JSON.stringify({ providerId: "openai-compatible", type: "api_key" }) });
	let after = 0;
	for (;;) {
		const { body } = await request(`/agent/logins/${started.flowId}?after=${after}`);
		for (const entry of body.events) {
			if (entry.type === "done") return entry;
			if (entry.type === "prompt") await request(`/agent/logins/${started.flowId}/answer`, { method: "POST", body: JSON.stringify({ promptId: entry.promptId, value: answers.shift() }) });
		}
		after = body.next;
	}
}
const lane = async () => (await request("/agent/models")).body.providers.find((entry) => entry.id === "openai-compatible");

const open = fakeServer();
const openBase = await listen(open.server);

await check("Connect a model lists the lane; a keyless login stores the address and /agent/models lists the server's models", async () => {
	const listed = (await request("/agent/logins")).body.providers.find((entry) => entry.id === "openai-compatible");
	assert.deepEqual(listed.methods.map((method) => method.type), ["api_key"]);
	assert.equal(listed.connected, false);
	assert.equal((await lane()).signedIn, false);
	const done = await connect(`${openBase}/v1/`, "");
	assert.equal(done.ok, true, done.message);
	assert.deepEqual(readAuthFile()["openai-compatible"], { type: "api_key", key: "", env: { OPENAI_COMPATIBLE_BASE_URL: openBase } });
	assert.equal(open.seen.at(-1).authorization, undefined, "no key, no Authorization header on the check");
	const entry = await lane();
	assert.equal(entry.signedIn, true);
	assert.equal(entry.error, undefined);
	assert.deepEqual(entry.models.map((model) => model.key).sort(), ["openai-compatible/fake-llama", "openai-compatible/fake-qwen"]);
	assert.equal((await request("/agent/providers/openai-compatible", { method: "PUT", body: JSON.stringify({ key: "k" }) })).status, 400, "a bare key without an address is refused");
});

await check("a turn on a listed model streams through openai-completions to the server", async () => {
	// a fresh registry has not read /v1/models yet: the turn's model lookup reads it
	const runner = createAgentRunner({ models: await providers.createModels({ auth, keys, env: {} }), tools: [] });
	const session = await runner.openSession("openai-compatible-turn", { surface: "workflow" });
	const frames = [];
	for await (const frame of session.start({ text: "hi", model: "openai-compatible/fake-llama" })) frames.push(frame);
	await runner.close();
	assert.ok(frames.some((frame) => frame.type === "done"), JSON.stringify(frames));
	assert.ok(!frames.some((frame) => frame.type === "error"), JSON.stringify(frames));
	assert.equal(frames.filter((frame) => frame.type === "text.delta").map((frame) => frame.text).join(""), "Hello from fake");
	const call = open.seen.find((entry) => entry.url === "/v1/chat/completions");
	assert.equal(call.body.model, "fake-llama");
	assert.equal(call.body.stream, true);
	assert.equal(call.authorization, "Bearer no-key");
});

const locked = fakeServer({ key: "secret-1" });
const lockedBase = await listen(locked.server);

await check("a server that wants a key refuses the keyless login with a reason, then connects with the key", async () => {
	const refused = await connect(lockedBase, "");
	assert.equal(refused.ok, false);
	assert.match(refused.message, /refused a request without a key \(401\)/);
	const done = await connect(lockedBase, "secret-1");
	assert.equal(done.ok, true, done.message);
	assert.equal(readAuthFile()["openai-compatible"].key, "secret-1");
	const entry = await lane();
	assert.equal(entry.error, undefined);
	assert.equal(entry.models.length, 2);
	assert.equal(locked.seen.at(-1).authorization, "Bearer secret-1");
});

await check("an unreachable address fails the login; a server gone after connecting is the provider's error", async () => {
	const gone = createServer();
	const goneBase = await listen(gone);
	await close(gone);
	const refused = await connect(goneBase, "");
	assert.equal(refused.ok, false);
	assert.match(refused.message, /Could not reach .*\/v1\/models \(ECONNREFUSED\)/);
	await close(locked.server);
	const entry = await lane();
	assert.equal(entry.signedIn, true);
	assert.match(entry.error, /Could not reach .*\/v1\/models/);
	assert.equal((await request("/agent/logout/openai-compatible", { method: "POST" })).status, 200);
	assert.equal(readAuthFile()["openai-compatible"], undefined);
	assert.equal((await lane()).signedIn, false);
});

await close(open.server);
await close(sidecar);
rmSync(rootDir, { recursive: true, force: true });
if (failures) { console.error(`${failures} OpenAI-compatible endpoint check(s) failed`); process.exit(1); }
console.log("verify-agent-openai-compatible: all checks passed");
