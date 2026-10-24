// The beat board: the agent's newest draft laid out on the Full-Body lane while it works (agent-progress.js), so the
// user sees what is being built and where QA still objects before anything is installed. Each beat of the draft's
// timeline is a block over its frames with its state (clean, issues n, goal missed), each issue a span along the
// row's bottom edge and each goal a mark at its frame; a header names the draft and its QA total until the draft is
// installed. Clicking a block moves the playhead to its first frame. An older take under a draft dims
// (beat-board.css). The model is beat-board-model.js.
import { useSyncExternalStore } from "react";
import { ko } from "../locale.js";
import { latestDraft, progressVersion, subscribeProgress } from "../agent-progress.js";
import { beatBoardModel, blockTitle } from "./beat-board-model.js";
import { draftLabel } from "../draft-ghost.js";
import "./beat-board.css";

function stateChip(block) {
	const issues = block.issues ? `⚠ ${block.issues}` : "";
	if (!block.missed) return issues || "✓";
	const missed = ko(`goal ✗${block.missed > 1 ? ` ${block.missed}` : ""}`, `목표 ✗${block.missed > 1 ? ` ${block.missed}` : ""}`, `目标 ✗${block.missed > 1 ? ` ${block.missed}` : ""}`);
	return issues ? `${missed} · ${issues}` : missed;
}

export function BeatBoard({ motion, frame, displayFrameCount, clipPct, onJump }) {
	useSyncExternalStore(subscribeProgress, progressVersion, progressVersion);
	const model = beatBoardModel(latestDraft(), motion);
	if (!model) return null;
	const last = Math.max(0, displayFrameCount - 1);
	const jump = f => e => {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		onJump?.(Math.min(f, last));
	};
	return (
		<div className={`tl-beat-board ${model.mode}`} data-testid="beat-board" data-mode={model.mode} data-draft={model.n} style={{ "--beat-rows": model.blocks[0]?.rows ?? 1 }}
			role="group" aria-label={ko("Agent draft beats", "에이전트 초안 동작 구간")}>
			{model.blocks.filter(b => b.f0 <= last).map(b => (
				<button key={b.key} type="button" className={`tl-beat ${b.state}${frame >= b.f0 && frame <= b.f1 ? " current" : ""}`}
					data-beat={b.beat} data-state={b.state} title={blockTitle(b)}
					aria-label={`${b.label} ${b.f0}–${b.f1}: ${stateChip(b)}`}
					style={{ "--tl-f-start": clipPct(b.f0), "--tl-f-end": clipPct(Math.min(b.f1 + 1, displayFrameCount)), "--beat-row": b.row, "--beat-rows": b.rows }}
					onPointerDown={jump(b.f0)}>
					<span className="tl-beat-label">{b.label}</span>
					<span className="tl-beat-state">{stateChip(b)}</span>
				</button>
			))}
			{model.spans.filter(s => s.f0 <= last).map((s, i) => (
				<span key={`span:${i}`} className="tl-beat-span" style={{ "--tl-f-start": clipPct(s.f0), "--tl-f-end": clipPct(Math.min(s.f1 + 1, displayFrameCount)) }}
					title={`${s.f0}–${s.f1} · ${s.text}`} />
			))}
			{model.marks.filter(m => m.f <= last).map((m, i) => (
				<span key={`mark:${i}`} className={`tl-beat-mark${m.ok ? " met" : ""}`} style={{ "--tl-f": clipPct(m.f) }} title={`f${m.f} · ${m.text}`} />
			))}
			{model.mode === "draft" && (
				<span className={"tl-beat-head" + (model.ok ? " ok" : "")} data-testid="beat-board-head"
					title={ko("The agent's newest draft, not installed yet", "에이전트가 만든 최신 초안 (아직 적용 전)")}>
					{draftLabel({ n: model.n, qa: model.qa })}
				</span>
			)}
		</div>
	);
}
