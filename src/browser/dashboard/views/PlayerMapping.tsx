import type {Directory, Response} from "@nanahuse/player-manager-protocol";
import {resolveDisplayName} from "@nanahuse/player-manager-protocol";
import {useEffect, useRef, useState} from "react";
import type {Operations} from "../../../protocol/index.ts";
import {render} from "../../render";
import {StorageSettings} from "../StorageSettings";
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
	if (direct)
		return (
			<main className='player-edit-page'>
				<header>
					<div>
						<p className='eyebrow'>PLAYER MANAGER</p>
						<h1>Playerを編集</h1>
						<p>対象: {playerId || "（空のplayerId）"}</p>
					</div>
				</header>
				{(!statusKnown || !directoryKnown || !ready || !directPlayer) && (
					<p
						role='status'
						className='notice'
					>
						{!playerId
							? "不正な指定です: playerId が空です。"
							: !statusKnown || !directoryKnown || !ready
								? "Loading…"
								: "Playerが見つかりません。"}
					</p>
				)}
				{statusKnown && !ready && statusRef.current.error && (
					<div
						role='alert'
						className='notice warning'
					>
						Directoryを利用できません: {statusRef.current.error}
					</div>
				)}
				{directPlayer && (
					<PlayerEditor
						key={directPlayer.playerId}
						initialPlayer={directPlayer}
						latestPlayer={directPlayer}
						ready={ready}
						standalone
						onDeleted={() => {}}
					/>
				)}
			</main>
		);
	return (
		<main>
			<header>
				<div>
					<p className='eyebrow'>PLAYER MANAGER</p>
					<h1>Player Directory</h1>
					<p>
						既存Playerを編集・削除します。新規Playerの登録とアカウントの突合は
						Registration で行います。
					</p>
				</div>
				<span className='badge'>
					{directory.players.length} players · {ready ? "Ready" : "Not ready"}
				</span>
			</header>
			<div
				role='status'
				aria-live='polite'
				className='notice'
			>
				{operationBusy
					? "処理中…"
					: message ||
						"既存Playerの編集は保存ボタンで反映します。新規Playerの登録とアカウントの突合・整理はRegistration画面で行います。"}
			</div>
			<StorageSettings
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
			<div className='layout'>
				<aside>
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
								JSON.stringify(p).toLowerCase().includes(filter.toLowerCase()),
							)
							.map((p) => (
								<li key={p.playerId}>
									<button
										disabled={operationBusy}
										className={selectedPlayerId === p.playerId ? "active" : ""}
										onClick={() => {
											if (!operationBusyRef.current)
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
						canStartOperation={canStartEditorOperation}
						onOperationBusyChange={reportEditorBusy}
						onDeleted={(deletedPlayerId) =>
							setSelectedPlayerId((current) =>
								current === deletedPlayerId ? null : current,
							)
						}
					/>
				)}
			</div>
		</main>
	);
}

render(<App />);
