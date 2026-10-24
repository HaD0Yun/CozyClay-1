import { ko } from "../locale.js";

export default function SubjectBox({ label, onRemove, onPose, posing, color, onColorChange, onColorEditStart }) {
	return (
		<div className="subject-box v2-subject-box">
			<div className="subject-box-head">
				<span className="sb-name">{label}</span>
				<div className="sb-actions">
					{onColorChange && (
						<input
							type="color"
							className="sb-color"
							title={ko("Character color", "인물 색상")}
							aria-label={ko("Character color", "인물 색상")}
							value={color}
							/* Focus opens the session for keyboard/eyedropper use; the
							   native swatch dialog can drive onChange without focus, so the
							   first change of a session opens it too (the handler is
							   session-idempotent). */
							onFocus={onColorEditStart}
							onChange={(e) => {
								onColorEditStart?.();
								onColorChange(e.target.value);
							}}
						/>
					)}
					{onPose && (
						<button
							type="button"
							className={"cam-toggle" + (posing ? " active" : "")}
							aria-label={ko(`Open pose studio for ${label}`, `${label} 포즈 열기`, `打开 ${label} 的姿势工作室`)}
							title={ko(`Pose ${label}`, `${label} 포즈`, `${label} 姿势`)}
							onClick={onPose}
						>
							{/* The Pose mode figure, not a keyboard glyph. */}
							<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
								<path d="M8 2.25a1.5 1.5 0 1 1 0 3 1.5 1.5 0 1 1 0-3z M5 7.25h6 M8 7.25v3.5 M6.25 13.75 8 10.75l1.75 3" />
							</svg>
						</button>
					)}
					{onRemove && (
						<button type="button" className="sb-remove" title={ko("Remove subject", "인물 제거")} onClick={onRemove}>
							✕
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
