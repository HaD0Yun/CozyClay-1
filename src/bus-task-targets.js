// What a task's scope keys are in the editor's document stores, for the bus's tasks (bus-tasks.js): a snapshot of a
// key is its rows (an object's row; a character's cast row and motion layer; a shot's row) or, for stage and timeline,
// the whole slices; restoring puts every row back where it stood (or removes a row the task created) in one composed
// entry, so undo, history and saves see an ordinary edit. scene is not restorable: documents have no undo.
// A character layer (bus-task-scopes.js) is the fields of those two rows it owns: restoring it writes only them back
// into the row as it stands now, so cancelling the task that placed her keeps the take another task made meanwhile.
import { StudioProtocolError } from './studio-agent-protocol.js';
import { layerOf } from './bus-task-scopes.js';

const ROWS = { object: [['objects', null]], character: [['cast', 'characters'], ['motion', null]], shot: [['shot', 'shots']] };
const WHOLE = { stage: ['stage'], timeline: ['shot', 'motion'] };
const split = key => { const at = key.indexOf(':'); return at < 0 ? [key] : [key.slice(0, at), key.slice(at + 1)]; };
// The fields of the cast row (scenes.js createCharacterEntry) and the motion layer (emptyMotionLayer) each layer owns;
// placement is every other cast field, props no field of either (what she holds lives on the objects).
const LAYER_FIELDS = {
	cast: { take: ['layer', 'motionTake'], ik: ['ikEdits'], props: [] },
	motion: { placement: [], take: ['take', 'fullTake', 'takeRecipe', 'takeVersions'], ik: ['ikKeys', 'ikPins', 'ikPinResiduals', 'committedIkEdits'], props: [] },
};
const CAST_OWNED = new Set(['id', ...Object.values(LAYER_FIELDS.cast).flat()]);
const fieldsOf = (domain, layer, row) => LAYER_FIELDS[domain][layer] ?? Object.keys(row).filter(field => !CAST_OWNED.has(field));
// A character with no motion layer yet reads as the empty one (motion-intent-codec.js emptyMotionLayer).
const EMPTY = { motion: { take: null, fullTake: null, takeRecipe: null, takeVersions: [], ikKeys: [], ikPins: [], ikPinResiduals: [], committedIkEdits: [] } };
const pick = (row, fields) => Object.fromEntries(fields.map(field => [field, row[field]]));

function put(slice, part) {
	if ('whole' in part) return part.whole;
	const all = part.path ? slice[part.path] : slice, at = all.findIndex(row => row.id === part.id), rows = all.filter(row => row.id !== part.id);
	// A layer goes back into the row as it is now; a row removed since comes back whole; a layer never removes a row.
	if ('fields' in part && at >= 0) rows.splice(at, 0, { ...all[at], ...part.fields });
	else if (part.row) rows.splice(Math.min(part.index, rows.length), 0, part.row);
	else if ('fields' in part) return slice;
	return part.path ? { ...slice, [part.path]: rows } : rows;
}

/** snapshotTarget(key), restoreTargets([{ key, value }]) and readLayer(key) over the app's store domains (ports.storeDomain, ports.beginAction). */
export function taskTargetPorts(ports) {
	const store = domain => ports.storeDomain?.(domain)?.documentStore;
	const rowParts = (kind, id, read) => ROWS[kind].filter(([domain]) => store(domain)).map(([domain, path]) => {
		const slice = store(domain).read(domain), rows = (path ? slice?.[path] : slice) ?? [];
		const index = read ? rows.findIndex(row => row.id === id) : -1;
		return { domain, path, id, index, row: index < 0 ? undefined : rows[index] };
	});
	// A layer's parts: its fields of each row that has some, beside the whole row (to put back a row removed since).
	const layerParts = ({ id, layer }) => rowParts('character', id, true).flatMap(part => {
		const row = part.row ?? EMPTY[part.domain], fields = row ? fieldsOf(part.domain, layer, row) : [];
		return fields.length ? [{ ...part, fields: pick(row, fields) }] : [];
	});
	const snapshotTarget = key => {
		const [kind, id] = split(key), of = layerOf(key);
		if (of?.layer) return layerParts(of);
		if (WHOLE[kind]) return WHOLE[kind].filter(store).map(domain => ({ domain, whole: store(domain).read(domain) }));
		return ROWS[kind] ? rowParts(kind, id, true) : null;
	};
	return {
		snapshotTarget,
		/** A layer's token: its own fields only, so an edit of another layer of the same character leaves it as it was. */
		readLayer: key => JSON.stringify(snapshotTarget(key).map(part => part.fields)),
		restoreTargets(values) {
			const parts = values.flatMap(({ key, value }) => {
				if (value === null) throw new StudioProtocolError('CAPABILITY_MISSING', `${key} cannot be restored: a document change has no undo.`);
				const [kind, id] = split(key);
				return value ?? rowParts(kind, layerOf(key)?.id ?? id, false);
			});
			const domains = [...new Set(parts.map(part => part.domain))];
			if (!domains.length) return { historyEntryId: null };
			const session = ports.beginAction(domains[0], null);
			try {
				for (const domain of domains.slice(1)) session.touch(domain);
				session.run(() => { for (const part of parts) store(part.domain).write(part.domain, slice => put(slice, part)); });
				return session.commit();
			} catch (error) { session.cancel(); throw error; }
		},
	};
}
