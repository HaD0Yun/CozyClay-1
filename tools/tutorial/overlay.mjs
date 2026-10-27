// Teaching overlays for the tutorial recorder, injected into every page the
// episode visits: a spotlight (the page dimmed around a cut-out with an accent
// ring, a callout naming the feature beside it) and full-frame chapter cards.
// pointer-events: none throughout, so the real input still reaches the app.

/**
 * Where a callout box goes beside a target rect: right, left, below, above,
 * the first side where it fits; else the roomiest side, clamped into the
 * viewport. Self-contained, because it is also serialized into the page.
 */
export function calloutPlacement(target, box, viewport, gap = 16, margin = 12) {
	const fits = {
		right: target.x + target.width + gap + box.width <= viewport.width - margin,
		left: target.x - gap - box.width >= margin,
		below: target.y + target.height + gap + box.height <= viewport.height - margin,
		above: target.y - gap - box.height >= margin,
	};
	const room = { right: viewport.width - target.x - target.width, left: target.x, below: viewport.height - target.y - target.height, above: target.y };
	const sides = ["right", "left", "below", "above"];
	const side = sides.find((name) => fits[name]) ?? sides.reduce((best, name) => (room[name] > room[best] ? name : best));
	const middleX = target.x + target.width / 2 - box.width / 2;
	const middleY = target.y + target.height / 2 - box.height / 2;
	const x = side === "right" ? target.x + target.width + gap : side === "left" ? target.x - gap - box.width : middleX;
	const y = side === "below" ? target.y + target.height + gap : side === "above" ? target.y - gap - box.height : middleY;
	const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
	return { side, x: Math.round(clamp(x, margin, viewport.width - margin - box.width)), y: Math.round(clamp(y, margin, viewport.height - margin - box.height)) };
}

const FONT = `"Apple SD Gothic Neo","Noto Sans CJK KR","Noto Sans KR","Malgun Gothic",system-ui,sans-serif`;

export const TEACHING_OVERLAY = `(() => {
	if (window.__tutorialOverlay) return;
	const place = ${calloutPlacement.toString()};
	const PAD = 8;
	const css = document.createElement("style");
	css.textContent = \`
.tt-root{position:fixed;inset:0;pointer-events:none;z-index:2147483646;font-family:${FONT.replace(/"/g, "'")}}
.tt-hole{position:absolute;border-radius:10px;border:2px solid #3b82f6;box-shadow:0 0 0 4px rgba(59,130,246,.28),0 0 0 9999px rgba(8,10,14,.62);opacity:0;transition:left .35s ease,top .35s ease,width .35s ease,height .35s ease,opacity .3s ease}
.tt-callout{position:absolute;max-width:640px;padding:12px 16px;border-radius:10px;background:#fff;color:#111827;box-shadow:0 10px 30px rgba(0,0,0,.35);opacity:0;transition:opacity .3s ease}
.tt-callout b{display:block;font-size:19px;line-height:1.3;margin-bottom:3px}
.tt-callout span{display:block;font-size:15px;line-height:1.35;color:#374151;white-space:nowrap}
.tt-card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(10,12,18,.9);color:#fff;opacity:0;transition:opacity .35s ease;text-align:center}
.tt-card small{font-size:20px;letter-spacing:.08em;color:#93c5fd;font-weight:600}
.tt-card h1{margin:0;font-size:60px;line-height:1.2;font-weight:700;word-break:keep-all}
.tt-card p{margin:0;font-size:26px;color:#cbd5e1;word-break:keep-all}
.tt-card ol{margin:10px 0 0;padding:0;list-style:none;font-size:26px;line-height:1.7;color:#e5e7eb;text-align:left}
.tt-card ol li b{color:#93c5fd;margin-right:14px}
.tt-carded .tt-pointer-host{opacity:0}\`;
	const root = document.createElement("div");
	root.className = "tt-root";
	const hole = document.createElement("div");
	hole.className = "tt-hole";
	root.append(hole);
	let target = null, callout = null, card = null;
	const mount = () => { document.documentElement.append(css, root); };
	if (document.documentElement) mount(); else document.addEventListener("DOMContentLoaded", mount);
	const follow = () => {
		if (target && target.isConnected) {
			const box = target.getBoundingClientRect();
			const rect = { x: box.left - PAD, y: box.top - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 };
			Object.assign(hole.style, { left: rect.x + "px", top: rect.y + "px", width: rect.width + "px", height: rect.height + "px" });
			if (callout) {
				const spot = place(rect, { width: callout.offsetWidth, height: callout.offsetHeight }, { width: innerWidth, height: innerHeight });
				callout.style.left = spot.x + "px"; callout.style.top = spot.y + "px";
			}
		}
		requestAnimationFrame(follow);
	};
	requestAnimationFrame(follow);
	const fadeOut = (node) => { if (!node) return; node.style.opacity = "0"; setTimeout(() => node.remove(), 350); };
	const text = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };
	window.__tutorialOverlay = {
		spotlight(selector, label, note) {
			const node = document.querySelector(selector);
			if (!node) return false;
			node.scrollIntoView({ block: "nearest", inline: "nearest" });
			target = node;
			fadeOut(callout);
			callout = document.createElement("div");
			callout.className = "tt-callout";
			callout.append(text("b", label));
			if (note) callout.append(text("span", note));
			root.append(callout);
			requestAnimationFrame(() => { hole.style.opacity = "1"; callout.style.opacity = "1"; });
			return true;
		},
		clear() { hole.style.opacity = "0"; fadeOut(callout); callout = null; setTimeout(() => { if (!callout) target = null; }, 350); },
		card({ eyebrow, title, subtitle, items }) {
			fadeOut(card);
			card = document.createElement("div");
			card.className = "tt-card";
			if (eyebrow) card.append(text("small", eyebrow));
			card.append(text("h1", title));
			if (subtitle) card.append(text("p", subtitle));
			if (items?.length) {
				const list = document.createElement("ol");
				items.forEach((item, index) => { const row = document.createElement("li"); row.append(text("b", String(index + 1).padStart(2, "0")), item); list.append(row); });
				card.append(list);
			}
			root.append(card);
			document.documentElement.classList.add("tt-carded");
			requestAnimationFrame(() => { card.style.opacity = "1"; });
		},
		hideCard() { fadeOut(card); card = null; document.documentElement.classList.remove("tt-carded"); },
	};
})()`;
