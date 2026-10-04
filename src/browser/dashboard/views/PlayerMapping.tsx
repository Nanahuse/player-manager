import {StorageSettings} from "../StorageSettings";
import {
	login,
	speedrunReference,
	speedrunWeblink,
	youtubeUrl,
} from "../../../domain/player.ts";
import {resolveDisplayName} from "../../../protocol/index.ts";
import {useEffect, useState} from "react";
import type {
	Directory,
	Operations,
	Player,
	PlayerInput,
	ProviderIdentity,
	Resolution,
	Response,
} from "../../../protocol/index.ts";
import {render} from "../../render";
import "../player-mapping.css";

const blank = (): PlayerInput => ({
	manualDisplayName: null,
	racetime: null,
	speedrunCom: null,
	twitch: null,
});
async function request<K extends keyof Operations>(
	operation: K,
	data: Operations[K]["request"],
): Promise<Operations[K]["response"]> {
	const response = (await nodecg.sendMessage(
		`player-directory.v1.${operation}`,
		data,
	)) as Response<Operations[K]["response"]>;
	if (!response.ok)
		throw new Error(`${response.error.code}: ${response.error.message}`);
	return response.data;
}
function AccountHeading({
	service,
	value,
	weblink,
}: {
	service: string;
	value?: string | null;
	weblink?: string;
}) {
	let href: string | null = null;
	try {
		if (value?.trim()) {
			if (service === "Twitch") href = "https://www.twitch.tv/" + login(value);
			else if (service === "Speedrun.com") href = speedrunWeblink(weblink);
			else if (service === "YouTube") href = youtubeUrl(value);
			else {
				const raw = value.trim();
				if (/^[a-zA-Z0-9]{1,100}$/.test(raw))
					href = "https://racetime.gg/user/" + raw;
				else {
					const url = new URL(raw);
					const match = /^\/user\/([a-zA-Z0-9]{1,100})\/?$/.exec(url.pathname);
					if (
						url.origin === "https://racetime.gg" &&
						!url.username &&
						!url.password &&
						match
					)
						href = "https://racetime.gg/user/" + match[1];
				}
			}
		}
	} catch {
		/* Incomplete input has no profile link yet. */
	}
	return (
		<div className='account-heading'>
			<h3>{service}</h3>
			{href && (
				<a
					href={href}
					target='_blank'
					rel='noopener noreferrer'
					aria-label={service + "のプロフィールを開く（新しいタブ）"}
				>
					プロフィールを開く ↗
				</a>
			)}
		</div>
	);
}
function SpeedrunHeading({account}: {account: ProviderIdentity | null}) {
	const userId = account?.userId.trim() ?? "";
	const storedLink = speedrunWeblink(account?.weblink);
	const [result, setResult] = useState<{
		id: string;
		url: string | null;
		error: string;
	} | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		if (!userId || storedLink) return;
		let active = true;
		setResult(null);
		const timer = window.setTimeout(() => {
			void (async () => {
				try {
					const profile = await request("getUser", {
						userId: speedrunReference(userId),
					});
					const url = speedrunWeblink(profile.weblink);
					if (active)
						setResult({
							id: userId,
							url,
							error: url ? "" : "プロフィールURLがAPIから返されませんでした。",
						});
				} catch {
					if (active)
						setResult({
							id: userId,
							url: null,
							error: "プロフィールURLを取得できませんでした。",
						});
				}
			})();
		}, 400);
		return () => {
			active = false;
			window.clearTimeout(timer);
		};
	}, [userId, storedLink, attempt]);
	const current = result?.id === userId ? result : null;
	return (
		<>
			<AccountHeading
				service='Speedrun.com'
				value={userId}
				weblink={storedLink ?? current?.url ?? undefined}
			/>
			{userId && !storedLink && !current && (
				<p
					className='muted'
					role='status'
				>
					プロフィールURLを取得中…
				</p>
			)}
			{userId && !storedLink && current?.error && (
				<p
					className='muted'
					role='status'
				>
					{current.error}{" "}
					<button
						type='button'
						onClick={() => setAttempt((v) => v + 1)}
					>
						再試行
					</button>
				</p>
			)}
		</>
	);
}
function App() {
	const [directory, setDirectory] = useState<Directory>({
		schemaVersion: 1,
		revision: 0,
		players: [],
	});
	const [selected, setSelected] = useState<Player | null>(null);
	const [input, setInput] = useState<PlayerInput>(blank);
	const [filter, setFilter] = useState("");
	const [query, setQuery] = useState("");
	const [users, setUsers] = useState<ProviderIdentity[]>([]);
	const [resolution, setResolution] = useState<Resolution | null>(null);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [ready, setReady] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
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
	const choose = (player: Player | null) => {
		setSelected(player);
		setInput(player ? structuredClone(player) : blank());
		setResolution(null);
		setConfirmDelete(false);
		setMessage("");
	};
	const run = async (operation: () => Promise<void>) => {
		setBusy(true);
		setMessage("");
		try {
			await operation();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};
	const field = (
		label: string,
		value: string,
		update: (value: string) => void,
	) => (
		<label>
			{label}
			<input
				value={value}
				onChange={(e) => {
					update(e.target.value);
					setResolution(null);
				}}
			/>
		</label>
	);
	return (
		<main>
			<header>
				<div>
					<p className='eyebrow'>PLAYER MANAGER</p>
					<h1>Player Directory</h1>
					<p>Identity・手動紐付け・自動突合</p>
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
				{busy
					? "処理中…"
					: message ||
						"変更は保存ボタンで確定します。自動突合はプレビューです。"}
			</div>
			<StorageSettings
				busy={busy}
				ready={ready}
				configure={(value) =>
					void run(async () => {
						const result = await request("configureStorage", {
							spreadsheet: value,
						});
						choose(null);
						setMessage(result.message);
					})
				}
			/>
			<div className='layout'>
				<aside>
					<div className='toolbar'>
						<h2>Players</h2>
						<button
							disabled={busy}
							onClick={() => choose(null)}
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
										disabled={busy}
										className={
											selected?.playerId === p.playerId ? "active" : ""
										}
										onClick={() => choose(p)}
									>
										<strong>{resolveDisplayName(p)}</strong>
										<small>{p.playerId}</small>
									</button>
								</li>
							))}
					</ul>
					<button
						disabled={busy}
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
				<section>
					<h2>{selected ? "プレイヤーを編集" : "プレイヤーを作成"}</h2>
					{selected && (
						<p className='muted'>
							{selected.playerId} · revision {selected.revision}
						</p>
					)}
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void run(async () => {
								const player = selected
									? await request("update", {
											playerId: selected.playerId,
											revision: selected.revision,
											input,
										})
									: await request("create", {input});
								choose(player);
								setMessage("保存しました");
							});
						}}
					>
						<fieldset disabled={busy || !ready}>
							{field("表示名", input.manualDisplayName ?? "", (v) =>
								setInput({...input, manualDisplayName: v || null}),
							)}
							<p className='muted'>
								使用する表示名: {resolveDisplayName(input)}
							</p>
							<AccountHeading
								service='RaceTime'
								value={input.racetime?.userId}
							/>
							<p className='muted'>
								RaceTimeのIDまたはプロフィールURLだけで突合できます。名前・Twitchは自動取得します。
							</p>
							{field(
								"RaceTime user ID / プロフィールURL",
								input.racetime?.userId ?? "",
								(v) =>
									setInput({
										...input,
										racetime: v
											? {
													...(input.racetime ?? {name: "", twitchLogin: null}),
													userId: v,
												}
											: null,
									}),
							)}
							{input.racetime?.name && (
								<p className='muted'>{input.racetime.name}</p>
							)}
							<AccountHeading
								service='Twitch'
								value={input.twitch?.login}
							/>
							{field(
								"Twitchユーザー名 / チャンネルURL",
								input.twitch?.login ?? "",
								(v) =>
									setInput({
										...input,
										twitch: v
											? {
													...(input.twitch ?? {userId: null}),
													login: v,
													displayName: undefined,
												}
											: null,
									}),
							)}
							<AccountHeading
								service='YouTube'
								value={input.youtube}
							/>
							{field(
								"YouTubeチャンネルURL / @ハンドル",
								input.youtube ?? "",
								(v) => setInput({...input, youtube: v || null}),
							)}
							<p className='muted'>
								取得できた共通リンクで突合します。各アカウントは空欄のままでも保存できます。
							</p>
							<SpeedrunHeading account={input.speedrunCom} />
							{field(
								"Speedrun.com ID・ユーザー名 / プロフィールURL",
								input.speedrunCom?.userId ?? "",
								(v) =>
									setInput({
										...input,
										speedrunCom: v
											? {userId: v, name: v, twitchLogin: null}
											: null,
									}),
							)}
							{input.speedrunCom && (
								<p className='muted'>{input.speedrunCom.name}</p>
							)}
							<div className='search'>
								{field("Speedrun.comユーザー検索", query, setQuery)}
								<button
									type='button'
									onClick={() =>
										void run(async () => {
											const found = await request("searchUsers", {
												query,
												mode: "name",
											});
											setUsers(found.users);
											setMessage(
												found.hasMore
													? "結果が多いため検索語を絞ってください"
													: `${found.users.length}件`,
											);
										})
									}
								>
									検索
								</button>
							</div>
							<ul className='results'>
								{users.map((u) => (
									<li key={u.userId}>
										<button
											type='button'
											onClick={() => {
												setInput({...input, speedrunCom: u});
												setResolution(null);
											}}
										>
											{u.name} · {u.userId} · Twitch: {u.twitchLogin ?? "なし"}
										</button>
									</li>
								))}
							</ul>
							<div className='toolbar'>
								<button
									type='button'
									onClick={() =>
										void run(async () => {
											setResolution(await request("resolve", {input}));
										})
									}
								>
									Identityを自動突合
								</button>
								<button
									className='primary'
									type='submit'
								>
									保存
								</button>
							</div>
							{resolution && (
								<div className='resolution'>
									<strong>{resolution.status}</strong>
									<p>{resolution.message}</p>
									<p>YouTube: {resolution.input.youtube ?? "未解決"}</p>
									<p>
										RaceTime:{" "}
										{resolution.input.racetime
											? `${resolution.input.racetime.name} (${resolution.input.racetime.userId})`
											: "未解決"}
									</p>
									{resolution.warnings?.map((warning) => (
										<p key={warning}>{warning}</p>
									))}
									<p>
										Player: {resolution.playerId ?? "未登録"} / SRC:{" "}
										{resolution.input.speedrunCom?.userId ?? "未解決"} / Twitch:{" "}
										{resolution.input.twitch?.login ?? "未解決"}
									</p>
									{resolution.candidates.length > 0 && (
										<p>候補: {resolution.candidates.join(", ")}</p>
									)}
									{["matched", "unresolved", "ambiguous"].includes(
										resolution.status,
									) && (
										<button
											type='button'
											onClick={() => {
												const existing = directory.players.find(
													(p) => p.playerId === resolution.playerId,
												);
												if (existing) {
													setSelected(existing);
													setInput({
														...existing,
														...resolution.input,
														racetime:
															resolution.input.racetime ?? existing.racetime,
														speedrunCom:
															resolution.input.speedrunCom ??
															existing.speedrunCom,
														twitch: resolution.input.twitch ?? existing.twitch,
														youtube:
															resolution.input.youtube ?? existing.youtube,
														manualDisplayName:
															resolution.input.manualDisplayName ??
															existing.manualDisplayName,
													});
												} else setInput(resolution.input);
												setResolution(null);
											}}
										>
											結果を編集フォームへ反映
										</button>
									)}
								</div>
							)}
							{selected && (
								<div className='danger'>
									{confirmDelete ? (
										<>
											<span>このプレイヤーを削除しますか？</span>
											<button
												type='button'
												onClick={() =>
													void run(async () => {
														await request("delete", {
															playerId: selected.playerId,
															revision: selected.revision,
														});
														choose(null);
														setMessage("削除しました");
													})
												}
											>
												削除を確定
											</button>
											<button
												type='button'
												onClick={() => setConfirmDelete(false)}
											>
												キャンセル
											</button>
										</>
									) : (
										<button
											type='button'
											onClick={() => setConfirmDelete(true)}
										>
											プレイヤーを削除
										</button>
									)}
								</div>
							)}
						</fieldset>
					</form>
				</section>
			</div>
		</main>
	);
}
render(<App />);
