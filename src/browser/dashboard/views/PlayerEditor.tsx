import type {
	FailureCode,
	Player,
	Response,
} from "@nanahuse/player-manager-protocol";
import {resolveDisplayName} from "@nanahuse/player-manager-protocol";
import {useEffect, useRef, useState} from "react";
import type {Operations} from "../../../protocol/index.ts";

async function request<K extends keyof Operations>(
	operation: K,
	data: Operations[K]["request"],
): Promise<Operations[K]["response"]> {
	const response = (await nodecg.sendMessage(
		`player-manager.v3.${operation}`,
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

export function PlayerEditor({
	initialPlayer,
	latestPlayer,
	ready,
	canStartOperation,
	onOperationBusyChange,
	onDeleted,
	standalone = false,
}: {
	initialPlayer: Player;
	latestPlayer: Player;
	ready: boolean;
	canStartOperation?: () => boolean;
	onOperationBusyChange?: (busy: boolean) => void;
	onDeleted?: (playerId: string) => void;
	standalone?: boolean;
}) {
	const [player, setPlayer] = useState(initialPlayer);
	const [displayName, setDisplayName] = useState(
		initialPlayer.manualDisplayName ?? "",
	);
	const [message, setMessage] = useState("");
	const [registrationUrl, setRegistrationUrl] = useState("");
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const [errorCode, setErrorCode] = useState<FailureCode | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [deleted, setDeleted] = useState(false);
	const [externalUpdate, setExternalUpdate] = useState(false);
	const missing = errorCode === "player_not_found";
	const conflict = errorCode === "player_changed";
	const incomingIsNewer = latestPlayer.revision > player.revision;
	const hasUnsavedName = displayName !== (player.manualDisplayName ?? "");
	const updateRequired = externalUpdate || incomingIsNewer;
	const available =
		ready &&
		!missing &&
		!conflict &&
		!updateRequired &&
		(canStartOperation?.() ?? true);
	useEffect(() => {
		if (
			latestPlayer.playerId !== player.playerId ||
			latestPlayer.revision <= player.revision ||
			busyRef.current
		)
			return;
		setPlayer(latestPlayer);
		setConfirmDelete(false);
		setErrorCode(null);
		if (hasUnsavedName) {
			setExternalUpdate(true);
			setMessage(
				"Directoryが外部で更新されました。入力中の表示名は保持しています。最新データを再読込してください。",
			);
		} else {
			setDisplayName(latestPlayer.manualDisplayName ?? "");
			setExternalUpdate(false);
			setMessage("最新のDirectory情報に同期しました。");
		}
	}, [latestPlayer, player.playerId, player.revision, hasUnsavedName]);
	const run = async (
		operation: () => Promise<void>,
		allowUpdateRequired = false,
	) => {
		if (
			busyRef.current ||
			deleted ||
			!ready ||
			missing ||
			(conflict && !allowUpdateRequired) ||
			(updateRequired && !allowUpdateRequired) ||
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
	const reloadLatest = () => {
		if (
			busyRef.current ||
			!ready ||
			missing ||
			!(canStartOperation?.() ?? true)
		)
			return;
		if (
			hasUnsavedName &&
			!window.confirm(
				"最新データを再読込すると、未保存の変更は破棄されます。続行しますか？",
			)
		)
			return;
		void run(async () => {
			let latest: Player | null;
			try {
				latest =
					externalUpdate || latestPlayer.revision > player.revision
						? latestPlayer
						: await request("get", {playerId: player.playerId});
			} catch (error) {
				if (
					error instanceof PlayerRequestError &&
					error.code === "player_not_found"
				) {
					setErrorCode("player_not_found");
					setMessage(`${error.message} 保存・削除はできません。`);
				} else {
					setErrorCode("player_changed");
					setMessage(
						`最新データを再読込できませんでした: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return;
			}
			if (!latest) {
				setErrorCode("player_not_found");
				setMessage("Playerが見つかりません。保存・削除はできません。");
				return;
			}
			setPlayer(latest);
			setDisplayName(latest.manualDisplayName ?? "");
			setRegistrationUrl("");
			setExternalUpdate(false);
			setErrorCode(null);
			setMessage("最新データを再読込しました");
			setConfirmDelete(false);
		}, true);
	};
	const accountText = (account: NonNullable<Player["accounts"]>[number]) => {
		if (account.profileUrl) return account.profileUrl;
		if (typeof account.identity === "string") return account.identity;
		if ("login" in account.identity) return account.identity.login;
		return account.identity.userId;
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
			{(updateRequired || conflict) && (
				<button
					type='button'
					disabled={
						busy || !ready || missing || !(canStartOperation?.() ?? true)
					}
					onClick={reloadLatest}
				>
					最新データを再読込
				</button>
			)}
			{registrationUrl && (
				<p>
					<a
						href={registrationUrl}
						target='_blank'
						rel='noopener noreferrer'
					>
						RegistrationでAccountを編集
					</a>
				</p>
			)}
			{deleted ? (
				<p role='status'>このPlayerを削除しました。</p>
			) : (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void run(async () => {
							const updated = await request("update", {
								playerId: player.playerId,
								revision: player.revision,
								input: {manualDisplayName: displayName || null},
							});
							setPlayer(updated);
							setDisplayName(updated.manualDisplayName ?? "");
							setExternalUpdate(false);
							setConfirmDelete(false);
							setMessage("保存しました");
						});
					}}
				>
					<fieldset disabled={busy || !available}>
						<label>
							表示名
							<input
								value={displayName}
								onChange={(event) => setDisplayName(event.target.value)}
							/>
						</label>
						<p className='muted'>
							使用する表示名:{" "}
							{resolveDisplayName({
								...player,
								manualDisplayName: displayName || null,
							})}
						</p>
						<section aria-label='登録済みアカウント'>
							<h3>Account</h3>
							{(player.accounts ?? []).length === 0 ? (
								<p className='muted'>登録されたAccountはありません。</p>
							) : (
								(player.accounts ?? []).map((account) => (
									<div key={account.id}>
										<strong>{account.service}</strong>
										<span>{accountText(account)}</span>
										<span className='state-badge'>
											{account.role === "primary" ? "Primary" : "Sub"}
										</span>
									</div>
								))
							)}
						</section>
						<div className='toolbar'>
							<button
								type='button'
								disabled={busy || !available}
								onClick={() =>
									void run(async () => {
										const created = await request("beginRegistration", {
											input: {},
											target: {
												playerId: player.playerId,
												expectedRevision: player.revision,
											},
										});
										setRegistrationUrl(created.url);
										setMessage("RegistrationでAccountを編集できます。");
									})
								}
							>
								アカウントを編集
							</button>
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
												onDeleted?.(player.playerId);
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
