import type {Directory, Response} from "@nanahuse/player-manager-protocol";
import {resolveDisplayName} from "@nanahuse/player-manager-protocol";
import {useEffect, useMemo, useRef, useState} from "react";
import type {Operations} from "../../../protocol/index.ts";
import {render} from "../../render";
import {StorageSettings} from "../StorageSettings";
import {PageHeader} from "./PageHeader.tsx";
import {PlayerEditor} from "./PlayerEditor.tsx";
import "../player-mapping.css";

async function request<K extends keyof Operations>(
	operation: K,
	data: Operations[K]["request"],
): Promise<Operations[K]["response"]> {
	const response = (await nodecg.sendMessage(
		`player-manager.v3.${operation}`,
		data,
	)) as Response<Operations[K]["response"]>;
	if (!response.ok)
		throw new Error(`${response.error.code}: ${response.error.message}`);
	return response.data;
}

export function App() {
	const params = new URLSearchParams(window.location.search);
	const direct = params.has("playerId");
	const playerId = params.get("playerId");
	const [directory, setDirectory] = useState<Directory>({
		schemaVersion: 1,
		revision: 0,
		players: [],
	});
	const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
	const [tab, setTab] = useState<"players" | "settings">("players");
	const [editorDirty, setEditorDirty] = useState(false);
	const [settingsDirty, setSettingsDirty] = useState(false);
	const [filter, setFilter] = useState("");
	const [message, setMessage] = useState("");
	const [ready, setReady] = useState(false);
	const [statusKnown, setStatusKnown] = useState(false);
	const [directoryKnown, setDirectoryKnown] = useState(false);
	const statusRef = useRef({
		known: false,
		ready: false,
		error: null as string | null,
	});
	const directPlayer = directory.players.find(
		(entry) => entry.playerId === playerId,
	);
	const selectedPlayer = directory.players.find(
		(entry) => entry.playerId === selectedPlayerId,
	);
	const savedAccountIds = useMemo(
		() =>
			new Set(
				directory.players.flatMap((entry) =>
					(entry.accounts ?? []).map((account) => account.id),
				),
			),
		[directory],
	);
	const [directoryBusy, setDirectoryBusy] = useState(false);
	const [editorBusy, setEditorBusy] = useState(false);
	const operationBusy = directoryBusy || editorBusy;
	const operationBusyRef = useRef(false);
	useEffect(() => {
		const rep = nodecg.Replicant<Directory>("player-directory");
		const change = (value: Directory | undefined) => {
			if (value) {
				setDirectory(JSON.parse(JSON.stringify(value)) as Directory);
				setDirectoryKnown(true);
				if (
					selectedPlayerId &&
					!value.players.some((entry) => entry.playerId === selectedPlayerId)
				) {
					setSelectedPlayerId(null);
					setMessage("選択中のPlayerは削除されました。");
				}
			}
		};
		const status = nodecg.Replicant<{ready: boolean; error: string | null}>(
			"player-directory-status",
		);
		const statusChange = (
			value: {ready: boolean; error: string | null} | undefined,
		) => {
			statusRef.current = {
				known: value !== undefined,
				ready: value?.ready ?? false,
				error: value?.error ?? null,
			};
			setStatusKnown(value !== undefined);
			setReady(value?.ready ?? false);
			if (value?.error) setMessage(value.error);
		};
		rep.on("change", change);
		status.on("change", statusChange);
		return () => {
			rep.removeListener("change", change);
			status.removeListener("change", statusChange);
		};
	}, [selectedPlayerId]);
	const run = async (operation: () => Promise<void>) => {
		if (operationBusyRef.current) return;
		operationBusyRef.current = true;
		setDirectoryBusy(true);
		setMessage("");
		try {
			await operation();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			operationBusyRef.current = false;
			setDirectoryBusy(false);
		}
	};
	const canStartEditorOperation = () =>
		statusRef.current.ready && !operationBusyRef.current;
	const reportEditorBusy = (busy: boolean) => {
		operationBusyRef.current = busy;
		setEditorBusy(busy);
	};
	const initializeDirectory = () => {
		const confirmed = window.confirm(
			"新しい空の Player Directory を作成します。既存ファイルと保存先設定はバックアップされますが、現在の Player 情報は引き継がれません。Google Sheets は変更されません。続行しますか？",
		);
		if (!confirmed) return;
		void run(async () => {
			const empty = await request("initializeDirectory", {confirm: true});
			setDirectory(empty);
			setDirectoryKnown(true);
			statusRef.current = {known: true, ready: true, error: null};
			setStatusKnown(true);
			setReady(true);
			setSelectedPlayerId(null);
			setMessage("空のDirectoryを初期化しました。");
		});
	};
	const reloadDirectory = () => {
		void run(async () => {
			const loaded = await request("reload", undefined);
			setDirectory(loaded);
			setDirectoryKnown(true);
			statusRef.current = {known: true, ready: true, error: null};
			setStatusKnown(true);
			setReady(true);
			setMessage("Directoryを再読み込みしました。");
		});
	};
	if (statusKnown && !ready && statusRef.current.error)
		return (
			<main className='directory-recovery'>
				<PageHeader title='Directoryを復旧' />
				<section
					className='panel'
					aria-labelledby='directory-error-title'
				>
					<h2 id='directory-error-title'>Directoryを読み込めませんでした</h2>
					<p
						className='callout error'
						role='alert'
					>
						{statusRef.current.error}
					</p>
					<p className='muted'>詳細な原因はNodeCGのログで確認できます。</p>
					<div className='toolbar'>
						<button
							type='button'
							disabled={operationBusy}
							onClick={reloadDirectory}
						>
							再読み込み
						</button>
						<button
							type='button'
							disabled={operationBusy}
							onClick={initializeDirectory}
						>
							空のDirectoryを初期化
						</button>
					</div>
					{message && message !== statusRef.current.error && (
						<p
							role='alert'
							className='callout error'
						>
							{message}
						</p>
					)}
				</section>
				{operationBusy && (
					<p
						role='status'
						className='callout info'
					>
						処理中…
					</p>
				)}
				{!statusKnown && <p role='status'>Directoryの状態を確認しています…</p>}
			</main>
		);
	if (direct)
		return (
			<main className='player-edit-page'>
				<PageHeader title='Playerを編集' />
				{(!statusKnown || !directoryKnown || !ready || !directPlayer) && (
					<p
						role='status'
						className='callout info'
					>
						{!playerId
							? "不正な指定です: playerId が空です。"
							: !statusKnown || !directoryKnown || !ready
								? "Loading…"
								: "Playerが見つかりません。"}
					</p>
				)}
				{directPlayer && (
					<PlayerEditor
						key={directPlayer.playerId}
						initialPlayer={directPlayer}
						latestPlayer={directPlayer}
						ready={ready}
						savedAccountIds={savedAccountIds}
						standalone
						onDeleted={() => {}}
					/>
				)}
			</main>
		);
	return (
		<main>
			<PageHeader title='Player Directory'>
				<div
					className='statusbar'
					aria-label='Directoryの状態'
				>
					<div className='status'>
						<strong>PLAYERS</strong>
						<span>{directory.players.length}</span>
					</div>
					<div className={`status ${ready ? "success" : "warning"}`}>
						<strong>DIRECTORY</strong>
						<span>{ready ? "Ready" : "Not ready"}</span>
					</div>
				</div>
			</PageHeader>
			<nav
				className='tabs'
				aria-label='Directoryの表示'
			>
				{(["players", "settings"] as const).map((value) => (
					<button
						key={value}
						type='button'
						aria-current={tab === value ? "page" : undefined}
						className={tab === value ? "active" : ""}
						disabled={operationBusy}
						onClick={() => {
							if (tab === value || operationBusyRef.current) return;
							if (
								(editorDirty || settingsDirty) &&
								!window.confirm("未保存の変更を破棄してタブを切り替えますか？")
							)
								return;
							setEditorDirty(false);
							setSettingsDirty(false);
							setTab(value);
						}}
					>
						{value === "players" ? "Players" : "Settings"}
					</button>
				))}
			</nav>
			{(operationBusy || message) && (
				<div
					role='status'
					aria-live='polite'
					className='callout info'
				>
					{operationBusy ? "処理中…" : message}
				</div>
			)}
			{tab === "settings" ? (
				<StorageSettings
					onDirtyChange={setSettingsDirty}
					busy={operationBusy}
					ready={ready}
					configure={(value) =>
						void run(async () => {
							const result = await request("configureStorage", {
								spreadsheet: value,
							});
							setSelectedPlayerId(null);
							setMessage(result.message);
						})
					}
				/>
			) : (
				<div className='layout'>
					<aside className='panel'>
						<div className='toolbar'>
							<h2>Players</h2>
							<button
								disabled={operationBusy}
								onClick={() => {
									if (operationBusyRef.current) return;
									window.open(
										"/bundles/player-manager/dashboard/Registration.html?standalone=true",
										"_blank",
										"noopener,noreferrer",
									);
								}}
							>
								＋ 新規
							</button>
						</div>
						<input
							aria-label='プレイヤーを検索'
							placeholder='名前 / ID / アカウントを検索'
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
						/>
						<ul>
							{directory.players
								.filter((p) =>
									JSON.stringify(p)
										.toLowerCase()
										.includes(filter.toLowerCase()),
								)
								.map((p) => (
									<li key={p.playerId}>
										<button
											disabled={operationBusy}
											className={
												selectedPlayerId === p.playerId ? "active" : ""
											}
											onClick={() => {
												if (
													operationBusyRef.current ||
													selectedPlayerId === p.playerId
												)
													return;
												if (
													editorDirty &&
													!window.confirm("未保存の変更を破棄しますか？")
												)
													return;
												setEditorDirty(false);
												setSelectedPlayerId(p.playerId);
											}}
										>
											<strong>{resolveDisplayName(p)}</strong>
											<small>{p.playerId}</small>
										</button>
									</li>
								))}
						</ul>
						<button
							disabled={operationBusy}
							onClick={() =>
								void run(async () => {
									await request("reload", undefined);
									setMessage("Directoryを再読込しました");
								})
							}
						>
							保存先から再読込
						</button>
					</aside>
					{selectedPlayer && (
						<PlayerEditor
							key={selectedPlayer.playerId}
							initialPlayer={selectedPlayer}
							latestPlayer={selectedPlayer}
							ready={ready}
							savedAccountIds={savedAccountIds}
							canStartOperation={canStartEditorOperation}
							onOperationBusyChange={reportEditorBusy}
							onDirtyChange={setEditorDirty}
							onDeleted={(deletedPlayerId) =>
								setSelectedPlayerId((current) =>
									current === deletedPlayerId ? null : current,
								)
							}
						/>
					)}
				</div>
			)}
		</main>
	);
}

render(<App />);
