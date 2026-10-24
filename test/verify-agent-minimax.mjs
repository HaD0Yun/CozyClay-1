#!/usr/bin/env node
// MiniMax providers: both endpoints are curated, their keys are accepted from
// env or the key file, and pi's MiniMax-M3.1-Flash reaches /agent/models with
// the thinking levels its data declares.
import assert from "node:assert/strict";

const providers = await import("../bin/agent/providers.mjs");

const auth = { readStored: () => undefined };
const noKeys = { readKeys: () => ({}) };
const env = { MINIMAX_API_KEY: "minimax-test-key", MINIMAX_CN_API_KEY: "minimax-cn-test-key" };

const status = providers.providerStatus({ auth, keys: noKeys, env });
for (const [id, label] of [["minimax", "MiniMax"], ["minimax-cn", "MiniMax (China)"]]) {
	const entry = status.find((provider) => provider.id === id);
	assert.ok(entry, `${id} must be a curated provider`);
	assert.equal(entry.label, label);
	assert.equal(entry.signedIn, true, `${id} is signed in through its env key`);
	assert.equal(entry.authSource, "env");
}

const unsigned = providers.providerStatus({ auth, keys: noKeys, env: {} });
assert.equal(unsigned.find((provider) => provider.id === "minimax").signedIn, false);
assert.equal(unsigned.find((provider) => provider.id === "minimax-cn").signedIn, false);

const fileKeys = { readKeys: () => ({ minimax: "stored-minimax-key" }) };
assert.equal(providers.providerStatus({ auth, keys: fileKeys, env: {} }).find((provider) => provider.id === "minimax").authSource, "file");

const models = await providers.createModels({ auth, keys: noKeys, env });
const listed = await providers.listAgentModels({ models, auth, keys: noKeys, env });
const minimax = listed.providers.find((provider) => provider.id === "minimax");
assert.ok(minimax, "MiniMax appears in the model catalogue");
const flash = minimax.models.find((model) => model.id === "MiniMax-M3.1-Flash");
assert.ok(flash, "MiniMax-M3.1-Flash is listed");
assert.equal(flash.key, "minimax/MiniMax-M3.1-Flash");
assert.deepEqual(flash.efforts, ["low", "medium", "high", "xhigh", "max"]);
assert.equal(flash.defaultEffort, "medium");
assert.ok(minimax.models.some((model) => model.id === "MiniMax-M3"), "the other MiniMax models stay listed");

const cn = listed.providers.find((provider) => provider.id === "minimax-cn");
assert.ok(cn, "MiniMax CN appears in the model catalogue");
assert.ok(cn.models.some((model) => model.id === "MiniMax-M3.1-Flash"), "MiniMax CN lists M3.1 Flash");

const flashModel = models.getModel("minimax", "MiniMax-M3.1-Flash");
assert.equal(flashModel.baseUrl, "https://api.minimax.io/anthropic");
assert.equal(flashModel.api, "anthropic-messages");
assert.deepEqual(flashModel.input, ["text", "image"]);
const cnFlashModel = models.getModel("minimax-cn", "MiniMax-M3.1-Flash");
assert.equal(cnFlashModel.baseUrl, "https://api.minimaxi.com/anthropic");

console.log("all MiniMax provider checks PASS");
