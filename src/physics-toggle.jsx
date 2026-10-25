// The motion controls' Physics box: the whole physics overlay on or off, through motion.physicsOverlay (the agent's
// door to the same setting, physics-overlay-settings.js).
import { ko } from "./locale.js";
import { useStudioShell } from "./shell/studio-shell-context.js";
import { physicsOverlayOn, setPhysicsOverlay, usePhysicsOverlaySettings } from "./physics-overlay-settings.js";

export function PhysicsToggle() {
	const shell = useStudioShell();
	const on = physicsOverlayOn(usePhysicsOverlaySettings());
	const toggle = () => (shell?.runStudioAction ? shell.runStudioAction("motion.physicsOverlay", { all: !on }) : setPhysicsOverlay({ all: !on }));
	return (
		<label className={"tl-btn ik physics" + (on ? " on" : "")} data-testid="physics-overlay-toggle"
			title={ko("Physics — draw the centre of mass (green inside the feet, red past the balance limit, grey in the air), the support polygon, the gravity arc of each jump against the hips' path, and spring trails",
				"물리 — 무게중심(발 안이면 초록, 균형 한계 밖이면 빨강, 공중이면 회색), 지지 다각형, 점프마다 중력 포물선과 엉덩이 궤적, 스프링 궤적을 그립니다",
				"物理 — 绘制重心（脚内为绿色，超出平衡极限为红色，空中为灰色）、支撑多边形、每次跳跃的重力抛物线与髋部轨迹，以及弹簧轨迹")}>
			<input type="checkbox" checked={on} onChange={toggle} aria-label={ko("Physics overlay", "물리 오버레이", "物理叠加层")} />
			{ko("Physics", "물리", "物理")}
		</label>
	);
}
