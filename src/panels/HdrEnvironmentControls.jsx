import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ko } from "../locale.js";
import { Dropdown, Field, Slider } from "../ui.jsx";
import { HDR_BUILTINS } from "../stage-hdr.js";
import { hdrEnvironmentCatalogue, importHdrFile, refreshHdrLibrary, subscribeHdrLibrary } from "../stage-hdr-library.js";

const KO_NAMES = Object.fromEntries(HDR_BUILTINS.map(({ id, ko: name }) => [id, name]));
const ZH_NAMES = Object.fromEntries(HDR_BUILTINS.map(({ id, zh: name }) => [id, name]));

/**
 * The Light panel's HDR environment: load a .hdr / .exr / equirectangular
 * picture, pick a loaded or built-in map, turn and scale it, show it as the
 * backdrop or not, remove it. Picking, loading and removing are one undo step
 * each; the sliders ride the panel's gesture transaction (`setLighting`).
 */
export default function HdrEnvironmentControls({ lighting, run, setLighting }) {
	const environments = useSyncExternalStore(subscribeHdrLibrary, hdrEnvironmentCatalogue);
	const [problem, setProblem] = useState(null), [loading, setLoading] = useState(false), input = useRef(null);
	useEffect(() => { void refreshHdrLibrary(); }, []);
	// A map lights the set only while envLight > 0, so choosing one under the studio look turns that on too.
	const choose = (hdr) => run("stage.set", { lighting: hdr ? { hdr, ...(lighting.envLight > 0 ? {} : { envLight: 1 }) } : { hdr: null } });
	const load = async (event) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		setLoading(true);
		try {
			const { id } = await importHdrFile(file);
			setProblem(null);
			choose(id);
		} catch (error) {
			setProblem(error.message);
		} finally {
			setLoading(false);
		}
	};
	const options = [{ value: "", label: ko("None (the look's sky)", "없음 (룩의 하늘)") },
		...environments.map(({ id, name, source }) => ({ value: id, label: source === "builtin" ? ko(name, KO_NAMES[id] ?? name, ZH_NAMES[id] ?? name) : name }))];
	return (
		<div data-testid="hdr-environment">
			<Field label={ko("HDR environment", "HDR 환경")}>
				<Dropdown value={lighting.hdr ?? ""} ariaLabel={ko("HDR environment", "HDR 환경")} options={options} onChange={(value) => choose(value || null)} />
			</Field>
			<button type="button" className="btn ghost" disabled={loading} onClick={() => input.current?.click()}>
				{loading ? ko("Loading HDR…", "HDR 불러오는 중…") : ko("Load HDR…", "HDR 불러오기…")}
			</button>
			<input ref={input} type="file" hidden data-testid="hdr-file" accept=".hdr,.exr,.png,.jpg,.jpeg,image/vnd.radiance,image/x-exr,image/png,image/jpeg" onChange={load} />
			{problem && <p className="hint v2-details-hint" role="alert">{problem}</p>}
			{lighting.hdr && <>
				<Slider label={ko("Rotation", "회전")} min={-180} max={180} step={1} unit="°" value={lighting.hdrRotation} onChange={(hdrRotation) => setLighting({ hdrRotation })} />
				<Slider label={ko("Intensity", "세기")} min={0} max={4} step={0.05} value={lighting.hdrIntensity} onChange={(hdrIntensity) => setLighting({ hdrIntensity })} />
				<label className="check details-toggle-row">
					<span>{ko("Show as background", "배경으로 표시")}</span>
					<input type="checkbox" checked={lighting.hdrBackground} onChange={(event) => run("stage.set", { lighting: { hdrBackground: event.target.checked } })} />
				</label>
				<button type="button" className="btn ghost" onClick={() => choose(null)}>{ko("Remove HDR", "HDR 제거")}</button>
			</>}
		</div>
	);
}
