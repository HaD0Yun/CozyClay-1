#!/usr/bin/env node
// Opening a project when the browser returns a picked handle but refuses to read it (the OmO desktop preview):
// the open falls back to a plain file input, and that browser keeps using it.
import assert from "node:assert/strict";

const KEY = "cozyclay.open-picker-unreadable";
const memory = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) }; };
const calls = [];
const deniedHandle = { getFile: async () => { const error = new Error("The request is not allowed"); error.name = "NotAllowedError"; throw error; } };
const readableHandle = { getFile: async () => ({ name: "Kept.cclayproject", text: async () => "{\"kept\":true}", lastModified: 7 }) };
let picked = deniedHandle;
globalThis.window = { showSaveFilePicker() {}, showOpenFilePicker: async () => { calls.push("picker"); return [picked]; } };
globalThis.document = { createElement: () => {
	const input = { files: [{ name: "Tutorial.cclayproject", text: async () => "{\"fallback\":true}", lastModified: 3 }] };
	input.click = () => { calls.push("input"); queueMicrotask(() => input.onchange()); };
	return input;
} };
const { pickProjectToOpen } = await import("../src/project-open-file.js");

{
	const storage = memory();
	picked = readableHandle;
	const opened = await pickProjectToOpen(storage, { isActive: true });
	assert.equal(opened.handle, readableHandle, "a readable picked handle is kept, so Save writes back to the same file");
	assert.equal(opened.file.text, "{\"kept\":true}");
	assert.equal(storage.getItem(KEY), null, "a browser that reads its handles keeps the picker");
}
{
	calls.length = 0;
	const storage = memory();
	picked = deniedHandle;
	const opened = await pickProjectToOpen(storage, { isActive: true });
	assert.deepEqual(calls, ["picker", "input"], "a refused read reopens the choice as a file input while the click is still live");
	assert.equal(opened.handle, null);
	assert.equal(opened.file.text, "{\"fallback\":true}", "the file input's bytes open the project");
	assert.equal(storage.getItem(KEY), "1", "the refusal is remembered for this browser");
	calls.length = 0;
	await pickProjectToOpen(storage, { isActive: true });
	assert.deepEqual(calls, ["input"], "the next open goes straight to the file input");
}
{
	calls.length = 0;
	const storage = memory();
	const opened = await pickProjectToOpen(storage, { isActive: false });
	assert.deepEqual(opened, { blocked: true }, "after a slow pick the input cannot open by itself, so the author is asked to open once more");
	assert.deepEqual(calls, ["picker"]);
	assert.equal(storage.getItem(KEY), "1");
}
{
	const storage = memory();
	picked = { getFile: async () => { throw new TypeError("disk gone"); } };
	await assert.rejects(pickProjectToOpen(storage, { isActive: true }), TypeError, "any other read failure still surfaces as an error");
	assert.equal(storage.getItem(KEY), null);
}
console.log("PASS project open falls back to a file input when the picked handle cannot be read");
