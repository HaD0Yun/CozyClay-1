import { ko } from "./locale.js";

// Which bodies a new project is cast with (castStyle in project.js). The rig
// is the detailed humanoid, the capsule the quick stand-in; hybrid mixes both
// and is the default. Either body stays reachable from Add in every style.
export const CAST_OPTIONS = [
	{
		id: "rig",
		label: () => ko("Humanoid", "휴머노이드"),
		blurb: () => ko("Detailed previs with X/Y Bot: pose, IK and motion.", "X/Y Bot으로 디테일한 프리비즈: 포즈, IK, 모션."),
	},
	{
		id: "capsule",
		label: () => ko("Capsule", "캡슐"),
		blurb: () => ko("Simple previs with capsule figures: path and posture.", "캡슐 인물로 간단한 프리비즈: 경로와 자세."),
	},
	{
		id: "hybrid",
		label: () => ko("Hybrid", "하이브리드"),
		blurb: () => ko("Mix both; the agent may use capsules for hard shots.", "둘을 섞어 씁니다. 어려운 샷은 에이전트가 캡슐을 쓸 수 있어요."),
	},
];

// One segmented single-choice control on the New view. Each option carries
// `data-<dataKey>` with its id so tests and styles can address it.
export function StartChoiceGroup({ label, testId, dataKey, options, value, onChange, className = "" }) {
	return (
		<div className={`v2-start-mode${className ? ` ${className}` : ""}`} role="radiogroup" aria-label={label} data-testid={testId}>
			{options.map((option) => (
				<button
					type="button"
					key={option.id}
					role="radio"
					aria-checked={value === option.id}
					className={`v2-start-mode-option${value === option.id ? " active" : ""}`}
					{...{ [`data-${dataKey}`]: option.id }}
					onClick={() => onChange(option.id)}
				>
					<strong>{option.label()}</strong>
					<span>{option.blurb()}</span>
				</button>
			))}
		</div>
	);
}
