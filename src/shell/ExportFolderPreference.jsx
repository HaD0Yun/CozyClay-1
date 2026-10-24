import { useEffect, useState } from "react";
import { ko } from "../locale.js";
import {
	canChooseExportWorkspace,
	chooseExportWorkspace,
	clearExportWorkspace,
	loadExportWorkspace,
	requestExportWorkspacePermission,
} from "../export-workspace.js";
import { PreferenceRow } from "./preference-controls.jsx";

const SUPPORTED_DESCRIPTION = ko(
	"When set, exports are written here instead of your browser's Downloads folder.",
	"설정하면 내보낸 파일이 브라우저 다운로드 폴더 대신 이 폴더에 저장됩니다.",
);

function statusCopy(permission) {
	if (permission === "prompt") return ko("Folder access needs to be re-allowed.", "폴더 접근을 다시 허용해야 해요.");
	if (permission === "denied") return ko("Folder access was denied. Choose another folder or use Downloads.", "폴더 접근이 거부되었어요. 다른 폴더를 선택하거나 다운로드를 사용하세요.");
	return null;
}

export default function ExportFolderPreference() {
	const supported = canChooseExportWorkspace();
	const [workspace, setWorkspace] = useState(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);

	useEffect(() => {
		let active = true;
		loadExportWorkspace().then((value) => {
			if (active) setWorkspace(value);
		});
		return () => { active = false; };
	}, []);

	const choose = async () => {
		setBusy(true);
		setError(null);
		try {
			const handle = await chooseExportWorkspace();
			setWorkspace({ handle, permission: "granted" });
		} catch (cause) {
			if (cause?.name !== "AbortError") setError(ko("Could not choose the export folder.", "내보내기 폴더를 선택하지 못했어요."));
		} finally {
			setBusy(false);
		}
	};

	const allow = async () => {
		if (!workspace?.handle) return;
		setBusy(true);
		setError(null);
		try {
			const permission = await requestExportWorkspacePermission(workspace.handle);
			setWorkspace({ ...workspace, permission });
		} finally {
			setBusy(false);
		}
	};

	const clear = async () => {
		setBusy(true);
		setError(null);
		try {
			const cleared = await clearExportWorkspace();
			if (cleared) setWorkspace(null);
			else setError(ko("Could not clear the export folder.", "내보내기 폴더를 해제하지 못했어요."));
		} finally {
			setBusy(false);
		}
	};

	const status = workspace ? statusCopy(workspace.permission) : null;
	const folderName = workspace?.handle?.name ?? ko("Browser downloads", "브라우저 다운로드");
	const description = supported ? SUPPORTED_DESCRIPTION : ko("This browser cannot choose an export folder; exports continue to Downloads.", "이 브라우저에서는 내보내기 폴더를 선택할 수 없어요. 내보내기는 다운로드 폴더로 이어집니다.");

	return (
		<PreferenceRow title={ko("Export folder", "내보내기 폴더")} description={description} testid="preferences-export-folder" full>
			<div className="v2-preferences__export-folder">
				<span className="v2-preferences__export-folder-name" data-testid="preferences-export-folder-name">{folderName}</span>
				{status && <span className="v2-preferences__export-folder-status" role="status">{status}</span>}
				{error && <span className="v2-preferences__export-folder-status" role="alert">{error}</span>}
				<div className="v2-preferences__language-controls" role="group" aria-label={ko("Export folder actions", "내보내기 폴더 작업")}>
					{workspace && workspace.permission !== "granted" && (
						<button type="button" className="v2-preferences__language" data-testid="settings-export-folder-allow" disabled={busy} onClick={allow}>
							{ko("Allow", "허용")}
						</button>
					)}
					<button type="button" className="v2-preferences__language" data-testid="settings-export-folder-choose" disabled={!supported || busy} onClick={choose}>
						{busy ? ko("Choosing…", "선택 중…") : ko("Choose folder…", "폴더 선택…")}
					</button>
					{workspace && (
						<button type="button" className="v2-preferences__language" data-testid="settings-export-folder-clear" disabled={busy} onClick={clear}>
							{ko("Use Downloads", "다운로드 사용")}
						</button>
					)}
				</div>
			</div>
			<span className="v2-preferences__export-folder-note">{ko("Existing files are never overwritten; numbered names are used.", "같은 이름의 파일이 있으면 번호가 붙고 덮어쓰지 않아요.")}</span>
		</PreferenceRow>
	);
}
