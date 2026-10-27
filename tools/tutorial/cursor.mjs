// Visible input for the tutorial recorder. CDP frames carry no OS cursor, so
// the page gets a DOM pointer (pointer-events: none) that glides to each
// target before the real Input.dispatch* event lands there, a ripple on every
// press, and a keycap badge for each shortcut.

const OVERLAY = `(() => {
	if (window.__tutorialCursor) return;
	const root = document.createElement("div");
	root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
	const pointer = document.createElement("div");
	pointer.style.cssText = "position:absolute;left:0;top:0;width:28px;height:28px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))";
	pointer.innerHTML = '<svg viewBox="0 0 28 28" width="28" height="28"><path d="M3 2 L3 22 L8.5 17 L12.5 25.5 L16 24 L12 15.8 L19.5 15.5 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
	const keycap = document.createElement("div");
	keycap.style.cssText = "position:absolute;left:50%;bottom:72px;transform:translateX(-50%);padding:10px 18px;border-radius:10px;background:rgba(20,20,24,.86);color:#fff;font:600 22px/1 system-ui,sans-serif;letter-spacing:.04em;opacity:0;transition:opacity .18s";
	root.append(pointer, keycap);
	document.documentElement.append(root);
	let x = innerWidth / 2, y = innerHeight / 2, keycapTimer = 0;
	const place = () => { pointer.style.transform = "translate(" + (x - 3) + "px," + (y - 2) + "px)"; };
	place();
	window.__tutorialCursor = {
		moveTo(toX, toY, ms) {
			const fromX = x, fromY = y, started = performance.now();
			return new Promise((resolve) => {
				const frame = (now) => {
					const t = Math.min(1, (now - started) / Math.max(1, ms));
					const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
					x = fromX + (toX - fromX) * eased; y = fromY + (toY - fromY) * eased; place();
					if (t < 1) requestAnimationFrame(frame); else resolve();
				};
				requestAnimationFrame(frame);
			});
		},
		jump(toX, toY) { x = toX; y = toY; place(); },
		ripple() {
			const ring = document.createElement("div");
			ring.style.cssText = "position:absolute;left:" + (x - 18) + "px;top:" + (y - 18) + "px;width:36px;height:36px;border-radius:50%;border:3px solid rgba(37,99,235,.9);background:rgba(37,99,235,.18)";
			root.insertBefore(ring, pointer);
			ring.animate([{ transform: "scale(.35)", opacity: 1 }, { transform: "scale(1.5)", opacity: 0 }], { duration: 520, easing: "ease-out" }).finished.then(() => ring.remove());
		},
		keycap(label) {
			keycap.textContent = label; keycap.style.opacity = "1";
			clearTimeout(keycapTimer); keycapTimer = setTimeout(() => { keycap.style.opacity = "0"; }, 1400);
		},
	};
})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const NAMED_KEYS = { Space: [" ", "Space", 32], Enter: ["Enter", "Enter", 13], Escape: ["Escape", "Escape", 27], Tab: ["Tab", "Tab", 9], Backspace: ["Backspace", "Backspace", 8], ArrowLeft: ["ArrowLeft", "ArrowLeft", 37], ArrowUp: ["ArrowUp", "ArrowUp", 38], ArrowRight: ["ArrowRight", "ArrowRight", 39], ArrowDown: ["ArrowDown", "ArrowDown", 40] };
const MAC_GLYPHS = { Meta: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" };

/** Input helpers on one CDP page; `mac` picks Cmd for "Mod" and the keycap glyphs. */
export function createInput(cdp, { mac }) {
	let at = null;
	const mouse = (type, x, y, extra = {}) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
	const glide = async (x, y) => {
		const distance = at ? Math.hypot(x - at.x, y - at.y) : 600;
		const ms = Math.round(Math.min(1100, Math.max(350, distance * 1.1)));
		await cdp.evaluate(`window.__tutorialCursor.moveTo(${x}, ${y}, ${ms})`);
		await mouse("mouseMoved", x, y, { button: "none" });
		at = { x, y };
	};
	/** Center of the first visible match, scrolled into view; null when it never shows. */
	const locate = async (selector, timeoutMs = 10000) => {
		const query = JSON.stringify(selector);
		if (!(await cdp.waitFor(`(() => { const node = document.querySelector(${query}); if (!node) return false; const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0; })()`, timeoutMs))) return null;
		return cdp.evaluate(`(() => { const node = document.querySelector(${query}); node.scrollIntoView({ block: "nearest", inline: "nearest" }); const box = node.getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()`);
	};
	const need = async (selector) => {
		const point = await locate(selector);
		if (!point) throw new Error(`no visible element for ${selector}`);
		return point;
	};
	/** A drag start: a selector, or { js } evaluating to a viewport point such as a gizmo handle. */
	const pointOf = async (source) => {
		if (typeof source === "string") return need(source);
		const point = await cdp.evaluate(`(async () => (${source.js}))()`);
		if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw new Error(`${source.js} gave no { x, y }`);
		return { x: Math.round(point.x), y: Math.round(point.y) };
	};
	const press = async (point) => {
		await glide(point.x, point.y);
		await sleep(180);
		await cdp.evaluate("window.__tutorialCursor.ripple()");
		await mouse("mousePressed", point.x, point.y, { clickCount: 1, buttons: 1 });
		await mouse("mouseReleased", point.x, point.y, { clickCount: 1 });
		await sleep(250);
	};
	return {
		install: () => cdp.evaluate(OVERLAY),
		locate,
		click: async (selector) => press(await need(selector)),
		async drag(from, to) {
			const start = await pointOf(from);
			const end = typeof to === "string" ? await need(to) : { x: start.x + to.dx, y: start.y + to.dy };
			await glide(start.x, start.y);
			await cdp.evaluate("window.__tutorialCursor.ripple()");
			await mouse("mousePressed", start.x, start.y, { clickCount: 1, buttons: 1 });
			const steps = 45;
			for (let index = 1; index <= steps; index += 1) {
				const t = index / steps;
				const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
				const x = Math.round(start.x + (end.x - start.x) * eased);
				const y = Math.round(start.y + (end.y - start.y) * eased);
				await cdp.evaluate(`window.__tutorialCursor.jump(${x}, ${y})`);
				await mouse("mouseMoved", x, y, { buttons: 1 });
				await sleep(25);
			}
			await mouse("mouseReleased", end.x, end.y, { clickCount: 1 });
			at = end;
		},
		async type(value) {
			const { into, text } = typeof value === "string" ? { text: value } : value;
			if (into) {
				await press(await need(into));
				await cdp.evaluate(`document.querySelector(${JSON.stringify(into)})?.select?.()`);
			}
			for (const character of text) {
				await cdp.send("Input.insertText", { text: character });
				await sleep(70);
			}
			// A React-controlled input can drop inserted text; the native setter plus an input event cannot be missed.
			if (into) await cdp.evaluate(`(() => {
				const input = document.querySelector(${JSON.stringify(into)});
				if (!input || input.value === ${JSON.stringify(text)}) return;
				Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value").set.call(input, ${JSON.stringify(text)});
				input.dispatchEvent(new Event("input", { bubbles: true }));
			})()`);
		},
		async key(chord) {
			const parts = chord.split("+").map((part) => (part === "Mod" ? (mac ? "Meta" : "Control") : part === "Ctrl" ? "Control" : part === "Cmd" ? "Meta" : part));
			const name = parts.pop();
			const modifiers = parts.reduce((bits, part) => bits | (MODIFIER_BITS[part] ?? 0), 0);
			const [key, code, keyCode] = NAMED_KEYS[name] ?? [name.toLowerCase(), `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)];
			const label = mac ? parts.map((part) => MAC_GLYPHS[part]).join("") + name : [...parts.map((part) => (part === "Control" ? "Ctrl" : part)), name].join("+");
			// A focused button swallows Space and Cmd/Ctrl+B (src/motion/timeline.jsx), so the chord goes to the page.
			await cdp.evaluate(`window.__tutorialCursor.keycap(${JSON.stringify(label)}); if (document.activeElement?.tagName === "BUTTON") document.activeElement.blur();`);
			await sleep(350);
			const event = { key, code, windowsVirtualKeyCode: keyCode, modifiers };
			await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...event, ...(key.length === 1 && !(modifiers & 6) ? { text: key } : {}) });
			await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
		},
	};
}
