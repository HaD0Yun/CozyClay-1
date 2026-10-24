import { useEffect, useState } from "react";

// Closed choices only (analytics USE_CASE_VALUES / TEAM_VALUES): no free text
// ever leaves the browser from this card.
const USE_CASES = Object.freeze([
	["animation", "Animation", "애니메이션", "动画"],
	["film", "Film / drama", "영화·드라마", "影视剧"],
	["game", "Game", "게임", "游戏"],
	["ad_mv", "Ad / music video", "광고·뮤비", "广告 / MV"],
	["personal", "Personal project", "개인 작업", "个人项目"],
	["other", "Something else", "기타", "其他"],
]);
const TEAMS = Object.freeze([
	["team", "With a team or company", "팀·회사에서", "与团队或公司"],
	["solo", "On my own", "혼자", "我自己"],
]);

/**
 * One optional question after the first successful export (#466). Two taps:
 * what the export is for, then team or solo. Closing it at any point counts as
 * a skip, and the card never comes back on this browser profile.
 */
export default function UseCaseQuestion({ open, isKo, isZh, onAnswer }) {
	const [useCase, setUseCase] = useState(null);
	const label = (en, korean, chinese) => (isKo ? korean : isZh ? chinese : en);
	useEffect(() => {
		if (!open) setUseCase(null);
	}, [open]);
	if (!open) return null;
	const close = () => onAnswer(useCase ?? "skip", "skip");
	return (
		<section
			className="use-case-ask"
			role="dialog"
			aria-modal="false"
			aria-labelledby="use-case-ask-title"
			onKeyDown={(event) => {
				if (event.key === "Escape") close();
			}}
		>
			<div className="use-case-ask-head">
				<strong id="use-case-ask-title">{label("Quick question (optional)", "짧은 질문 (선택)", "快速提问（可选）")}</strong>
				<button type="button" className="use-case-ask-close" aria-label={label("Close", "닫기", "关闭")} onClick={close}>
					×
				</button>
			</div>
			<p className="use-case-ask-prompt">
				{useCase
					? label("Who are you making it with?", "누구와 작업하나요?", "你和谁一起做？")
					: label("What are you making with CozyClay?", "CozyClay로 뭘 만들고 있나요?", "你在用 CozyClay 做什么？")}
			</p>
			<div className="use-case-ask-choices" role="group" aria-label={useCase ? label("Team or solo", "팀 또는 혼자", "团队或个人") : label("Use case", "용도", "用途")}>
				{(useCase ? TEAMS : USE_CASES).map(([value, en, ko, zh]) => (
					<button
						key={value}
						type="button"
						onClick={() => (useCase ? onAnswer(useCase, value) : setUseCase(value))}
					>
						{label(en, ko, zh)}
					</button>
				))}
			</div>
			<p className="use-case-ask-note">{label("Anonymous. Only the choice is sent.", "익명이에요. 고른 항목만 전송돼요.", "匿名。只发送所选项目。")}</p>
		</section>
	);
}
