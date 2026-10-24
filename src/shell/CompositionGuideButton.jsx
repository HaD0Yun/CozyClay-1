import { GUIDE_LABELS, nextGuideMode } from "../shot-guides.js";
import { ko } from "../locale.js";

export default function CompositionGuideButton({ guideMode, onCycle }) {
	return (
		<button
			type="button"
			className={"vp-guide-cycle vp-embed-guide" + (guideMode === "off" ? "" : " on")}
			aria-label={ko("Cycle composition guides", "구도 가이드 전환")}
			aria-pressed={guideMode !== "off"}
			title={ko(GUIDE_LABELS[guideMode].en, GUIDE_LABELS[guideMode].ko, GUIDE_LABELS[guideMode].zh) + ko(" · click to cycle", " · 클릭으로 전환")}
			onClick={() => onCycle(nextGuideMode(guideMode))}
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
				<path d="M3 3h18v18H3z" />
				<path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
			</svg>
		</button>
	);
}
