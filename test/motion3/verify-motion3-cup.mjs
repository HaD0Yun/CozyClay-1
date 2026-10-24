#!/usr/bin/env node
// Lane I: the motion API v3.1 lanes working together on the cup scene, through the real action
// registry. A left hand grabs the cup group `empty-2` by its handle and lifts it; one compile
// answers goals, probes, the timeline (grab/release events), a spec id within the receipt
// budget; base + patch answers a delta; a broken spec repairs; describe answers every topic;
// and QA groups keep ids that differ only by digits apart.
import { createStudioAppActions } from "../../src/commands/index.js";
import { SCENE_OBJECTS, CHARACTER, CUP } from "./fixtures/cup-scene.mjs";
import { DESCRIBE_TOPICS } from "../../src/motion3/schema/fields.js";
import { MOTION_OUTPUT_BUDGET } from "../../src/motion3/report.js";
import { DESCRIBE_BUDGET } from "../../src/motion3/describe.js";
import { groupKey } from "../../src/motion3/qa/severity.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const takes = new Map();
const owner = { replace: (id, take) => takes.set(id, take), motionFor: id => takes.get(id) ?? null };
const registry = createStudioAppActions({ state: () => ({ characters: [CHARACTER], objects: SCENE_OBJECTS, frameCount: 300 }), storeDomain: name => (name === "motion" ? owner : null) });
const run = (id, args) => { const r = registry.run(id, args); return r?.output ?? r?.receipt?.output ?? r; };
const refusal = fn => { try { fn(); return ""; } catch (error) { return error.message ?? String(error); } };

const GRAB = 34, RELEASE = 80;
// The fingers (prop "grip") land on the handle `cube-6` through a fit; the cup rides the hand
// from GRAB to RELEASE as one group.
const cupSpec = (over = {}) => ({
	schema: "cozyclay.motion-spec.v1", fps: 24, frames: 100,
	use: [{ skill: "standIdle", args: { at: [0.15, 0.3], heading: 0 }, f0: 0 }],
	props: { grip: { hand: "l", origin: ["LeftHandIndex2", "LeftHandMiddle2"], points: { fingers: [0, 0, 0] } } },
	anchors: { cupHandle: { kind: "object", object: "cube-6", local: [0, 0.03, 0] } },
	fits: [{ side: "l", anchor: "cupHandle", effector: { prop: "grip", point: "fingers" } }],
	keys: [{ f: 10, set: { pitch: 0, armw_l: 0, w_cupHandle_l: 0 } },
		{ f: 30, set: { pitch: 25, armw_l: 1, w_cupHandle_l: 1, hand_l: [0.3, 1, 0.7] } },
		{ f: 36, set: { w_cupHandle_l: 1, pitch: 25, hand_l: [0.3, 1, 0.7] } },
		{ f: 60, set: { w_cupHandle_l: 0, pitch: 10, hand_l: [0.3, 1.2, 0.6] } }, { f: 99, set: {} }],
	objects: { [CUP.group]: { prop: "grip", grab: GRAB, release: RELEASE } },
	goals: [{ name: "cup lifted", moved: `object:${CUP.group}`, by: 0.1, at: [65, 75] }],
	...over,
});
const probes = [{ name: "handToCup", distance: ["joint:lefthand", `object:${CUP.group}`], frames: [20, 40] },
	{ name: "cupBase", position: `object:${CUP.group}.base`, frames: [0, 90], every: 10 }];

// ---- one compile: goals, probes, timeline, spec id, budget --------------------------------
const first = run("motion.compile", { characterId: CHARACTER.id, spec: cupSpec(), probes, install: false });
const bytes = JSON.stringify(first).length;
// The hand reaches across the table top here, so QA still reports REACH/COLLIDE groups (a live agent
// works those off with the hints); the goal and the grab are what this check pins.
expect("the pick-up meets its goal and grabs within reach (no GRAB group)", first.qa?.goals?.[0]?.ok === true && !first.qa.groups.some(g => g.kind === "GRAB"), JSON.stringify(first.qa).slice(0, 400));
expect("the output fits the receipt budget", bytes <= MOTION_OUTPUT_BUDGET, `${bytes} B`);
expect("a spec id names the compile", /^spec-[0-9a-f]{12}$/.test(first.specId ?? ""), first.specId);
const events = (first.timeline ?? []).flatMap(b => b.events ?? []);
expect("the timeline carries the grab and the release of the cup group", events.some(e => e.event === "grab" && e.f === GRAB && e.object === CUP.group)
	&& events.some(e => e.event === "release" && e.f === RELEASE && e.object === CUP.group), JSON.stringify(events));
const reach = first.probes?.handToCup, base = first.probes?.cupBase?.at ?? [];
expect("a loose bone name probes the hand to cup distance", reach && reach.min < 0.2 && reach.minAt >= 28 && reach.minAt <= 40, JSON.stringify(reach));
const lift = base.length ? Math.max(...base.map(r => r.p[1])) - base[0].p[1] : 0;
expect("the cup base rises at least 10 cm while held", lift >= 0.1, `${lift.toFixed(3)} m`);
expect("install: false leaves the character without a take", !takes.has(CHARACTER.id));

// ---- base + patch -> delta ---------------------------------------------------------------
const late = run("motion.compile", { characterId: CHARACTER.id, base: first.specId, patch: [{ op: "replace", path: "/objects/empty-2/grab", value: 24 }], install: false });
expect("base + patch answers a new id and a delta against the base", late.specId && late.specId !== first.specId && late.delta?.base === first.specId
	&& late.delta.new >= 1 && late.qa.ok === false, JSON.stringify({ id: late.specId, delta: late.delta }));
const grabGroup = late.qa.groups.find(g => g.kind === "GRAB");
// a plain compile keeps each hint's words and offers no patch; a compile with repair offers a patch only once compiled (hint-check.js)
expect("an early grab is a GRAB group on the cup with a hint; a plain compile offers no patch", grabGroup && /empty-2/.test(grabGroup.subject) && /set objects\.empty-2\.grab to 28/.test(grabGroup.hint)
	&& late.qa.groups.every(g => !g.patch && !g.patchTried), JSON.stringify(grabGroup));
const lateRepaired = run("motion.compile", { characterId: CHARACTER.id, base: first.specId, patch: [{ op: "replace", path: "/objects/empty-2/grab", value: 24 }], install: false, repair: { rounds: 1 } });
expect("with repair, every patch offered was compiled and helped", lateRepaired.qa.groups.every(g => !g.patch || g.patchChecked), JSON.stringify(lateRepaired.qa.groups.map(g => [g.kind, Boolean(g.patch), Boolean(g.patchChecked)])));

// ---- repair --------------------------------------------------------------------------------
const repaired = run("motion.compile", { characterId: CHARACTER.id, base: late.specId, repair: { rounds: 4 }, install: false });
expect("repair applies the hint patches and answers what it did", repaired.repair && repaired.repair.compiles >= 1 && (repaired.repair.applied?.length ?? 0) >= 1, JSON.stringify(repaired.repair));
expect("after repair the GRAB group is gone", !repaired.qa.groups.some(g => g.kind === "GRAB"), JSON.stringify(repaired.qa.groups.slice(0, 3)));

// ---- install and re-measure -----------------------------------------------------------------
const installed = run("motion.compile", { characterId: CHARACTER.id, base: first.specId, install: true });
const qa = run("motion.qa", { characterId: CHARACTER.id });
expect("install stores the take and motion.qa answers the same spec id", takes.get(CHARACTER.id)?.schema === "cozyclay.take.v3" && qa.specId === installed.specId, JSON.stringify({ i: installed.specId, q: qa.specId }));
expect("motion.qa answers the goal too", qa.qa.goals?.[0]?.ok === true, JSON.stringify(qa.qa.goals));

// ---- describe, strict validation ----------------------------------------------------------
const sizes = DESCRIBE_TOPICS.map(topic => [topic, JSON.stringify(run("motion.describe", { topic })).length]);
expect("motion.describe answers every topic within the budget", sizes.every(([t, n]) => n > 0 && n <= (t === "essentials" ? DESCRIBE_BUDGET : MOTION_OUTPUT_BUDGET)), JSON.stringify(sizes));
const probe = refusal(() => registry.run("motion.compile", { characterId: CHARACTER.id, spec: cupSpec({ objects: { [CUP.group]: { prop: "grip", grab: GRAB, zzz: 1 } } }), install: false }));
expect("a bogus field is refused with the allowed fields", /zzz/.test(probe) && /grab/.test(probe), probe);

// ---- QA groups keep ids that differ only by digits apart ----------------------------------
const key = subject => groupKey({ kind: "COLLIDE", subject });
expect("groupKey keeps cube-6 and cube-7 apart and still folds depths", key("empty-2 x cube-6") !== key("empty-2 x cube-7") && key("empty-2 x cube-6") !== key("empty-3 x cube-6")
	&& groupKey({ kind: "CONTACT", subject: "contacts[0]: 100.0 cm apart" }) === groupKey({ kind: "CONTACT", subject: "contacts[0]: 2.5 cm apart" })
	&& groupKey({ kind: "GOAL", subject: "goal 1: 0.31 m at f150 (needs <= 0.06)" }) === groupKey({ kind: "GOAL", subject: "goal 1: 0.2 m at f160 (needs <= 0.06)" })
	&& groupKey({ kind: "GOAL", subject: "goal 1: 0.31 m at f150" }) !== groupKey({ kind: "GOAL", subject: "goal 2: 0.31 m at f150" }));

if (failures) { console.error(`${failures} cup integration check(s) failed`); process.exit(1); }
console.log("verify-motion3-cup: all checks passed");
