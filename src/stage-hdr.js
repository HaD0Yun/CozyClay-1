// HDR environments for the stage look: the stage.lighting.hdr* fields, the
// built-in maps the Studio generates itself, and the records of the .hdr / .exr
// / equirectangular picture files a user loads. A loaded file lives in the
// shared asset store (scene-assets.js) under an `hdr-` id derived from its bytes,
// exactly like a picture or a model, so it travels in a saved project and
// survives a reload. Pure data and arithmetic, no three.js: the scene document,
// the tests and the agent sidecar load it.

/** Content-addressed prefix of a stored environment file. */
const HDR_ID_PREFIX = "hdr-";
const HDR_ID = /^hdr-[0-9a-f]{32}$/;
/** The file ceiling: the same 32 MB a project file decodes an embedded asset against (scene-assets.js ASSET_MAX_SOURCE_BYTES). */
export const HDR_MAX_BYTES = 32 * 1024 * 1024;
/** Decoded size ceiling for float maps (half floats: 8 bytes a pixel while decoding). */
export const HDR_MAX_PIXELS = 4096 * 4096;
/** Stored MIME types: Radiance RGBE, OpenEXR, and an LDR equirectangular picture. */
const HDR_TYPES = Object.freeze(["image/vnd.radiance", "image/x-exr", "image/png", "image/jpeg"]);

/**
 * The maps the Studio draws itself (stage-hdr-builtins.js), so the agent has
 * real environments without a file. `brightest` is the direction of the map's
 * brightest light at hdrRotation 0, as a world vector (y up, +z toward the
 * default camera); hdrRotation turns it about +y.
 */
export const HDR_BUILTINS = Object.freeze([
	{ id: "builtin:night-street", name: "Night street", ko: "밤거리", zh: "夜晚街道", brightest: [0.72, 0.2, 0.66],
		note: "dark blue night sky, a building skyline with lit windows, two warm sodium street lamps (front right and back left) pooling light on wet asphalt, a dim moon" },
	{ id: "builtin:overcast-field", name: "Overcast field", ko: "흐린 들판", zh: "阴天田野", brightest: [-0.35, 0.66, -0.67],
		note: "bright soft grey overcast sky (brighter overhead), a faint sun glow behind the clouds back left, a distant tree line and a green field" },
	{ id: "builtin:studio-softbox", name: "Studio softbox", ko: "스튜디오 소프트박스", zh: "影棚柔光箱", brightest: [-0.6, 0.4, 0.7],
		note: "dark grey photo studio: a large white softbox front left, a tall strip light right, a soft overhead panel and a rim panel behind" },
].map((entry) => Object.freeze({ ...entry, brightest: Object.freeze(entry.brightest) })));
const BUILTIN_IDS = new Set(HDR_BUILTINS.map((entry) => entry.id));

export const isHdrAssetId = (value) => typeof value === "string" && HDR_ID.test(value);
export const isBuiltinHdrId = (value) => BUILTIN_IDS.has(value);
/** What stage.lighting.hdr may hold: a built-in name or a stored file's id. */
export const isHdrEnvironmentId = (value) => isBuiltinHdrId(value) || isHdrAssetId(value);

const finite = (value) => typeof value === "number" && Number.isFinite(value);
/** Degrees into [-180, 180): 180 wraps to -180, like the other yaw fields. */
export const wrapDegrees = (value) => ((((value + 180) % 360) + 360) % 360) - 180;

/** The four HDR fields of stage.lighting, present and in range: no map is the default. */
export function normalizeHdrFields(source = {}) {
	return {
		hdr: isHdrEnvironmentId(source.hdr) ? source.hdr : null,
		hdrRotation: finite(source.hdrRotation) ? Number(wrapDegrees(source.hdrRotation).toFixed(3)) : 0,
		hdrIntensity: finite(source.hdrIntensity) ? Math.max(0, Math.min(4, source.hdrIntensity)) : 1,
		hdrBackground: typeof source.hdrBackground === "boolean" ? source.hdrBackground : true,
	};
}
export const HDR_FIELDS = Object.freeze(Object.keys(normalizeHdrFields()));

/* ------------------------------------------------------------ files ---- */

const ascii = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + length)));

/** The stored MIME type of an environment file from its first bytes, or null. */
export function sniffHdrType(bytes) {
	if (ascii(bytes, 0, 10) === "#?RADIANCE" || ascii(bytes, 0, 6) === "#?RGBE") return "image/vnd.radiance";
	if (bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01) return "image/x-exr";
	if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	return null;
}

/** Width and height from a Radiance header ("-Y 512 +X 1024"), or null. */
function radianceSize(bytes) {
	const match = /\n\s*-Y\s+(\d+)\s+\+X\s+(\d+)\s*\n/.exec(ascii(bytes, 0, 8192));
	return match ? { width: Number(match[2]), height: Number(match[1]) } : null;
}

/** Width and height from an OpenEXR header's dataWindow attribute, or null. */
function exrSize(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const text = (at) => { let end = at; while (end < bytes.length && bytes[end] !== 0) end++; return [ascii(bytes, at, end - at), end + 1]; };
	let at = 8;
	while (at < Math.min(bytes.length, 65536)) {
		const [name, afterName] = text(at);
		if (!name) return null;
		const [, afterType] = text(afterName);
		const size = view.getInt32(afterType, true), value = afterType + 4;
		if (name === "dataWindow" && size === 16) {
			const [xMin, yMin, xMax, yMax] = [0, 4, 8, 12].map((offset) => view.getInt32(value + offset, true));
			return { width: xMax - xMin + 1, height: yMax - yMin + 1 };
		}
		at = value + size;
	}
	return null;
}

/** The pixel size a float map declares before it is decoded (null for a picture). */
export function declaredHdrSize(type, bytes) {
	try { return type === "image/vnd.radiance" ? radianceSize(bytes) : type === "image/x-exr" ? exrSize(bytes) : null; }
	catch { return null; }
}

/** Why an environment file cannot be loaded, as a sentence for the user, or null when it can. */
export function hdrFileProblem(byteLength, type, size) {
	if (byteLength > HDR_MAX_BYTES) return `that file is ${(byteLength / 1048576).toFixed(1)} MB; an HDR environment can be at most ${HDR_MAX_BYTES / 1048576} MB`;
	if (!type) return "that file is not an HDR environment CozyClay can load (Radiance .hdr, OpenEXR .exr, or an equirectangular .png / .jpg)";
	if ((type === "image/vnd.radiance" || type === "image/x-exr") && !size) return "that HDR file has no readable image size";
	if (size && size.width * size.height > HDR_MAX_PIXELS) return `that HDR is ${size.width} x ${size.height}; the limit is ${HDR_MAX_PIXELS / 1048576} megapixels (4096 x 4096)`;
	return null;
}

async function sha256Hex(bytes, subtle) {
	if (!subtle?.digest) throw new Error("SubtleCrypto is unavailable — a secure context is required to load an HDR");
	const digest = await subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The id these bytes are stored under: `hdr-` and the first 128 bits of their SHA-256. */
export async function hdrIdForBytes(bytes, subtle = globalThis.crypto?.subtle) {
	const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
	return `${HDR_ID_PREFIX}${(await sha256Hex(view, subtle)).slice(0, 32)}`;
}

const direction = (value) => Array.isArray(value) && value.length === 3 && value.every(finite) ? value.map((v) => Number(v.toFixed(2))) : null;
/** A stored environment record repaired, or null to drop it (scene-assets.js normalizeAsset). */
export function normalizeHdrAsset(record, bytes) {
	if (!isHdrAssetId(record?.id) || typeof record.type !== "string" || !HDR_TYPES.includes(record.type.toLowerCase())) return null;
	const width = Math.round(Number(record.width)), height = Math.round(Number(record.height)), brightest = direction(record.brightest);
	return {
		id: record.id, type: record.type.toLowerCase(), bytes, name: typeof record.name === "string" ? record.name : "",
		...(width > 0 && height > 0 ? { width, height } : {}),
		...(brightest ? { brightest } : {}),
	};
}
