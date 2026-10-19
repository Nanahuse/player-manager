import type {
	AccountRequest,
	FailureCode,
	Player,
	RegistrationSession,
	Response,
} from "@nanahuse/player-manager-protocol";
import {resolveDisplayName} from "@nanahuse/player-manager-protocol";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {Operations} from "../../../protocol/index.ts";
import {CandidateReview} from "./CandidateReview.tsx";
import {ConflictReview} from "./ConflictReview.tsx";
import {MergeProposalPanel} from "./MergeProposalPanel.tsx";
import {ProfileLink} from "./ProfileLink.tsx";
import {ResolutionIssues} from "./ResolutionIssues.tsx";
import {ResolutionMatrix} from "./ResolutionMatrix.tsx";
import {buildResolutionView, resolutionServices} from "./resolution-view.ts";
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

function editState(session: RegistrationSession | null) {
	if (!session?.resolution) return "";
	return JSON.stringify({
		requests: session.input.accountRequests ?? [],
		assignments: session.resolution.assignments
			.map(({accountId, ownerId, role}) => [accountId, ownerId, role])
			.sort(([a], [b]) => String(a).localeCompare(String(b))),
		discarded: [...session.resolution.discardedAccountIds].sort(),
		conflicts: session.resolution.conflicts.map(({id, status}) => [id, status]),
		confirmedCandidates: [
			...session.resolution.confirmedCandidateAccountIds,
		].sort(),
		merge: session.resolution.mergeDecision,
		deletePlayers: [...session.resolution.deletePlayerIds].sort(),
	});
}

export function PlayerEditor({
	initialPlayer,
	latestPlayer,
	ready,
	savedAccountIds,
	canStartOperation,
	onOperationBusyChange,
	onDirtyChange,
	onDeleted,
	standalone = false,
}: {
	initialPlayer: Player;
	latestPlayer: Player;
	ready: boolean;
	savedAccountIds: Set<string>;
	canStartOperation?: () => boolean;
	onOperationBusyChange?: (busy: boolean) => void;
	onDirtyChange?: (dirty: boolean) => void;
	onDeleted?: (playerId: string) => void;
	standalone?: boolean;
}) {
	const [player, setPlayer] = useState(initialPlayer);
	const [displayName, setDisplayName] = useState(
		initialPlayer.manualDisplayName ?? "",
	);
	const [session, setSession] = useState<RegistrationSession | null>(null);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const sessionRef = useRef<RegistrationSession | null>(null);
	const baselineRef = useRef("");
	const initKeyRef = useRef("");
	const failedInitKeyRef = useRef("");
	const pendingRegistrationIdRef = useRef<string | null>(null);
	const mountedRef = useRef(true);
	const [errorCode, setErrorCode] = useState<FailureCode | null>(null);
	const [externalUpdate, setExternalUpdate] = useState(false);
	const [active, setActive] = useState(true);
	const [service, setService] = useState<AccountRequest["service"]>("twitch");
	const [accountValue, setAccountValue] = useState("");
	const [mergeSurvivorId, setMergeSurvivorId] = useState("");
	const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
		null,
	);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [deleted, setDeleted] = useState(false);
	const [failedInitKey, setFailedInitKey] = useState("");
	const missing = errorCode === "player_not_found";
	const resolution = session?.resolution ?? null;
	const resolutionView = useMemo(
		() => (resolution ? buildResolutionView(resolution) : null),
		[resolution],
	);
	const targetView = resolutionView?.players.find(
		(entry) => entry.id === player.playerId,
	);
	const accountNames = new Map(
		resolution?.accounts.map((account) => [
			account.id,
			account.profile?.name,
		]) ?? [],
	);
	const displayNameDirty = displayName !== (player.manualDisplayName ?? "");
	const accountDirty = editState(session) !== baselineRef.current;
	const hasChanges =
		displayNameDirty || accountDirty || Boolean(accountValue.trim());
	useEffect(() => {
		onDirtyChange?.(hasChanges);
	}, [hasChanges, onDirtyChange]);
	const incomingIsNewer = latestPlayer.revision > player.revision;
	const unavailable =
		!ready || missing || externalUpdate || incomingIsNewer || busy;
	const blockers = resolution
		? [
				resolution.conflicts.some((item) => item.status !== "resolved"),
				Boolean(resolution.roleConflicts?.length),
				resolution.candidates.some(
					(item) =>
						!resolution.confirmedCandidateAccountIds.includes(
							item.originAccountId,
						),
				),
				resolution.errors.length > 0,
				resolution.requiredStatus.some((item) => !item.satisfied),
				Boolean(
					resolution.mergeProposal &&
						resolution.mergeDecision !== "keepSeparate",
				),
			]
		: [true];
	const hasBlockers = blockers.some(Boolean);
	const blockerReasons = resolution
		? [
				resolution.conflicts.some((item) => item.status !== "resolved") &&
					"Accountの所有者競合が未解決です。",
				Boolean(resolution.roleConflicts?.length) &&
					"Primaryの選択が必要です。",
				resolution.candidates.some(
					(item) =>
						!resolution.confirmedCandidateAccountIds.includes(
							item.originAccountId,
						),
				) && "検索候補の確認が必要です。",
				resolution.errors.length > 0 && "Account情報の取得に失敗しています。",
				resolution.requiredStatus.some((item) => !item.satisfied) &&
					"必須Accountが不足しています。",
				Boolean(
					resolution.mergeProposal &&
						resolution.mergeDecision !== "keepSeparate",
				) && "Playerの統合先を選択するか、統合しないことを確認してください。",
			].filter((reason): reason is string => Boolean(reason))
		: [];
	const currentInitKey = `${player.playerId}:${player.revision}`;
	const canSave =
		ready &&
		active &&
		!deleted &&
		session?.state === "pending" &&
		!busy &&
		!missing &&
		!externalUpdate &&
		!incomingIsNewer &&
		!hasBlockers &&
		!accountValue.trim();
	const resolutionDetailsRef = useRef<HTMLDetailsElement>(null);
	const run = useCallback(
		async <T,>(operation: () => Promise<T>): Promise<T | null> => {
			if (
				busyRef.current ||
				deleted ||
				!ready ||
				!(canStartOperation?.() ?? true)
			)
				return null;
			busyRef.current = true;
			onOperationBusyChange?.(true);
			setBusy(true);
			setMessage("");
			setErrorCode(null);
			try {
				return await operation();
			} catch (error) {
				setErrorCode(error instanceof PlayerRequestError ? error.code : null);
				setMessage(error instanceof Error ? error.message : String(error));
				return null;
			} finally {
				busyRef.current = false;
				onOperationBusyChange?.(false);
				setBusy(false);
			}
		},
		[ready, deleted, canStartOperation, onOperationBusyChange],
	);
	const applySession = useCallback((next: RegistrationSession) => {
		sessionRef.current = next;
		setSession(next);
		setMergeSurvivorId((current) =>
			next.resolution?.mergeProposal?.playerIds.includes(current)
				? current
				: "",
		);
	}, []);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			const current = sessionRef.current;
			if (current?.state === "pending")
				void request("cancelRegistration", {
					registrationId: current.registrationId,
				}).catch(() => {});
			const pendingRegistrationId = pendingRegistrationIdRef.current;
			if (pendingRegistrationId)
				void request("cancelRegistration", {
					registrationId: pendingRegistrationId,
				}).catch(() => {});
		};
	}, []);
	useEffect(() => {
		sessionRef.current = session;
	}, [session]);
	useEffect(() => {
		if (!active || !ready || session || deleted || busy) return;
		const key = currentInitKey;
		if (
			initKeyRef.current === key ||
			failedInitKey === key ||
			failedInitKeyRef.current === key
		)
			return;
		initKeyRef.current = key;
		void run(async () => {
			let registrationId = pendingRegistrationIdRef.current;
			let discardRegistrationId = false;
			try {
				if (!registrationId) {
					const created = await request("beginRegistration", {
						input: {},
						target: {
							playerId: player.playerId,
							expectedRevision: player.revision,
						},
					});
					registrationId = created.registrationId;
					pendingRegistrationIdRef.current = registrationId;
				}
				discardRegistrationId = true;
				const next = await request("getRegistration", {registrationId});
				if (
					!next ||
					next.registrationId !== registrationId ||
					next.state !== "pending" ||
					next.target?.playerId !== player.playerId ||
					next.target?.expectedRevision !== player.revision
				)
					throw new Error(
						"有効な編集セッションを取得できませんでした。再試行してください。",
					);
				discardRegistrationId = false;
				if (!mountedRef.current) {
					await request("cancelRegistration", {registrationId});
					pendingRegistrationIdRef.current = null;
					return next;
				}
				pendingRegistrationIdRef.current = null;
				failedInitKeyRef.current = "";
				setFailedInitKey("");
				baselineRef.current = editState(next);
				applySession(next);
				return next;
			} catch (error) {
				if (registrationId) {
					if (discardRegistrationId) pendingRegistrationIdRef.current = null;
					try {
						await request("cancelRegistration", {registrationId});
						if (!discardRegistrationId) pendingRegistrationIdRef.current = null;
					} catch {
						if (!discardRegistrationId)
							pendingRegistrationIdRef.current = registrationId;
					}
				}
				initKeyRef.current = "";
				failedInitKeyRef.current = key;
				setFailedInitKey(key);
				throw error;
			}
		});
	}, [
		active,
		ready,
		session,
		player.playerId,
		player.revision,
		currentInitKey,
		deleted,
		busy,
		failedInitKey,
		run,
		applySession,
	]);
	useEffect(() => {
		if (!incomingIsNewer || busy) return;
		setExternalUpdate(true);
		setMessage(
			"Directoryが外部で更新されました。編集中の内容を保持しています。最新データを再読込してください。",
		);
	}, [incomingIsNewer, busy]);
	const reloadLatest = () => {
		if (!ready || busyRef.current) return;
		if (
			hasChanges &&
			!window.confirm("未保存の変更を破棄して最新データを読み込みますか？")
		)
			return;
		void run(async () => {
			const current = sessionRef.current;
			if (current?.state === "pending")
				await request("cancelRegistration", {
					registrationId: current.registrationId,
				});
			const latest = incomingIsNewer
				? latestPlayer
				: await request("get", {playerId: player.playerId});
			if (!latest)
				throw new PlayerRequestError(
					"player_not_found",
					"Playerが見つかりません。",
				);
			baselineRef.current = "";
			sessionRef.current = null;
			setSession(null);
			setPlayer(latest);
			setDisplayName(latest.manualDisplayName ?? "");
			setExternalUpdate(false);
			setActive(true);
			initKeyRef.current = "";
			setMessage("最新データを再読込しました。");
		});
	};
	const cancelChanges = () => {
		if (!session) return;
		if (hasChanges && !window.confirm("未保存の変更を破棄しますか？")) return;
		void run(async () => {
			await request("cancelRegistration", {
				registrationId: session.registrationId,
			});
			baselineRef.current = "";
			sessionRef.current = null;
			setSession(null);
			setDisplayName(player.manualDisplayName ?? "");
			setActive(false);
			setMessage("変更を破棄しました。");
		});
	};
	const addAccount = () => {
		if (!session || !accountValue.trim()) return;
		const input = {
			...session.input,
			accountRequests: [
				...(session.input.accountRequests ?? []),
				{service, value: accountValue.trim()},
			],
		};
		void run(async () => {
			const next = await request("resolveRegistration", {
				registrationId: session.registrationId,
				input,
			});
			applySession(next);
			setAccountValue("");
			return next;
		});
	};
	const updateSession = (
		operation: keyof Operations,
		data: Record<string, unknown>,
	) => {
		if (!session) return;
		void run(async () => {
			const next = await request(
				operation as never,
				{
					registrationId: session.registrationId,
					...data,
				} as never,
			);
			applySession(next as RegistrationSession);
			return next;
		});
	};
	const save = () => {
		if (!canSave || !session) return;
		void run(async () => {
			let current = session;
			if (displayNameDirty)
				current = await request("setRegistrationDisplayName", {
					registrationId: session.registrationId,
					value: displayName || null,
				});
			const result = await request("completeRegistration", {
				registrationId: current.registrationId,
			});
			const updated = result.players.find(
				(entry) => entry.playerId === player.playerId,
			);
			if (updated) {
				setPlayer(updated);
				setDisplayName(updated.manualDisplayName ?? "");
			}
			baselineRef.current = "";
			sessionRef.current = null;
			setSession(null);
			setExternalUpdate(false);
			setActive(true);
			initKeyRef.current = "";
			setMessage("変更を保存しました。");
			return result;
		});
	};
	const retrySessionInitialization = () => {
		failedInitKeyRef.current = "";
		initKeyRef.current = "";
		setFailedInitKey("");
		setMessage("");
		setErrorCode(null);
	};
	const deletePlayer = () => {
		if (!confirmDelete) {
			setConfirmDelete(true);
			return;
		}
		if (
			hasChanges &&
			!window.confirm("未保存の変更を破棄してPlayerを削除しますか？")
		)
			return;
		void run(async () => {
			if (session?.state === "pending")
				await request("cancelRegistration", {
					registrationId: session.registrationId,
				});
			await request("delete", {
				playerId: player.playerId,
				revision: player.revision,
			});
			setDeleted(true);
			setActive(false);
			onDeleted?.(player.playerId);
			setMessage("削除しました。");
		});
	};
	const services = resolutionView?.services ?? resolutionServices;
	const targetAccounts =
		resolution && targetView
			? services.flatMap((entry) =>
					(targetView.cells[entry.id] ?? []).map((account) => ({
						service: entry,
						account,
					})),
				)
			: [];
	const unusedAccounts = resolutionView?.discardedAccounts ?? [];
	const otherOwners =
		resolution?.assignments.filter(
			(assignment) =>
				assignment.ownerId !== player.playerId &&
				!resolution.discardedAccountIds.includes(assignment.accountId),
		) ?? [];
	const displayIdentity = (accountId: string, fallback: string) =>
		accountNames.get(accountId) || fallback;
	return (
		<section
			aria-label='プレイヤーを編集'
			className='player-editor'
		>
			<h2>{standalone ? "Playerを編集" : "プレイヤーを編集"}</h2>
			<p className='muted'>
				{resolveDisplayName(player)} · {player.playerId} · revision{" "}
				{player.revision}
			</p>
			{message && (
				<p
					role={errorCode || externalUpdate ? "alert" : "status"}
					className='notice'
				>
					{message}
				</p>
			)}
			{failedInitKey === currentInitKey && !session && (
				<button
					type='button'
					disabled={busy || !ready}
					onClick={retrySessionInitialization}
				>
					再試行
				</button>
			)}
			{(externalUpdate || incomingIsNewer) && (
				<button
					type='button'
					disabled={busy || !ready}
					onClick={reloadLatest}
				>
					最新データを再読込
				</button>
			)}
			{deleted ? (
				<p role='status'>このPlayerを削除しました。</p>
			) : !active ? (
				<button
					type='button'
					disabled={!ready || busy}
					onClick={() => setActive(true)}
				>
					Account編集を開始
				</button>
			) : (
				<>
					<label className='player-display-name'>
						表示名
						<input
							value={displayName}
							disabled={unavailable}
							onChange={(event) => setDisplayName(event.target.value)}
						/>
					</label>
					<section aria-label='Account一覧'>
						<div className='account-heading'>
							<h3>Account</h3>
						</div>
						{services.map((entry) => {
							const rows = targetAccounts.filter(
								(item) => item.service.id === entry.id,
							);
							if (!rows.length) return null;
							return (
								<section
									className='account-service'
									key={entry.id}
								>
									<h4>{entry.label}</h4>
									{rows.map(({account}) => (
										<article
											className='account-row'
											key={account.accountId}
										>
											<div>
												<strong>
													<ProfileLink
														profileUrl={account.profileUrl}
														speedrunUserId={account.speedrunUserId}
														accountId={
															savedAccountIds.has(account.accountId)
																? account.accountId
																: null
														}
													>
														{displayIdentity(account.accountId, account.label)}
													</ProfileLink>
												</strong>
												{account.profileName &&
													account.profileName !== account.label && (
														<small>{account.label}</small>
													)}
												<span className='state-badge'>
													{account.role === "primary" ? "Primary" : "Sub"}
												</span>
												{account.roleConflict && (
													<span className='state-badge danger-badge'>
														Primaryを選択してください
													</span>
												)}
												{account.states.includes("Conflict") && (
													<span className='state-badge danger-badge'>
														競合を確認してください
													</span>
												)}
											</div>
											<div className='toolbar'>
												<button
													type='button'
													disabled={unavailable || account.role === "primary"}
													onClick={() =>
														updateSession("setRegistrationAccountPrimary", {
															accountId: account.accountId,
														})
													}
												>
													Primaryにする
												</button>
												<button
													type='button'
													disabled={unavailable}
													onClick={() =>
														updateSession("setRegistrationAccountUsage", {
															accountId: account.accountId,
															use: false,
														})
													}
												>
													使用しない
												</button>
											</div>
											<details>
												<summary>Account詳細</summary>
												<small>ID: {account.accountId}</small>
											</details>
										</article>
									))}
									{resolution?.roleConflicts?.some(
										(conflict) =>
											conflict.ownerId === player.playerId &&
											conflict.service === entry.id,
									) && (
										<p className='notice warning'>
											Primaryを選択してください。
										</p>
									)}
								</section>
							);
						})}
						{targetAccounts.length === 0 && (
							<p className='muted'>Accountはありません。</p>
						)}
						{unusedAccounts.length > 0 && (
							<section className='unused-accounts'>
								<h4>使用しない</h4>
								{unusedAccounts.map((account) => (
									<div
										className='account-row'
										key={account.accountId}
									>
										<span>
											{account.service}:{" "}
											<ProfileLink
												profileUrl={account.profileUrl}
												speedrunUserId={account.speedrunUserId}
												accountId={
													savedAccountIds.has(account.accountId)
														? account.accountId
														: null
												}
											>
												{displayIdentity(account.accountId, account.label)}
											</ProfileLink>
										</span>
										<button
											type='button'
											disabled={unavailable}
											onClick={() =>
												updateSession("setRegistrationAccountUsage", {
													accountId: account.accountId,
													use: true,
												})
											}
										>
											復元
										</button>
									</div>
								))}
							</section>
						)}
					</section>
					<section aria-label='Accountを追加'>
						<h3>Accountを追加</h3>
						<div className='account-add-form'>
							<label>
								サービス
								<select
									value={service}
									disabled={unavailable}
									onChange={(event) =>
										setService(event.target.value as AccountRequest["service"])
									}
								>
									<option value='racetime'>RaceTime</option>
									<option value='speedrunCom'>Speedrun.com</option>
									<option value='twitch'>Twitch</option>
									<option value='youtube'>YouTube</option>
									<option value='profileUrl'>その他のプロフィールURL</option>
								</select>
							</label>
							<label>
								ID / login / URL
								<input
									value={accountValue}
									disabled={unavailable}
									onChange={(event) => setAccountValue(event.target.value)}
								/>
								{accountValue.trim() && (
									<small role='status'>
										Accountを追加してください。入力中の値はまだ保存されていません。
									</small>
								)}
							</label>
							<button
								type='button'
								disabled={unavailable || !accountValue.trim() || !session}
								onClick={addAccount}
							>
								追加
							</button>
						</div>
					</section>
					{otherOwners.length > 0 && (
						<p className='notice warning'>
							別Playerが所有するAccountがあります。自動では移動しません。詳細の「競合を解決」から割り当てを確認してください。
						</p>
					)}
					{resolution?.errors.map((error) => (
						<p
							role='alert'
							className='notice warning'
							key={error}
						>
							外部情報を取得できませんでした: {error}
						</p>
					))}
					{resolution?.warnings.map((warning) => (
						<p
							className='notice warning'
							key={warning.operation}
						>
							{warning.message}
						</p>
					))}
					{hasBlockers && (
						<div
							className='notice warning'
							role='status'
						>
							保存できません。
							<ul>
								{blockerReasons.map((reason) => (
									<li key={reason}>{reason}</li>
								))}
							</ul>
							<button
								type='button'
								disabled={busy || !resolution}
								onClick={() => {
									if (resolutionDetailsRef.current)
										resolutionDetailsRef.current.open = true;
								}}
							>
								競合・確認事項を開く
							</button>
						</div>
					)}
					{accountValue.trim() && (
						<p
							className='notice warning'
							role='status'
						>
							未追加のAccount入力があります。保存するには「追加」するか、入力を消してください。
						</p>
					)}
					{resolution && (
						<details
							className='resolution-details'
							ref={resolutionDetailsRef}
						>
							<summary>
								競合を解決{hasBlockers ? " · 確認が必要" : " · 詳細"}
							</summary>
							<ResolutionIssues
								resolution={resolution}
								view={resolutionView!}
							/>
							<ResolutionMatrix
								showEvidence={false}
								view={resolutionView!}
								selectedAccountId={selectedAccountId}
								onSelectAccount={setSelectedAccountId}
								onAssign={(accountId, ownerId) =>
									updateSession("assignRegistrationAccount", {
										accountId,
										ownerId,
									})
								}
								onDiscard={(accountId) =>
									updateSession("setRegistrationAccountUsage", {
										accountId,
										use: false,
									})
								}
								onSetPrimary={(accountId) =>
									updateSession("setRegistrationAccountPrimary", {accountId})
								}
								onToggleDeletion={(playerId, shouldDelete) =>
									updateSession("setRegistrationPlayerDeletion", {
										playerId,
										delete: shouldDelete,
									})
								}
							/>
							<ConflictReview
								showEvidence={false}
								resolution={resolution}
								view={resolutionView!}
								onApprove={(conflictId) =>
									updateSession("approveRegistrationConflict", {conflictId})
								}
							/>
							<CandidateReview
								resolution={resolution}
								view={resolutionView!}
								onConfirm={(accountId, ownerId) =>
									updateSession("assignRegistrationAccount", {
										accountId,
										ownerId,
									})
								}
							/>
							<MergeProposalPanel
								resolution={resolution}
								view={resolutionView!}
								selectedSurvivor={mergeSurvivorId}
								onSelect={setMergeSurvivorId}
								onApply={() =>
									updateSession("selectRegistrationMergeSurvivor", {
										survivorId: mergeSurvivorId,
									})
								}
								onKeepSeparate={() =>
									updateSession("setRegistrationMergeDecision", {
										decision: "keepSeparate",
									})
								}
							/>
						</details>
					)}
					<div className='toolbar account-edit-actions'>
						<button
							type='button'
							disabled={!canSave}
							onClick={save}
						>
							変更を保存
						</button>
						<button
							type='button'
							disabled={busy || !session}
							onClick={cancelChanges}
						>
							変更を破棄
						</button>
					</div>
					<div className='danger'>
						{confirmDelete && <span>このPlayerを削除しますか？</span>}
						<button
							type='button'
							disabled={unavailable}
							onClick={deletePlayer}
						>
							{confirmDelete ? "削除を確定" : "Playerを削除"}
						</button>
						{confirmDelete && (
							<button
								type='button'
								disabled={busy}
								onClick={() => setConfirmDelete(false)}
							>
								キャンセル
							</button>
						)}
					</div>
				</>
			)}
			{(!ready || missing) && !deleted && (
				<p
					role='alert'
					className='notice warning'
				>
					{missing
						? "Playerが存在しないため編集できません。"
						: "Directoryを利用できないため編集できません。"}
				</p>
			)}
		</section>
	);
}
