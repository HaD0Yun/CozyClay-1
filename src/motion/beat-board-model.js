// The beat board's content (beat-board.jsx), from the agent's newest draft (agent-progress.js): each beat of the
// draft's timeline as a block over its frames, with what QA found in it. A QA group (other than GOAL) whose frames
// overlap the block is an issue there; a goal measured at a frame inside it is met or missed there. A block with a
// missed goal reads "goal", else one with issues reads "issue", else "clean". Every issue also draws its own frame
// span and every goal a mark at its frame, so where QA objects shows inside a long block. Beats that overlap each
// other (two hands' skills at once) take separate rows, at most MAX_ROWS.
// Pure: no React, no DOM.
import { ko } from "../locale.js";

const MAX_ROWS = 3;

const LABELS = {
	walk: ["Walk", "걷기", "行走"], walkTo: ["Walk", "걷기", "行走"], keys: ["Keys", "키 포즈", "关键姿势"], standIdle: ["Stand", "서 있기", "站立"],
	sitInSeat: ["Sit", "앉기", "坐下"], exitCar: ["Exit car", "차에서 내리기", "下车"], reachGrip: ["Reach and grip", "뻗어 잡기", "伸手抓取"],
	smokeCigarette: ["Smoke", "담배", "吸烟"],
};

/** A short, readable name for a beat (the timeline's skill or generator name). */
export function beatLabel(beat) {
	const pair = LABELS[beat];
	return pair ? ko(pair[0], pair[1], pair[2]) : String(beat ?? "");
}

const overlaps = (a0, a1, b0, b1) => a0 <= b1 && b0 <= a1;

/** True when the take on the timeline is still the draft as compiled: same length, one segment, untrimmed, 1x. */
export function takeIsDraft(motion, draft) {
	const segments = motion?.segments;
	if (!draft || !segments?.length || motion.frames !== draft.frames || segments.length !== 1) return false;
	const [only] = segments;
	return only.speed === 1 && only.timelineStart === 0 && only.timelineEnd === draft.frames - 1;
}

/**
 * beatBoardModel(draft, motion) -> null (nothing to show) or
 * { mode: "draft" | "installed", n, total, ok, blocks: [{ key, beat, label, src, f0, f1, row, rows, issues, groups,
 *   goals, missed, state, events }], spans: [{ f0, f1, text }] (each issue), marks: [{ f, ok, text }] (each goal) }.
 * mode "draft": the newest draft is not installed. mode "installed": it is, and the timeline's take is still that draft
 * (takeIsDraft); a take retimed or trimmed since shows nothing, its frames no longer match the beats.
 */
export function beatBoardModel(draft, motion) {
	if (!draft?.timeline?.length) return null;
	const mode = draft.installed ? "installed" : "draft";
	if (mode === "installed" && !takeIsDraft(motion, draft)) return null;
	const groups = (draft.qa?.groups ?? []).filter(g => g.kind !== "GOAL");
	const goals = (draft.qa?.goals ?? []).filter(g => Number.isFinite(g.at));
	const rowEnds = [];
	const blocks = draft.timeline.map((b, index) => {
		const [f0, f1] = b.f;
		const inGroups = groups.filter(g => overlaps(f0, f1, g.first ?? 0, g.last ?? g.first ?? 0));
		const inGoals = goals.filter(g => g.at >= f0 && g.at <= f1);
		const missed = inGoals.filter(g => !g.ok).length;
		let row = rowEnds.findIndex(end => end < f0);
		if (row < 0) row = Math.min(rowEnds.length, MAX_ROWS - 1);
		rowEnds[row] = Math.max(rowEnds[row] ?? -1, f1);
		return {
			key: `${b.src}:${index}`, beat: b.beat, label: beatLabel(b.beat), src: b.src, f0, f1, row,
			issues: inGroups.length, groups: inGroups, goals: inGoals, missed,
			state: missed ? "goal" : inGroups.length ? "issue" : "clean", events: b.events ?? [],
		};
	});
	const rows = Math.max(1, rowEnds.length);
	for (const block of blocks) block.rows = rows;
	const spans = groups.map(g => ({ f0: g.first ?? 0, f1: g.last ?? g.first ?? 0, text: `${g.kind} ${g.subject}` })).sort((a, b) => a.f0 - b.f0);
	const marks = goals.map(g => ({ f: g.at, ok: !!g.ok, text: goalText(g) })).sort((a, b) => a.f - b.f);
	return { mode, n: draft.n, total: draft.qa?.total ?? 0, ok: !!draft.qa?.ok, qa: draft.qa ?? null, blocks, spans, marks };
}

/** One goal as a line: "✓ name 1.2 cm (≤ 2 cm)"; a distance in metres reads in cm. */
export function goalText(g) {
	const cm = v => `${Math.round(v * 1000) / 10} cm`;
	const upper = g.kind === "near" || g.kind === "still"; // a distance bound from above; the others are minimums
	const value = Number.isFinite(g.value) ? (upper ? cm(g.value) : `${Math.round(g.value * 1000) / 1000}`) : "";
	const need = Number.isFinite(g.need) ? (upper ? ` (≤ ${cm(g.need)})` : ` (≥ ${g.need})`) : "";
	return `${g.ok ? "✓" : "✗"} ${g.name}${value ? ` ${value}${need}` : ""}`;
}

/** The tooltip of a block: its name and frames, then each issue and goal on its own line. */
export function blockTitle(block) {
	const head = `${block.label} · ${ko("frames", "프레임")} ${block.f0}–${block.f1}`;
	const issues = block.groups.map(g => `⚠ ${g.kind} ${g.subject} (${ko("frames", "프레임")} ${g.first}–${g.last})`);
	const events = block.events.map(e => `${e.event} ${e.object} f${e.f}`);
	return [head, ...issues, ...block.goals.map(goalText), ...events].join("\n");
}
