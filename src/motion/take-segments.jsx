// The Full-Body strip of the Sequencer as timing segments of the installed take (take-edit.js):
// Cut at the playhead, drag a segment's amber grip to retime it (wider is slower), drag the
// outer green grips to trim, right-click a segment to drop it. Each gesture previews here and
// commits ONE timing command on release (commands/motion-timing.js), so each is one Undo.
import { useRef, useState } from "react";
import { ko } from "../locale.js";
import { frameFromClientX } from "./timeline-coordinates.js";
import { createTakeEdit, segmentSpeedForFrames, takeEditLayout, TRIM_MIN_FRAMES } from "../motion3/take-edit.js";

/** The motion prop the Sequencer draws: frames, label and timing segments of the active
 * character's take, with the timing commands bound to that character. */
export function timelineTake(motion, characterId, run) {
	if (!motion) return null;
	const act = (action, args = {}) => (characterId ? run?.(action, { characterId, ...args }) : null);
	return {
		frames: motion.frames, label: motion.prompt || ko("Compiled take", "컴파일된 테이크"),
		segments: takeEditLayout(motion.edit ?? createTakeEdit(motion.frames)),
		cut: frame => act("motion.cut", { frame }), speed: (segmentId, speed) => act("motion.setSegmentSpeed", { segmentId, speed }),
		remove: segmentId => act("motion.removeSegment", { segmentId }), trim: (start, end) => act("motion.trim", { start, end }), reset: () => act("motion.resetTiming"),
	};
}

const selectedSegment = (segments, frame) => segments.find(segment => frame >= segment.timelineStart && frame <= segment.timelineEnd) ?? segments[0] ?? null;

function trimRange(edge, frame, preview, max) {
	return edge === "start"
		? { ...preview, start: Math.max(0, Math.min(frame, preview.end - TRIM_MIN_FRAMES)) }
		: { ...preview, end: Math.min(max, Math.max(frame, preview.start + TRIM_MIN_FRAMES)) };
}

/** While a speed grip is held the dragged segment shows its would-be width and the segments
 * after it slide by the delta: the same reflow the commit produces. */
function shownSegments(segments, preview) {
	if (preview?.kind === "trim") return [{ id: "motion-trim-preview", timelineStart: preview.start, timelineEnd: preview.end, preview: true }];
	if (preview?.kind !== "speed") return segments;
	let shift = 0;
	return segments.map(segment => {
		if (segment.id !== preview.id) return shift ? { ...segment, timelineStart: segment.timelineStart + shift, timelineEnd: segment.timelineEnd + shift } : segment;
		const shown = { ...segment, timelineStart: segment.timelineStart + shift, timelineEnd: segment.timelineStart + shift + preview.timelineFrames - 1, previewSpeed: preview.speed };
		shift += preview.timelineFrames - segment.timelineFrames;
		return shown;
	});
}

export function TakeSegmentClips({ motion, frame, frameCount, displayFrameCount, clipPct, tools }) {
	const drag = useRef(null);
	const [preview, setPreview] = useState(null);
	const segments = motion.segments, selected = selectedSegment(segments, frame), max = motion.frames - 1;
	function begin(e, state) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const rect = e.currentTarget.closest(".tl-lane")?.getBoundingClientRect();
		if (!rect || rect.width < 2) return;
		e.currentTarget.setPointerCapture?.(e.pointerId);
		drag.current = { ...state, rect, displayFrameCount };
		setPreview(state.preview ?? null);
	}
	function move(e) {
		const active = drag.current;
		if (!active) return;
		if (active.preview?.kind === "trim") active.preview = trimRange(active.edge, Math.min(max, frameFromClientX(e.clientX, active.rect.left, active.rect.width, active.displayFrameCount, frameCount)), active.preview, max);
		else {
			// a slower segment outgrows the timeline: the grip keeps counting frames past the lane's end
			const at = ((e.clientX - active.rect.left) / Math.max(1, active.rect.width)) * Math.max(0, active.displayFrameCount - 1);
			const speed = segmentSpeedForFrames(active.segment, Math.max(1, Math.round(at) - active.segment.timelineStart + 1));
			const timelineFrames = Math.max(1, Math.round((active.segment.sourceEnd - active.segment.sourceStart + 1) / speed));
			if (active.preview?.speed === speed) return;
			active.preview = { kind: "speed", id: active.segment.id, speed, timelineFrames };
		}
		setPreview(active.preview);
	}
	function end(e) {
		const active = drag.current;
		drag.current = null;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		setPreview(null);
		const next = active?.preview;
		if (next?.kind === "trim" && (next.start > 0 || next.end < max)) motion.trim(next.start, next.end);
		if (next?.kind === "speed" && next.speed !== active.segment.speed) motion.speed(active.segment.id, next.speed);
	}
	const grip = (className, label, state, extra = {}) => (
		<button className={`tl-motion-clip-handle ${className}`} type="button" aria-label={label} title={extra.title}
			onPointerDown={e => begin(e, state)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
			onContextMenu={extra.reset ? e => { e.preventDefault(); e.stopPropagation(); motion.reset(); } : undefined} />
	);
	const trimState = edge => ({ edge, preview: { kind: "trim", start: 0, end: max } });
	const shown = shownSegments(segments, preview), single = segments.length === 1;
	return shown.map((segment, index) => {
		const speed = segment.previewSpeed ?? segment.speed, grips = tools && (segment.preview || selected?.id === segment.id);
		const label = segment.preview
			? `${segment.timelineStart}–${segment.timelineEnd} (${segment.timelineEnd - segment.timelineStart + 1}f)`
			: single ? `${motion.label}${speed !== 1 ? ` · ${speed}×` : ""}` : `${index + 1} · ${speed}×`;
		const trimReset = { title: ko("Drag to trim · right-click restores the full take", "드래그로 자르기 · 우클릭으로 전체 테이크 복원"), reset: true };
		return (
			<div
				key={segment.id}
				className={"tl-motion-clip" + (preview?.kind === "trim" ? " trimming" : "") + (segment.previewSpeed !== undefined ? " retiming" : "") + (!single && selected?.id === segment.id ? " selected" : "")}
				style={{ "--tl-f-start": clipPct(Math.min(segment.timelineStart, displayFrameCount)), "--tl-f-end": clipPct(Math.min(segment.timelineEnd + 1, displayFrameCount)) }}
				title={segment.preview ? undefined : ko(`Full-Body segment ${index + 1} — ${segment.speed}× · ${segment.timelineFrames} frames. Cut at the playhead; drag the amber grip to retime; right-click to delete`,
					`전신 구간 ${index + 1} — ${segment.speed}× · ${segment.timelineFrames}프레임. 재생 헤드에서 컷 · 주황 그립을 끌어 배속 조절 · 우클릭으로 구간 삭제`,
					`全身片段 ${index + 1} — ${segment.speed}× · ${segment.timelineFrames} 帧。在播放头处切分；拖动橙色把手调整速度；右键删除`)}
				onContextMenu={segment.preview || single ? undefined : e => { e.preventDefault(); e.stopPropagation(); motion.remove(segment.id); }}
			>
				{index === 0 && grips && grip("start", ko("Trim take start", "테이크 시작점 자르기"), trimState("start"), trimReset)}
				<span className="tl-motion-clip-label">{label}</span>
				{!segment.preview && grips && grip("speed", ko("Retime segment by stretch", "드래그로 구간 배속 조절"), { segment },
					{ title: ko("Drag — wider is slower, narrower is faster", "드래그 — 늘리면 느리게, 줄이면 빠르게") })}
				{index === shown.length - 1 && grips && grip("end", ko("Trim take end", "테이크 끝점 자르기"), trimState("end"), trimReset)}
			</div>
		);
	});
}

/** Sequencer head tools for the take: Cut at the playhead and the selected segment's speed. */
export function TakeSegmentTools({ motion, frame }) {
	const selected = selectedSegment(motion.segments, frame), index = motion.segments.indexOf(selected);
	const [draft, setDraft] = useState(null);
	const commit = value => {
		setDraft(null);
		if (selected && Number.isFinite(value) && value !== selected.speed) motion.speed(selected.id, Math.max(0.1, Math.min(4, value)));
	};
	const canCut = Boolean(selected) && frame > selected.timelineStart && frame <= selected.timelineEnd && frame < motion.frames;
	return (<>
		<button type="button" className="tl-seq-action cut" data-testid="sequencer-cut" disabled={!canCut}
			title={ko("Cut the Full-Body clip at the playhead", "재생 헤드에서 전신 클립 자르기")} onClick={() => motion.cut(frame)}>
			{ko("Cut", "컷")}
		</button>
		{selected && (
			<label className="tl-motion-speed-editor">
				<span>{ko(`Segment ${index + 1} speed`, `구간 ${index + 1} 배속`, `片段 ${index + 1} 速度`)}</span>
				<input type="range" min="0.1" max="4" step="0.1" value={draft ?? selected.speed} aria-label={ko("Selected Full-Body segment speed", "선택한 전신 구간 배속")}
					onChange={e => setDraft(e.currentTarget.valueAsNumber)} onPointerUp={e => commit(e.currentTarget.valueAsNumber)} onKeyUp={e => commit(e.currentTarget.valueAsNumber)} />
				<input type="number" min="0.1" max="4" step="0.1" value={selected.speed} aria-label={ko("Selected Full-Body segment speed value", "선택한 전신 구간 배속 값")}
					onChange={e => commit(e.currentTarget.valueAsNumber)} />
				<small>×</small>
			</label>
		)}
	</>);
}
