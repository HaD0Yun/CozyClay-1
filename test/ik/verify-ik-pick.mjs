import assert from "node:assert/strict";
import { pickIkHit } from "../../src/motion/ik-pick.js";

/* Which IK control a press grabs when several raycast hits overlap. The
 * hits arrive near to far, as three.js sorts them. */
const control = (id, part = null, exposed = true) => ({ mesh: { name: `${id}:${part}` }, track: { id }, part, exposed });
const handlesOf = (picks) => Object.fromEntries(picks.map((pick) => [pick.track.id, { userData: { ikExposed: pick.exposed } }]));
const press = (...picks) => pickIkHit(picks.map((pick, index) => ({ object: pick.mesh, distance: index })), picks, handlesOf(picks));

// Given a focused hand whose X arrow hit volume sits in front of its Z ring
// When the press lands where both overlap
// Then the drawn ring wins over the invisible forgiving volume.
{
	const arrowVolume = control("leftHand", "hit-tip");
	const ring = control("leftHand", "ring");
	assert.equal(press(arrowVolume, ring), ring);
	console.log("PASS a ring beats an arrow's invisible hit volume in front of it");
}

// Given a visible arrow tip in front of a ring
// Then the arrow keeps the press (both are drawn; the nearer wins).
{
	const tip = control("leftHand", "tip");
	assert.equal(press(tip, control("leftHand", "ring")), tip);
	console.log("PASS between drawn parts the nearer wins");
}

// Given a far-side shoulder hidden behind the chest, nearer to the camera ray
// Then the exposed chest takes the press.
{
	const chest = control("chest");
	assert.equal(press(control("rightShoulder", null, false), chest), chest);
	console.log("PASS an exposed control beats a hidden one under the pointer");
}

// Given only a hidden handle under the pointer
// Then it still answers: it is drawn, so a press on it is not lost.
{
	const knee = control("rightKnee", null, false);
	assert.equal(press(knee), knee);
	console.log("PASS a hidden handle answers when nothing exposed is under the pointer");
}

// Given no hits
{
	assert.equal(pickIkHit([], [], {}), null);
	console.log("PASS no hit picks nothing");
}
