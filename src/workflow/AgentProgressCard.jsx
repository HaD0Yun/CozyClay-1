// The live progress card in the agent panel (agent-progress.js). While the agent works on motion it shows what
// the agent actually produced so far: how many drafts it compiled and their QA trend, the latest draft's goals
// (met or not, value against need) and heaviest issues, whether that draft is installed, and the images the
// agent asked to see (click to enlarge, over the whole window). Nothing here is invented progress. A new turn
// starts it over.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { FiCheck, FiX } from "react-icons/fi";
import { clearProgress, draftsOf, latestDraft, progressSheets, progressVersion, subscribeProgress } from "../agent-progress.js";
import { ko } from "../locale.js";
import { draftLabel } from "../draft-ghost.js";
import { qaProblems } from "../qa-label.js";
import { goalRows, issueRows, trendPoints, turnCount } from "./agent-progress-view.js";
import "./agent-progress-card.css";

const W = 220, H = 40;

function Trend({ totals }) {
	const { points, first, last } = trendPoints(totals, { width: W, height: H });
	if (!points.length) return null;
	const [lx, ly] = points[points.length - 1];
	const label = ko(`Problems by draft: ${totals.join(", ")}`, `초안별 문제 수: ${totals.join(", ")}`, `各草稿的问题数：${totals.join(", ")}`);
	return <div className="agent-progress-trend">
		<svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="none">
			<line className="base" x1={4} y1={H - 4} x2={W - 4} y2={H - 4} />
			{points.length > 1 && <polyline className="line" points={points.map(p => p.join(",")).join(" ")} />}
			{points.slice(0, -1).map(([x, y], i) => <circle key={i} className="dot" cx={x} cy={y} r={1.8} />)}
			<circle className={`end ${last === 0 ? "ok" : "issue"}`} cx={lx} cy={ly} r={3.4} />
		</svg>
		<span className="agent-progress-trend-text">{totals.length > 1 ? `${first} → ${last}` : `${last}`}</span>
	</div>;
}

// The panel's own lightbox stays inside the panel; a contact sheet needs the window.
function SheetViewer({ sheet, onClose }) {
	useEffect(() => {
		const onKey = event => { if (event.key === "Escape") onClose(); };
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return createPortal(<button type="button" className="agent-progress-viewer" aria-label={ko("Close image", "이미지 닫기")} onClick={onClose}>
		<img src={sheet.dataUrl} alt={sheet.caption || ko("Image the agent checked", "에이전트가 확인한 이미지")} />
		{sheet.caption && <span className="agent-progress-viewer-caption">{sheet.caption}</span>}
	</button>, document.body);
}

/** `since`: when the latest turn started (null: no turn yet). Drafts and images from before it are not this turn's
 * work, such as a take compiled at startup. `live`: that turn is still running. */
export function AgentProgressCard({ items, since = null, live = false }) {
	useSyncExternalStore(subscribeProgress, progressVersion);
	const [open, setOpen] = useState(null);
	// The goal and issue lists fold to one line each: the panel is short and the live steps sit below the card.
	const [shown, setShown] = useState({});
	const toggle = key => setShown(now => ({ ...now, [key]: !now[key] }));
	// a new turn (not a steer of the running one) starts the card over
	const turns = turnCount(items), seen = useRef(turns);
	useEffect(() => {
		if (turns > seen.current) clearProgress();
		seen.current = turns;
	}, [turns]);
	const ours = record => since !== null && record.at >= since;
	const newest = latestDraft(), latest = newest && ours(newest) ? newest : null, sheets = progressSheets().filter(ours);
	const viewing = open && sheets.find(sheet => sheet.seq === open);
	if (!latest && !sheets.length) return null;
	const drafts = latest ? draftsOf(latest.characterId).filter(ours) : [];
	const goals = goalRows(latest?.qa.goals), issues = latest && !latest.qa.ok ? issueRows(latest.qa.groups) : [];
	return <div className="agent-row">
		<div className="agent-card agent-progress-card" data-agent-card="progress" data-drafts={drafts.length} data-installed={latest?.installed ? "true" : "false"} role="status" aria-live="polite">
			{latest && <div className="agent-progress-head">
				<span className="agent-progress-title" title={ko(`${latest.qa.total} frame-level issues`, `프레임 단위 문제 ${latest.qa.total}건`, `${latest.qa.total} 个帧级问题`)}>{draftLabel(latest)}</span>
				<span className={`agent-progress-chip ${latest.installed ? "installed" : "draft"}`}>{latest.installed ? ko("Installed", "설치됨") : live ? ko("Not installed yet", "아직 설치 전") : ko("Not installed", "설치 안 됨")}</span>
			</div>}
			{latest?.label && <p className="agent-progress-label">{latest.label}</p>}
			{drafts.length > 0 && <section className="agent-progress-section">
				<h4>{ko(`Problems across ${drafts.length} draft${drafts.length === 1 ? "" : "s"}`, `초안 ${drafts.length}개의 문제 수`, `${drafts.length} 个草稿的问题`)}</h4>
				<Trend totals={drafts.map(d => qaProblems(d.qa))} />
			</section>}
			{goals.length > 0 && <section className="agent-progress-section">
				<button type="button" className="agent-progress-fold" aria-expanded={!!shown.goals} onClick={() => toggle("goals")}>
					<h4>{ko("Goals", "목표")}</h4><span>{ko(`${goals.filter(g => g.ok).length} of ${goals.length} met`, `${goals.length}개 중 ${goals.filter(g => g.ok).length}개 충족`, `${goals.length} 个目标中已达成 ${goals.filter(g => g.ok).length} 个`)}</span>
				</button>
				{shown.goals && <ul className="agent-progress-goals">
					{goals.map((g, i) => <li key={i} data-goal-ok={g.ok ? "true" : "false"}>
						<span className={`agent-progress-mark ${g.ok ? "ok" : "miss"}`} aria-label={g.ok ? ko("met", "충족") : ko("missed", "미충족")}>{g.ok ? <FiCheck size={11} /> : <FiX size={11} />}</span>
						<span className="agent-progress-goal-name">{g.name}</span>
						<span className="agent-progress-goal-value">{g.value}{g.need && <span className="need"> / {g.need}</span>}</span>
					</li>)}
				</ul>}
			</section>}
			{issues.length > 0 && <section className="agent-progress-section">
				<button type="button" className="agent-progress-fold" aria-expanded={!!shown.issues} onClick={() => toggle("issues")}>
					<h4>{ko("Largest issues", "가장 큰 문제")}</h4><span>{issues[0].kind} {issues[0].subject}</span>
				</button>
				{shown.issues && <ul className="agent-progress-issues">
					{issues.map((row, i) => <li key={i}><span className="kind">{row.kind}</span> {row.subject} <span className="meta">×{row.count}{row.frames && ` · ${row.frames}`}</span></li>)}
				</ul>}
			</section>}
			{sheets.length > 0 && <section className="agent-progress-section">
				<h4>{ko("What the agent looked at", "에이전트가 본 화면")}</h4>
				<div className="agent-progress-sheets">
					{sheets.map(sheet => <button type="button" key={sheet.seq} className="agent-progress-sheet" title={sheet.caption} onClick={() => setOpen(sheet.seq)}>
						<img src={sheet.dataUrl} alt={sheet.caption || ko("Image the agent checked", "에이전트가 확인한 이미지")} />
					</button>)}
				</div>
			</section>}
		</div>
		{viewing && <SheetViewer sheet={viewing} onClose={() => setOpen(null)} />}
	</div>;
}
