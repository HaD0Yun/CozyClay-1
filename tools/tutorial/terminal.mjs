// The install scene: a local terminal page (scenes/terminal.html) types the
// command and prints the output lines, captured like any Studio frame.
import { pathToFileURL } from "node:url";

export const TERMINAL_URL = pathToFileURL(new URL("./scenes/terminal.html", import.meta.url).pathname).href;

/**
 * The timed events the terminal page plays: one `char` per typed character,
 * an `enter`, then one `line` per output line. Pure, so it is tested.
 */
export function terminalSequence({ typed, lines }, { startMs = 700, charMs = 85, enterMs = 450, firstLineMs = 600, lineMs = 320 } = {}) {
	const events = [];
	let at = startMs;
	for (const character of typed) {
		events.push({ at, kind: "char", text: character });
		at += charMs;
	}
	at += enterMs;
	events.push({ at, kind: "enter" });
	lines.forEach((line, index) => {
		at += index === 0 ? firstLineMs : lineMs;
		events.push({ at, kind: "line", text: line });
	});
	return { events, totalMs: at };
}

/** Show the terminal page (fresh) and play `scene`; resolves when the last line is out. */
export async function playTerminal(cdp, scene) {
	const loaded = cdp.once("Page.loadEventFired");
	await cdp.send("Page.navigate", { url: TERMINAL_URL });
	await loaded;
	const { events, totalMs } = terminalSequence(scene);
	await cdp.evaluate(`window.__terminal.play(${JSON.stringify(events)})`);
	await new Promise((resolve) => setTimeout(resolve, totalMs + 200));
}
