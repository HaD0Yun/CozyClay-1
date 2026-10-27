#!/usr/bin/env node
// The Studio prompts teach the three cast styles (context scene.castStyle) and the hybrid "capsules for this shot?" proposal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { STUDIO_SYSTEM_PROMPT as prompt, STUDIO_SYSTEM_PROMPT_STORYBOARD as storyboard } from "../bin/agent/studio-prompt.mjs";
import { studioSystemPrompt } from "../bin/agent/studio-motion-reference.mjs";
import { SUPERVISOR_RUBRIC } from "../bin/agent/supervisor.mjs";
import { MAIN_SYSTEM_PROMPT } from "../bin/agent/main-prompt.mjs";

const PROXY_SENTENCE = "so use only placement commands on it.";
const CAST_HEAD = "Cast style is context scene.castStyle. Never ask which body to use: the project already chose.";
const FALLBACK = "If scene.castStyle is absent, treat the project as hybrid.";
const PROPOSAL = "Proposal: \"This shot needs <what>. The rig path would need <cost: N compiles, still failing <group>>. Use capsule figures for this shot instead? (yes = capsules, no = keep the rig)\"";

test("the animation prompt states one rule per cast style", () => {
	assert.ok(prompt.includes(`\n${CAST_HEAD} ${FALLBACK}\n`), "an absent castStyle falls back to hybrid");
	assert.equal(prompt.split(FALLBACK).length, 2, "the fallback is stated once");
	assert.match(prompt, /\n- rig: cast only X Bot or Y Bot \(model y-bot-tpose or x-bot-tpose\)\. Never add a proxy-figure\./);
	assert.match(prompt, /\n- capsule: cast only capsule figures \(model "proxy-figure", posture stand, sit or lie\)\. [^\n]*do not call motion, pose or IK actions\./);
	assert.match(prompt, /\n- hybrid: use rigs by default\. Judge the shot before and after compiling\./);
	for (const signal of ["more than two hand or prop interactions outside the skill list", "three or more rigs touch or pass props", "scale is not 1",
		"output.stuck and qa.ok false", "LOAD, COLLIDE, BODY, SELF or PERSON group stays at the top severity",
		"do not change the scene: end the turn with the proposal below, in the user's language", "the user's next message is the answer",
		"add the capsule figures as NEW characters (never convert a rig)", "hide a rig only if the user agrees, and say that hiding applies to every shot", "Ask once per shot."])
		assert.ok(prompt.includes(signal), signal);
	assert.ok(prompt.includes(`\n${PROPOSAL}\n`));
});

test("the cast-style block stays static: no project value is interpolated", () => {
	assert.equal(prompt.split(CAST_HEAD).length, 2);
	assert.doesNotMatch(prompt, /castStyle (is|=) "?(rig|capsule|hybrid)"?\b/);
});

test("the block sits after the proxy sentence and before the motion reference", async () => {
	const full = await studioSystemPrompt();
	const proxy = full.indexOf(PROXY_SENTENCE), head = full.indexOf(CAST_HEAD), proposal = full.indexOf(PROPOSAL), reference = full.indexOf("\n\n<motion-reference>\n");
	assert.ok(proxy > 0 && head > proxy, "after the proxy sentence");
	assert.equal(full.slice(proxy + PROXY_SENTENCE.length, head), "\n", "right after it");
	assert.ok(proposal > head && reference > proposal, "before <motion-reference>");
	assert.ok(full.indexOf("Previs procedure") > full.indexOf("Ask concise questions only when"), "the procedure still follows the rules");
});

test("the storyboard prompt, supervisor rubric and coordinator read the cast style", () => {
	assert.ok(storyboard.endsWith("Cast style is context scene.castStyle; in a capsule project add only proxy-figure characters."));
	assert.doesNotMatch(storyboard, /- hybrid:/);
	assert.match(SUPERVISOR_RUBRIC, /In a hybrid project \(castStyle hybrid, or no castStyle given\), capsule figures the user approved in place of rigs for a shot \(previousExchange holds the proposal the request answers\) are not a coverage miss\./);
	assert.match(MAIN_SYSTEM_PROMPT, /Carry the project's cast style \(context scene\.castStyle: rig, capsule or hybrid\)/);
});
