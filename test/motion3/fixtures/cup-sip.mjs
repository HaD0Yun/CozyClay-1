// A cup sipped from the bench S8 table (test/fixtures/bench/S8.cozyclay.json), as an agent's first compile wrote it:
// the right hand grips the cup, the keys take it to the mouth tipped toward the face and back. `lean` puts that lean
// on the two mouth keys (undefined: as written, no lean).
export const cupSip = lean => ({
	schema: "cozyclay.motion-spec.v1", fps: 24, frames: 156, label: "pick up cup, sip, put down",
	use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0.72], heading: 0 } },
		{ skill: "reachGrip", f0: 12, args: { anchor: "cup", side: "r", reach: 20, hold: 94, release: 14, define: { kind: "object", object: "cup", local: [0, 0.05, 0] } } }],
	objects: { cup: { prop: "cupGrip", grab: 32, release: 126, keys: [
		{ f: 32, pos: [-0.15, 0.76, 1.22], aim: [0, 1, 0] }, { f: 50, pos: [-0.12, 1, 1.05], aim: [0, 1, 0] },
		{ f: 66, pos: [-0.04, 1.42, 0.9], aim: [0, 0.8, -0.6], ...(lean === undefined ? {} : { lean }) },
		{ f: 90, pos: [-0.04, 1.42, 0.9], aim: [0, 0.8, -0.6], ...(lean === undefined ? {} : { lean }) },
		{ f: 106, pos: [-0.12, 1, 1.05], aim: [0, 1, 0] }, { f: 124, pos: [-0.15, 0.76, 1.22], aim: [0, 1, 0] }, { f: 126, pos: [-0.15, 0.76, 1.22], aim: [0, 1, 0] }] } },
	goals: [{ name: "cup at mouth", near: ["object:cup.top", "landmark:mouth"], tol: 0.07, at: [70, 88] }],
});
