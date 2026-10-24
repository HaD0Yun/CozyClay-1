// C7. Output budget: a motion action's output must fit the receipt (8 KiB, of which the receipt
// head and readback take about 1.5 KB), so fitOutput keeps the most useful parts within
// MOTION_OUTPUT_BUDGET bytes of JSON and says what it cut in `more`; the cut parts stay in the
// spec store (spec-store.js) and motion.report pages through them. Keep order (first = last cut):
//   1. brief, frames, fps, installed, specId, qa.ok/total/goals, observations, delta, repair  (always;
//      observations are bounded: a fixed set of joints and limbs, about 1 KB)
//   2. the first MIN_FULL qa.groups in full
//   3. probes
//   4. timeline (the planted spans go first, then entries from the end)
//   5. the other groups as one-liners { kind, subject, count, severity, first, last }
//   6. qa.warnings (qa/arm-checks.js: never failing, so after every group), as many lines as fit
//   7. fixed, search, skills, ms
// An answer that does not fit and has a delta (base + patch) says observations.units only by reference: the
// base's answer gave them. Last resort: observations.asked and the brief lose lines, then full groups become one-liners.
// Room left after that turns one-liners back into full groups, from the top. A head still too big (a
// repair that applied many patches) keeps the newest repair.applied entries; more.repair counts the rest.
// brief (briefOf) is the answer in a few fixed-shape lines, so a script comparing variants returns it as
// it is instead of mapping qa itself:
//   "<specId> qa ok|<problems> problems (<total> issues)[, installed|not installed]"
//   "goals <n ok>/<n>[; MISS <name> <value> f<at> (<= or >= need)]...[; <n> more]"  (when the spec has goals; 3 misses)
//   "<KIND> <subject> x<count> f<first>-<last>"  (the first 2 groups past the GOAL ones, which MISS names; subject cut to 48)

export const MOTION_OUTPUT_BUDGET = 6000;
const MIN_FULL = 4, BRIEF_GROUPS = 2, BRIEF_MISSES = 3, BRIEF_SUBJECT = 48;
const AT_MOST = new Set(["near", "still"]), UNITS_SEEN = "as in the base's answer";
const size = v => new TextEncoder().encode(JSON.stringify(v)).length;
const oneLine = g => ({ kind: g.kind, subject: g.subject, count: g.count, severity: g.severity, first: g.first, last: g.last });

/** The fixed-shape summary lines of an answer with qa (see the head comment), or null without qa. */
export function briefOf({ specId, installed, qa }) {
	if (!qa) return null;
	const head = `${specId ?? "spec"} qa ${qa.ok ? "ok" : `${qa.problems ?? qa.groups?.length ?? 0} problems (${qa.total} issues)`}${installed === undefined ? "" : installed ? ", installed" : ", not installed"}`;
	const goals = qa.goals ?? [], failed = goals.filter(g => !g.ok), miss = failed.slice(0, BRIEF_MISSES)
		.map(g => `; MISS ${g.name} ${g.value ?? "never"}${g.at === null ? "" : ` f${g.at}`} (${AT_MOST.has(g.kind) ? "<=" : ">="} ${g.need})`).join("");
	const more = failed.length > BRIEF_MISSES ? `; ${failed.length - BRIEF_MISSES} more` : "";
	const groups = (qa.groups ?? []).filter(g => g.kind !== "GOAL").slice(0, BRIEF_GROUPS).map(g => `${g.kind} ${g.subject.slice(0, BRIEF_SUBJECT)} x${g.count} f${g.first}-${g.last}`);
	return [head, ...(goals.length ? [`goals ${goals.length - failed.length}/${goals.length}${miss}${more}`] : []), ...groups];
}

/**
 * full output -> output within `budget` bytes of JSON, with brief (briefOf) first. When something was cut it carries
 * more: { specId, groups, timeline, probes }, how many items of each part are missing or
 * shortened; motion.report { specId, part, from } pages the whole part.
 */
export function fitOutput(answer, budget = MOTION_OUTPUT_BUDGET) {
	const brief = briefOf(answer), full = brief ? { brief, ...answer } : answer;
	if (size(full) <= budget) return full;
	const { qa, observations: all, probes, timeline, fixed, search, skills, ms, ...head } = full;
	// an answer to base + patch leaves out the units the base's answer gave
	const observations = all?.units && full.delta ? { ...all, units: UNITS_SEEN } : all;
	const groups = qa?.groups ?? [], more = { specId: full.specId, groups: 0, timeline: 0, probes: 0 };
	const { warnings, ...qaHead } = qa ?? {};
	const out = { ...head, ...(qa ? { qa: { ...qaHead, groups: [] } } : {}), ...(observations ? { observations } : {}) };
	// the counts in `more` may still grow by a digit or two after a check
	const fits = extra => size({ ...out, ...extra, more }) <= budget - 32;
	const nFull = Math.min(MIN_FULL, groups.length);
	if (qa) out.qa.groups = groups.slice(0, nFull);
	if (probes) {
		const kept = {};
		for (const [k, v] of Object.entries(probes)) if (fits({ probes: { ...kept, [k]: v } })) kept[k] = v;
		out.probes = kept; more.probes = Object.keys(probes).length - Object.keys(kept).length;
	}
	if (timeline) {
		const lean = timeline.map(({ planted, ...rest }) => rest), list = fits({ timeline }) ? timeline : lean;
		let n = list.length;
		while (n > 0 && !fits({ timeline: list.slice(0, n) })) n--;
		out.timeline = list.slice(0, n);
		more.timeline = list === lean ? timeline.length : timeline.length - n;
	}
	for (let i = nFull; i < groups.length && fits({ qa: { ...out.qa, groups: [...out.qa.groups, oneLine(groups[i])] } }); i++) out.qa.groups.push(oneLine(groups[i]));
	for (let n = warnings?.length ?? 0; n > 0; n--) if (fits({ qa: { ...out.qa, warnings: warnings.slice(0, n) } })) { out.qa.warnings = warnings.slice(0, n); break; }
	for (const [k, v] of [["fixed", fixed], ["search", search], ["skills", skills], ["ms", ms]]) if (v !== undefined && fits({ [k]: v })) out[k] = v;
	for (let i = nFull; i < out.qa?.groups.length && fits({ qa: { ...out.qa, groups: out.qa.groups.map((g, j) => (j === i ? groups[i] : g)) } }); i++) out.qa.groups[i] = groups[i];
	// last resort (huge hints): observations.asked loses its goal and contact lines from the end, the brief its group
	// lines, then full groups become one-liners from the end, then asked loses its skill lines
	const asked = out.observations?.asked, cut = keep => { while (out.observations.asked.length > keep && !fits({})) out.observations.asked.pop(); };
	if (asked) { out.observations = { ...out.observations, asked: [...asked] }; cut(asked.filter(l => l.startsWith("use[")).length); }
	// the brief's group lines repeat qa.groups
	while (out.brief?.length > 1 && !out.brief[out.brief.length - 1].startsWith("goals ") && !fits({})) out.brief = out.brief.slice(0, -1);
	for (let i = nFull - 1; i >= 0 && !fits({}); i--) out.qa.groups[i] = oneLine(groups[i]);
	// a long repair (each applied patch in full) keeps its newest changes; the stored spec holds them all
	const applied = out.repair?.applied;
	if (Array.isArray(applied) && !fits({})) {
		let n = applied.length;
		while (n > 0 && !fits({ repair: { ...out.repair, applied: applied.slice(applied.length - n) } })) n--;
		out.repair = { ...out.repair, applied: applied.slice(applied.length - n) };
		more.repair = applied.length - n;
	}
	if (asked) cut(0);
	if (asked && !out.observations.asked.length) delete out.observations.asked;
	more.groups = groups.length - (out.qa?.groups ?? []).filter(g => "worst" in g).length;
	return { ...out, more };
}

/**
 * One page of a stored part for motion.report: items from index `from` on, as many as fit the
 * budget (at least one). parts = { groups: [], timeline: [], probes: { name: result } }.
 * @returns {{ specId: string, part: string, from: number, items: any[], next: number | null }}
 */
export function reportPage(parts, specId, part, from = 0, budget = MOTION_OUTPUT_BUDGET) {
	const all = part === "probes" ? Object.entries(parts?.probes ?? {}).map(([name, r]) => ({ name, ...r })) : parts?.[part] ?? [];
	const page = { specId, part, from, items: [], next: null };
	for (let i = from; i < all.length; i++) {
		if (page.items.length && size({ ...page, items: [...page.items, all[i]], next: i + 1 }) > budget) { page.next = i; break; }
		page.items.push(all[i]);
	}
	return page;
}
