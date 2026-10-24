// A turn's step checklist as the agent panel keeps it (AgentPlanCard.jsx draws it): the sidecar's plan tool
// (bin/agent/plan-tool.mjs) sends the whole list in every plan.update frame, and the chat store (agent-client.js) keeps
// one plan card per turn, right under the turn's prompt. The card never claims more than happened: when the turn ends,
// the step still under way counts as done only if the turn succeeded, and is left unfinished when it failed or stopped.
// Pure data, like agent-turn.js.

const STATUSES = new Set(["pending", "active", "done"]);
const MAX_STEPS = 12, TEXT_MAX = 80;

/** A frame's steps as the card keeps them, or null when they are not a plan. */
function planSteps(steps) {
	if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) return null;
	const kept = steps.map(step => ({ text: String(step?.text ?? "").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX), status: step?.status }));
	return kept.every(step => step.text && STATUSES.has(step.status)) ? kept : null;
}

/** Whether a frame belongs to the plan: its update, or the plan tool's own call (the card shows it, never a step row). */
export const isPlanFrame = event => event?.type === "plan.update" || (event?.name === "plan" && ["tool.compose", "tool.start", "tool.progress"].includes(event?.type));

/** items after a plan frame: the turn's one plan card, under its prompt, takes the frame's list whole. */
export function withPlanFrame(items, event, newId) {
	const steps = event?.type === "plan.update" ? planSteps(event.steps) : null;
	if (!steps) return items;
	const prompt = items.findLastIndex(item => item.kind === "user" && !item.steered);
	const at = items.findIndex((item, i) => i > prompt && item.kind === "plan");
	if (at !== -1) return items.map((item, i) => i === at ? { ...item, steps } : item);
	return [...items.slice(0, prompt + 1), { kind: "plan", id: newId(), steps }, ...items.slice(prompt + 1)];
}

/** A plan whose turn ended ("done", "failed" or "stopped"): the step under way is done only when the turn succeeded. */
export function settledPlan(plan, status) {
	const outcome = status === "done" || status === "stopped" ? status : "failed";
	return { ...plan, outcome, steps: plan.steps.map(step => step.status === "active" ? { ...step, status: outcome === "done" ? "done" : "unfinished" } : step) };
}

/** items at the end of a turn: its plan card settles (settledPlan); earlier turns' cards already have. */
export const withPlanEnd = (items, status) => items.map(item => item.kind === "plan" && !item.outcome ? settledPlan(item, status) : item);

/**
 * A restored transcript's plans (session-store.mjs lists one per change): each turn keeps its last list, under its
 * prompt; the plan tool's own calls go; and the card settles by how the turn ended: failed when a failure follows, done
 * when the turn ends on the reply, else stopped (the history ends mid-turn: the panel reloaded while it ran).
 */
export function restoredPlans(items) {
	const turns = [];
	for (const item of items) {
		if (item.kind === "tool" && item.name === "plan") continue;
		if (item.kind === "user" || !turns.length) turns.push([]);
		turns.at(-1).push(item);
	}
	return turns.flatMap(turn => {
		const rest = turn.filter(item => item.kind !== "plan"), plan = turn.findLast(item => item.kind === "plan");
		const steps = plan ? planSteps(plan.steps) : null;
		if (!steps) return rest;
		const status = rest.some(item => item.kind === "failure") ? "failed" : rest.at(-1)?.kind === "assistant" ? "done" : "stopped";
		const prompt = rest[0]?.kind === "user" ? 1 : 0;
		return [...rest.slice(0, prompt), settledPlan({ ...plan, steps }, status), ...rest.slice(prompt)];
	});
}
