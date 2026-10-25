// The physics overlay as three.js objects (motion3/physics-view.js and physics-trail.js give the numbers): the
// centre of mass as a 4 cm ball with a line down to the ground, the support polygon on the ground, per air run the
// hips path (white, dashed) against the gravity parabola (orange), and each spring object's tip trail. Lines are
// thin tubes of a fixed width in metres, so a capture or an export at any size draws them as the viewport does. Every
// node takes no ray and draws over the body (the centre of mass sits inside it). The body's marks are computed where
// the take was compiled and ride the character's placement; the trails are world space, as the object tracks are.
// The viewport (physics-overlay.jsx) and the export path (syncPhysicsOverlays, App's applyExportFrame) pose it for a
// frame the same way, so scrub, playback and export draw the same overlay.
import * as THREE from "three";
import { comAt, supportAt, airArcs } from "./motion3/physics-view.js";
import { tipTrails, TRAIL_FRAMES } from "./motion3/physics-trail.js";

const PHYSICS_COLORS = Object.freeze({ inside: "#2ee66b", outside: "#ff2d2d", air: "#9aa0a6", supported: "#9aa0a6", support: "#ffd84a", path: "#ffffff", fit: "#ff8a1f", trail: "#3cc8ff" });
const ORDER = 70, LINE = 0.006, DOT = 0.011, COM_RADIUS = 0.02, LIFT = 0.004;
const noRay = () => {};
const UP = new THREE.Vector3(0, 1, 0), a3 = new THREE.Vector3(), b3 = new THREE.Vector3(), d3 = new THREE.Vector3(), m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s3 = new THREE.Vector3();
const tube = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false), dot = new THREE.SphereGeometry(1, 12, 8);

function claim(node, layer) {
	node.traverse((n) => { n.layers.set(layer); n.raycast = noRay; n.castShadow = n.receiveShadow = false; n.renderOrder = ORDER; n.frustumCulled = false; });
	return node;
}
const material = (color) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false, fog: false });

/** A polyline drawn as tube segments (one instance each); dashed draws every other one. */
class Tubes {
	constructor(color, capacity, radius = LINE) {
		this.mesh = new THREE.InstancedMesh(tube, material(color), capacity);
		this.mesh.count = 0;
		this.radius = radius;
	}
	set(points, { closed = false, dashed = false } = {}) {
		const n = points.length, segments = closed && n > 2 ? n : n - 1;
		let count = 0;
		for (let i = 0; i < segments && count < this.mesh.instanceMatrix.count; i++) {
			if (dashed && i % 2) continue;
			a3.fromArray(points[i]); b3.fromArray(points[(i + 1) % n]);
			const length = d3.subVectors(b3, a3).length();
			if (length < 1e-6) continue;
			q4.setFromUnitVectors(UP, d3.divideScalar(length));
			m4.compose(a3.add(b3).multiplyScalar(0.5), q4, s3.set(this.radius, length, this.radius));
			this.mesh.setMatrixAt(count++, m4);
		}
		this.mesh.count = count;
		this.mesh.instanceMatrix.needsUpdate = true;
	}
	dispose() { this.mesh.material.dispose(); this.mesh.dispose(); }
}

/** A dot per point (a frame of an arc: their spacing is the speed; a still path is one dot). */
class Dots extends Tubes {
	constructor(color, capacity, radius = DOT) {
		super(color, capacity, radius);
		this.mesh.geometry = dot;
	}
	set(points) {
		points.forEach((p, i) => this.mesh.setMatrixAt(i, m4.makeScale(this.radius, this.radius, this.radius).setPosition(p[0], p[1], p[2])));
		this.mesh.count = points.length;
		this.mesh.instanceMatrix.needsUpdate = true;
	}
}

export class PhysicsOverlay {
	constructor({ layer }) {
		this.layer = layer;
		this.object = new THREE.Group();
		this.object.name = "physics-overlay";
		this.body = new THREE.Group();
		this.body.matrixAutoUpdate = false;
		this.world = new THREE.Group();
		this.object.add(this.body, this.world);
		this.ball = new THREE.Mesh(new THREE.SphereGeometry(COM_RADIUS, 20, 14), material(PHYSICS_COLORS.inside));
		this.drop = new Tubes(PHYSICS_COLORS.inside, 1, LINE * 0.6);
		this.drop.mesh.material.dispose();
		this.drop.mesh.material = this.ball.material;
		this.support = new Tubes(PHYSICS_COLORS.support, 64);
		this.arcs = new THREE.Group();
		this.body.add(this.ball, this.drop.mesh, this.support.mesh, this.arcs);
		this.trails = [];
		this.arcView = null;
		this.arcTubes = [];
		claim(this.object, layer);
		this.last = null;
	}

	/** Draw the air arcs of `view` (rebuilt only when the view changes). */
	setArcs(view) {
		if (this.arcView === view) return;
		this.arcView = view;
		for (const t of this.arcTubes) { this.arcs.remove(t.mesh); t.dispose(); }
		this.arcTubes = [];
		for (const arc of view ? airArcs(view) : []) {
			const path = new Tubes(PHYSICS_COLORS.path, arc.path.length), fit = new Tubes(PHYSICS_COLORS.fit, arc.fit.length);
			const pathDots = new Dots(PHYSICS_COLORS.path, arc.path.length, DOT * 0.8), fitDots = new Dots(PHYSICS_COLORS.fit, arc.fit.length);
			path.set(arc.path, { dashed: true });
			fit.set(arc.fit);
			pathDots.set(arc.path);
			fitDots.set(arc.fit);
			for (const t of [fit, fitDots, path, pathDots]) { this.arcs.add(claim(t.mesh, this.layer)); this.arcTubes.push(t); }
			// the path over the arc: where the hips stay put, the white dot shows inside the orange one
			path.mesh.renderOrder = pathDots.mesh.renderOrder = ORDER + 1;
		}
	}

	setTrails(trails) {
		while (this.trails.length < trails.length) {
			const t = new Tubes(PHYSICS_COLORS.trail, TRAIL_FRAMES, LINE * 0.75);
			this.world.add(claim(t.mesh, this.layer));
			this.trails.push(t);
		}
		this.trails.forEach((t, i) => { t.mesh.visible = !!trails[i]; if (trails[i]) t.set(trails[i].points); });
	}

	/**
	 * Pose the overlay for take frame `frame` of `view` (physics-view.js; null hides it) with parts `settings`
	 * ({ com, support, arc, trail }). placement: the matrix from where the take was compiled to where the character
	 * stands now. Answers what it drew (QA hooks read it).
	 */
	update({ view, frame, placement, settings }) {
		const on = !!view && (settings.com || settings.support || settings.arc || settings.trail);
		this.object.visible = on;
		if (!on) { this.last = null; return null; }
		if (placement) { this.body.matrix.copy(placement); this.body.matrixWorldNeedsUpdate = true; }
		const com = comAt(view, frame), poly = settings.support ? supportAt(view, frame) : [], trails = settings.trail ? tipTrails(view, frame) : [];
		this.ball.visible = this.drop.mesh.visible = settings.com;
		if (settings.com) {
			this.ball.material.color.set(PHYSICS_COLORS[com.state]);
			this.ball.position.fromArray(com.p);
			this.drop.set([com.p, [com.p[0], com.ground + LIFT, com.p[2]]]);
		}
		this.support.mesh.visible = poly.length > 0;
		this.support.set(poly.map(([x, y, z]) => [x, y + LIFT, z]), { closed: true });
		this.arcs.visible = settings.arc;
		this.setArcs(settings.arc ? view : null);
		this.setTrails(trails);
		this.last = { frame: com.frame, com, support: poly, arcs: settings.arc ? airArcs(view).map(({ a, b, float, worst }) => ({ a, b, float, worst })) : [], trails: trails.map(t => ({ id: t.id, points: t.points.length })) };
		return this.last;
	}

	dispose() {
		this.setArcs(null);
		for (const t of [this.drop, this.support, ...this.trails]) t.dispose();
		this.ball.geometry.dispose();
		this.trails = [];
	}
}

const live = new Set();
/** Register a viewport overlay's sync(frame) (physics-overlay.jsx); answers the unregister. */
export function addPhysicsOverlaySync(sync) { live.add(sync); return () => live.delete(sync); }
/** Pose every mounted overlay for timeline frame `frame` (the export path, before it renders), or the playhead with null. */
export function syncPhysicsOverlays(frame = null) { for (const sync of live) sync(frame); }
