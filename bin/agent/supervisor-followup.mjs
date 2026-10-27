// What the supervisor needs to judge a short answer such as "yes": the
// exchange it answers. A hybrid project's capsule substitution is approved in
// one turn ("Use capsule figures for this shot instead?") and carried out in
// the next ("yes"), so the review of the second turn reads the first.
import { transcriptFromHistory } from "./session-store.mjs";

const FOLLOW_UP_ANSWERS = new Set(["yes", "no", "y", "n", "ok", "sure", "응", "네", "예", "아니", "아니요", "좋아"]);
const EXCHANGE_CLIP = 2000;

/** True for a bare yes/no-style answer: trimmed, case-insensitive, trailing punctuation ignored. */
export function isFollowUpAnswer(text) {
	return FOLLOW_UP_ANSWERS.has(String(text ?? "").trim().toLowerCase().replace(/[\s.!?,~。！？]+$/u, ""));
}

const clip = text => text.length > EXCHANGE_CLIP ? `${text.slice(0, EXCHANGE_CLIP)}…` : text;

/**
 * The exchange a follow-up answers, `{ user, assistant }`, or null when the
 * request is not a follow-up or the session history holds none. `readHistory`
 * returns the persisted session history read after the turn: when its last
 * user message is the request itself, that turn is skipped.
 */
export function followUpExchange(request, readHistory) {
	if (!isFollowUpAnswer(request)) return null;
	let entries;
	try { entries = transcriptFromHistory(readHistory() ?? []).filter(entry => (entry.kind === "user" || entry.kind === "assistant") && typeof entry.text === "string" && entry.text.trim()); }
	catch { return null; }
	const lastUser = entries.findLastIndex(entry => entry.kind === "user");
	if (lastUser !== -1 && entries[lastUser].text.trim() === String(request).trim()) entries = entries.slice(0, lastUser);
	const assistant = entries.findLastIndex(entry => entry.kind === "assistant");
	if (assistant === -1) return null;
	const user = entries.slice(0, assistant).findLast(entry => entry.kind === "user");
	return { ...(user ? { user: clip(user.text) } : {}), assistant: clip(entries[assistant].text) };
}
