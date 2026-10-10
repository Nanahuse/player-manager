import type {
	Directory,
	Player,
	Response,
} from "@nanahuse/player-manager-protocol";
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
		`player-manager.v2.${operation}`,
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
	const [selected, setSelected] = useState<Player | null>(null);
	const [filter, setFilter] = useState("");
	const [message, setMessage] = useState("");
	const [ready, setReady] = useState(false);
	const [statusKnown, setStatusKnown] = useState(false);
	const statusRef = useRef({
		known: false,
		ready: false,
		error: null as string | null,
	});
	const [player, setPlayer] = useState<Player | null>(null);
	const [loading, setLoading] = useState(direct);
	const [loadError, setLoadError] = useState("");
	const [loadAttempt, setLoadAttempt] = useState(0);
	const requestedLoad = useRef<string | null>(null);
	const [directoryBusy, setDirectoryBusy] = useState(false);
	const [editorBusy, setEditorBusy] = useState(false);
	const operationBusy = directoryBusy || editorBusy;
	const operationBusyRef = useRef(false);
	useEffect(() => {
		const rep = nodecg.Replicant<Directory>("player-directory");
		const change = (value: Directory | undefined) => {
			if (value) setDirectory(JSON.parse(JSON.stringify(value)) as Directory);
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
	}, []);
	useEffect(() => {
		if (!direct) return;
		if (!playerId) {
			setLoading(false);
			setLoadError("不正な指定です: playerId が空です。");
			return;
		}
		const status = statusRef.current;
		if (!statusKnown || !status.known) {
			setLoading(true);
			setLoadError("");
			return;
		}
		if (!ready) {
			if (status.error) {
				setLoading(false);
				setLoadError(`Directoryを利用できません: ${status.error}`);
			} else {
				setLoading(true);
				setLoadError("");
			}
			return;
		}
		const requestKey = `${playerId}:${loadAttempt}`;
		if (requestedLoad.current === requestKey) return;
		requestedLoad.current = requestKey;
		const requestAttempt = loadAttempt;
		setLoading(true);
		setLoadError("");
		setPlayer(null);
		void request("get", {playerId})
			.then((result) => {
				if (
					requestedLoad.current !== requestKey ||
					requestAttempt !== loadAttempt
				)
					return;
				if (result) setPlayer(result);
				else setLoadError("Playerが見つかりません。");
			})
			.catch((error) => {
				if (requestedLoad.current === requestKey)
					setLoadError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (requestedLoad.current === requestKey) setLoading(false);
			});
	}, [direct, playerId, statusKnown, ready, loadAttempt]);
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
				{loading && (
					<p
						role='status'
						className='notice'
					>
						Loading…
					</p>
				)}
				{loadError && (
					<div
						role='alert'
						className='notice warning'
					>
						{loadError}
						<button
							type='button'
							disabled={!ready || !playerId}
							onClick={() => setLoadAttempt((v) => v + 1)}
						>
							再試行
						</button>
					</div>
				)}
				{player && (
					<PlayerEditor
						key={player.playerId}
						initialPlayer={player}
						ready={ready}
						standalone
						onUpdated={setPlayer}
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
						setSelected(null);
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
										className={
											selected?.playerId === p.playerId ? "active" : ""
										}
										onClick={() => {
											if (!operationBusyRef.current) setSelected(p);
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
				{selected && (
					<PlayerEditor
						key={selected.playerId}
						initialPlayer={selected}
						ready={ready}
						canStartOperation={canStartEditorOperation}
						onOperationBusyChange={reportEditorBusy}
						onUpdated={(updated) =>
							setSelected((current) =>
								current?.playerId === updated.playerId ? updated : current,
							)
						}
						onDeleted={(playerId) =>
							setSelected((current) =>
								current?.playerId === playerId ? null : current,
							)
						}
					/>
				)}
			</div>
		</main>
	);
}

render(<App />);
