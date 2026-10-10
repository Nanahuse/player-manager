import type {
	FailureCode,
	Player,
	PlayerInput,
	ProviderIdentity,
	Response,
} from "@nanahuse/player-manager-protocol";
import {resolveDisplayName} from "@nanahuse/player-manager-protocol";
import {useEffect, useRef, useState} from "react";
import {
	login,
	speedrunReference,
	speedrunWeblink,
	youtubeUrl,
} from "../../../domain/player.ts";
import type {Operations} from "../../../protocol/index.ts";
import {SpeedrunUserSearch} from "./SpeedrunUserSearch.tsx";

async function request<K extends keyof Operations>(
	operation: K,
	data: Operations[K]["request"],
): Promise<Operations[K]["response"]> {
	const response = (await nodecg.sendMessage(
		`player-manager.v2.${operation}`,
		data,
	)) as Response<Operations[K]["response"]>;
	if (!response.ok)
		throw new PlayerRequestError(response.error.code, response.error.message);
	return response.data;
}

class PlayerRequestError extends Error {
	constructor(
		readonly code: FailureCode,
		message: string,
	) {
		super(`${code}: ${message}`);
	}
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
					aria-label={`${service}のプロフィールを開く（新しいタブ）`}
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
		attempt: number;
		url: string | null;
		error: string;
	} | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		if (!userId || storedLink) return;
		let active = true;
		setResult(null);
		const timer = window.setTimeout(
			() =>
				void (async () => {
					try {
						const profile = await request("getUser", {
							userId: speedrunReference(userId),
						});
						const url = speedrunWeblink(profile.weblink);
						if (active)
							setResult({
								id: userId,
								attempt,
								url,
								error: url
									? ""
									: "プロフィールURLがAPIから返されませんでした。",
							});
					} catch {
						if (active)
							setResult({
								id: userId,
								attempt,
								url: null,
								error: "プロフィールURLを取得できませんでした。",
							});
					}
				})(),
			400,
		);
		return () => {
			active = false;
			window.clearTimeout(timer);
		};
	}, [userId, storedLink, attempt]);
	const current =
		result?.id === userId && result.attempt === attempt ? result : null;
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

export function PlayerEditor({
	initialPlayer,
	ready,
	canStartOperation,
	onOperationBusyChange,
	onUpdated,
	onDeleted,
	standalone = false,
}: {
	initialPlayer: Player;
	ready: boolean;
	canStartOperation?: () => boolean;
	onOperationBusyChange?: (busy: boolean) => void;
	onUpdated: (player: Player) => void;
	onDeleted: (playerId: string) => void;
	standalone?: boolean;
}) {
	const [player, setPlayer] = useState(initialPlayer);
	const [input, setInput] = useState<PlayerInput>(() =>
		structuredClone(initialPlayer),
	);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const [errorCode, setErrorCode] = useState<FailureCode | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [deleted, setDeleted] = useState(false);
	const missing = errorCode === "player_not_found";
	const conflict = errorCode === "player_changed";
	const available = ready && !missing && (canStartOperation?.() ?? true);
	const run = async (operation: () => Promise<void>) => {
		if (
			busyRef.current ||
			deleted ||
			!ready ||
			missing ||
			!(canStartOperation?.() ?? true)
		)
			return;
		busyRef.current = true;
		onOperationBusyChange?.(true);
		setBusy(true);
		setMessage("");
		setErrorCode(null);
		try {
			await operation();
		} catch (error) {
			setErrorCode(error instanceof PlayerRequestError ? error.code : null);
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			busyRef.current = false;
			onOperationBusyChange?.(false);
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
				onChange={(e) => update(e.target.value)}
			/>
		</label>
	);
	const reloadLatest = () => {
		if (
			busyRef.current ||
			!ready ||
			missing ||
			!(canStartOperation?.() ?? true)
		)
			return;
		if (
			!window.confirm(
				"最新データを再読込すると、未保存の変更は破棄されます。続行しますか？",
			)
		)
			return;
		void run(async () => {
			const latest = await request("get", {playerId: player.playerId});
			if (!latest) {
				setErrorCode("player_not_found");
				setMessage(
					"player_not_found: Playerが見つかりません。保存・削除はできません。",
				);
				return;
			}
			setPlayer(latest);
			setInput(structuredClone(latest));
			setErrorCode(null);
			setMessage("最新データを再読込しました");
			setConfirmDelete(false);
		});
	};
	return (
		<section aria-label='プレイヤーを編集'>
			<h2>{standalone ? "Playerを直接編集" : "プレイヤーを編集"}</h2>
			<p className='muted'>
				{resolveDisplayName(player)} · {player.playerId} · revision{" "}
				{player.revision}
			</p>
			{message && (
				<p
					role={conflict || missing ? "alert" : "status"}
					className='notice'
				>
					{message}
				</p>
			)}
			{conflict && (
				<button
					type='button'
					disabled={busy || !available}
					onClick={reloadLatest}
				>
					最新データを再読込
				</button>
			)}
			{deleted ? (
				<p role='status'>このPlayerを削除しました。</p>
			) : (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void run(async () => {
							const updated = await request("update", {
								playerId: player.playerId,
								revision: player.revision,
								input,
							});
							setInput(structuredClone(updated));
							setPlayer(updated);
							setConfirmDelete(false);
							setErrorCode(null);
							onUpdated(updated);
							setMessage("保存しました");
						});
					}}
				>
					<fieldset disabled={busy || !available}>
						{field("表示名", input.manualDisplayName ?? "", (v) =>
							setInput({...input, manualDisplayName: v || null}),
						)}
						<p className='muted'>使用する表示名: {resolveDisplayName(input)}</p>
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
						<SpeedrunUserSearch
							onSelect={(identity) =>
								setInput({...input, speedrunCom: identity})
							}
						/>
						<div className='toolbar'>
							<button
								className='primary'
								type='submit'
								disabled={busy || !available}
							>
								保存
							</button>
						</div>
						<div className='danger'>
							{confirmDelete ? (
								<>
									<span>このプレイヤーを削除しますか？</span>
									<button
										type='button'
										disabled={busy || !available}
										onClick={() =>
											void run(async () => {
												await request("delete", {
													playerId: player.playerId,
													revision: player.revision,
												});
												setDeleted(true);
												setMessage("削除しました");
												onDeleted(player.playerId);
											})
										}
									>
										削除を確定
									</button>
									<button
										type='button'
										disabled={busy}
										onClick={() => setConfirmDelete(false)}
									>
										キャンセル
									</button>
								</>
							) : (
								<button
									type='button'
									disabled={busy || !available}
									onClick={() => setConfirmDelete(true)}
								>
									プレイヤーを削除
								</button>
							)}
						</div>
					</fieldset>
				</form>
			)}
			{(!ready || missing) && !deleted && (
				<p
					role='alert'
					className='notice warning'
				>
					{missing
						? "Playerが存在しないため編集できません。"
						: "Directoryを利用できないため編集できません."}
				</p>
			)}
		</section>
	);
}
