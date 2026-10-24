// A turn's step checklist in the agent panel (agent-plan.js keeps it): a header that says how far the plan is ("2/5")
// beside a thin progress bar, and one row per step: done steps checked, the step under way highlighted with a soft
// pulse, the rest waiting. While the turn runs the card stays pinned to the top of the transcript, so what is happening
// and what comes next stay in view however long the step list below grows. Once the turn ends nothing pulses, and a
// step a failed or stopped turn left unfinished reads muted.
import { FiCheck, FiMinus } from "react-icons/fi";
import { ko } from "../locale.js";
import "./agent-plan.css";

const STATUS_WORDS = {
	done: ko("done", "완료"),
	active: ko("in progress", "진행 중"),
	pending: ko("next", "대기"),
	unfinished: ko("not finished", "미완료"),
};

function PlanMark({ status }) {
	if (status === "done") return <FiCheck className="agent-plan-mark done" size={11} aria-hidden="true" />;
	if (status === "unfinished") return <FiMinus className="agent-plan-mark unfinished" size={11} aria-hidden="true" />;
	return <span className={`agent-plan-mark ${status}`} aria-hidden="true" />;
}

export function PlanCard({ plan, live }) {
	const total = plan.steps.length, done = plan.steps.filter(step => step.status === "done").length;
	const state = live ? "live" : plan.outcome ?? "done";
	return <div className="agent-row agent-plan-row" data-plan-live={live ? "true" : "false"}>
		<section className="agent-card agent-plan" data-agent-card="plan" data-plan-state={state} aria-label={ko(`Plan, ${done} of ${total} done`, `계획, ${total}단계 중 ${done}단계 완료`)}>
			<div className="agent-plan-head">
				<span className="agent-plan-title">{ko("Plan", "계획")}</span>
				<span className="agent-plan-bar" aria-hidden="true"><span className="agent-plan-fill" style={{ "--agent-plan-done": total ? done / total : 0 }} /></span>
				<span className="agent-plan-count">{done}/{total}</span>
			</div>
			<ol className="agent-plan-steps">
				{plan.steps.map((step, index) => <li key={index} className={`agent-plan-step ${step.status}`} data-plan-status={step.status} aria-current={step.status === "active" ? "step" : undefined} aria-label={`${step.text}: ${STATUS_WORDS[step.status] ?? step.status}`}>
					<PlanMark status={step.status} />
					<span className="agent-plan-text">{step.text}</span>
				</li>)}
			</ol>
		</section>
	</div>;
}
