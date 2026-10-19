import {
	type MatchingInput,
	type RegistrationSession,
	type Response,
	resolveDisplayName,
} from "@nanahuse/player-manager-protocol";
import {useEffect, useMemo, useRef, useState} from "react";
import type {Operations} from "../../../protocol/index.ts";
import {render} from "../../render";
import {CandidateReview} from "./CandidateReview.tsx";
import {ConflictReview} from "./ConflictReview.tsx";
import {MergeProposalPanel} from "./MergeProposalPanel.tsx";
import {NameOnlyConfirmation} from "./NameOnlyConfirmation.tsx";
import {PageHeader} from "./PageHeader.tsx";
import {ResolutionIssues} from "./ResolutionIssues.tsx";
import {ResolutionMatrix} from "./ResolutionMatrix.tsx";
import {
	isInputDirty,
	newPlayerRegistration,
	nextMergeSurvivorSelection,
} from "./registration-state.ts";
import {buildResolutionView} from "./resolution-view.ts";
import {SpeedrunUserSearch} from "./SpeedrunUserSearch.tsx";
import "../player-mapping.css";

async function request<K extends keyof Operations>(
	op: K,
	data: Operations[K]["request"],
): Promise<Operations[K]["response"]> {
	const response = (await nodecg.sendMessage(
		`player-manager.v3.${op}`,
		data,
	)) as Response<Operations[K]["response"]>;
	if (!response.ok)
		throw new Error(`${response.error.code}: ${response.error.message}`);
	return response.data;
}

export function App() {
	const initialId =
		new URLSearchParams(window.location.search).get("registrationId") ?? "";
	const [registrationId, setRegistrationId] = useState(initialId);
	const [session, setSession] = useState<RegistrationSession | null>(null);
	const [draftInput, setDraftInput] = useState<MatchingInput>({});
	const [targetDisplayName, setTargetDisplayName] = useState("");
	const [profileAccountDraft, setProfileAccountDraft] = useState("");
	const [error, setError] = useState("");
	const [confirmNameOnly, setConfirmNameOnly] = useState(false);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const initializationRef = useRef<Promise<RegistrationSession> | null>(null);
	const [retryInitialization, setRetryInitialization] = useState(0);
	const initializationRetryRef = useRef(retryInitialization);
	const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
		null,
	);
	const [mergeSurvivorId, setMergeSurvivorId] = useState("");
	const resolution = session?.resolution ?? null;
	const inputDirty = session ? isInputDirty(draftInput, session.input) : false;
	const view = useMemo(
		() => (resolution ? buildResolutionView(resolution) : null),
		[resolution],
	);
	useEffect(() => {
		if (initializationRetryRef.current !== retryInitialization) {
			initializationRetryRef.current = retryInitialization;
			initializationRef.current = null;
		}
		let active = true;
		const initialize = async () => {
			const knownId = initialId || registrationId;
			if (knownId) {
				const value = await request("getRegistration", {
					registrationId: knownId,
				});
				if (!value) throw new Error("登録セッションが見つかりません。");
				return value;
			}
			const created = await request("beginRegistration", {
				input: {},
				createPlayerOnEmpty: true,
			});
			const url = new URL(window.location.href);
			url.searchParams.set("registrationId", created.registrationId);
			window.history.replaceState(null, "", url.toString());
			setRegistrationId(created.registrationId);
			const value = await request("getRegistration", {
				registrationId: created.registrationId,
			});
			if (!value) throw new Error("登録セッションが見つかりません。");
			return value;
		};
		initializationRef.current ??= initialize();
		void initializationRef.current
			.then((value) => {
				if (active) {
					setSession(value);
					setDraftInput(value.input);
					const targetPlayer = value.resolution?.players.find(
						(player) => player.id === value.target?.playerId,
					);
					setTargetDisplayName(
						value.displayNameChange
							? (value.displayNameChange.value ?? "")
							: targetPlayer?.kind === "existing"
								? (targetPlayer.player.manualDisplayName ?? "")
								: "",
					);
				}
			})
			.catch((cause) => {
				if (active) {
					setError(cause instanceof Error ? cause.message : String(cause));
					initializationRef.current = null;
				}
			});
		return () => {
			active = false;
		};
	}, [initialId, registrationId, retryInitialization]);
	const apply = (value: RegistrationSession, syncDraftInput = false) => {
		setSession(value);
		if (syncDraftInput) setDraftInput(value.input);
		if (value.target) {
			const targetPlayer = value.resolution?.players.find(
				(player) => player.id === value.target?.playerId,
			);
			setTargetDisplayName(
				value.displayNameChange
					? (value.displayNameChange.value ?? "")
					: targetPlayer?.kind === "existing"
						? (targetPlayer.player.manualDisplayName ?? "")
						: "",
			);
		}
		if (
			selectedAccountId &&
			!value.resolution?.accounts.some(
				(account) => account.id === selectedAccountId,
			)
		)
			setSelectedAccountId(null);
		setMergeSurvivorId((current) =>
			nextMergeSurvivorSelection(
				current,
				value.resolution?.mergeProposal ?? null,
			),
		);
	};
	const run = async (
		action: () => Promise<RegistrationSession | undefined>,
		syncDraftInput = false,
	) => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setError("");
		try {
			const next = await action();
			if (next) apply(next, syncDraftInput);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};
	const update = <K extends keyof MatchingInput>(
		key: K,
		value: MatchingInput[K],
	) => setDraftInput((current) => ({...current, [key]: value}));
	const targetPlayer = session?.target
		? resolution?.players.find(
				(player) => player.id === session.target?.playerId,
			)
		: undefined;
	const targetNameCommitted = session?.target
		? session.displayNameChange
			? (session.displayNameChange.value ?? "") === targetDisplayName
			: targetPlayer?.kind !== "existing" ||
				targetPlayer.player.manualDisplayName === (targetDisplayName || null)
		: true;
	const newPlayer =
		resolution && !session?.target
			? newPlayerRegistration(resolution, draftInput.manualDisplayName ?? "")
			: null;
	const save = () => {
		if (
			!session ||
			!resolution ||
			inputDirty ||
			!targetNameCommitted ||
			newPlayer?.empty
		)
			return;
		setConfirmNameOnly(false);
		void run(async () => {
			if (
				!session.target &&
				(draftInput.manualDisplayName ?? null) !==
					(session.input.manualDisplayName ?? null)
			) {
				const updated = await request("resolveRegistration", {
					registrationId,
					input: {
						...session.input,
						manualDisplayName: draftInput.manualDisplayName?.trim() || null,
					},
				});
				apply(updated);
			}
			await request("completeRegistration", {registrationId});
			return (await request("getRegistration", {registrationId})) ?? undefined;
		});
	};

	return (
		<main className='registration-page'>
			<PageHeader
				title={
					session?.target ? "既存PlayerのAccount編集" : "Player Registration"
				}
			/>
			{error && (
				<div
					className='callout error'
					role='alert'
				>
					{error}
				</div>
			)}
			{!session && error && (
				<button
					type='button'
					onClick={() => {
						setError("");
						setRetryInitialization((value) => value + 1);
					}}
				>
					初期化を再試行
				</button>
			)}
			{!session && !error && <p role='status'>Registrationを準備しています…</p>}
			{session?.state === "completed" && (
				<section className='panel'>
					<h2>登録が完了しました</h2>
					<p>{session.result?.players.map(resolveDisplayName).join(", ")}</p>
					<p>Directory revision: {session.result?.directoryRevision}</p>
					<button
						type='button'
						onClick={() => window.close()}
					>
						閉じる
					</button>
				</section>
			)}
			{session?.state === "pending" && (
				<fieldset
					disabled={busy}
					className='registration-controls'
				>
					{session.target && (
						<section
							className='panel'
							aria-label='編集対象Player'
						>
							<h2>編集中のPlayer</h2>
							<p>
								{targetPlayer?.kind === "existing"
									? resolveDisplayName(targetPlayer.player)
									: session.target.playerId}
								· {session.target.playerId} · revision{" "}
								{session.target.expectedRevision}
							</p>
							<p className='muted'>
								既存Accountを含む一覧で追加先とPrimary/Subを確認し、保存してください。
							</p>
						</section>
					)}
					<section className='panel'>
						<h2>探索入力</h2>
						<div className='exploration-inputs'>
							<label>
								RaceTime ID / URL
								<input
									value={draftInput.racetime ?? ""}
									onChange={(event) =>
										update("racetime", event.target.value || null)
									}
								/>
							</label>
							<label>
								Speedrun.com ID / URL
								<input
									value={draftInput.speedrunCom ?? ""}
									onChange={(event) =>
										update("speedrunCom", event.target.value || null)
									}
								/>
							</label>
							<SpeedrunUserSearch
								onSelect={(identity) => update("speedrunCom", identity.userId)}
							/>
							<label>
								Twitch login
								<input
									value={draftInput.twitch?.login ?? ""}
									onChange={(event) =>
										update(
											"twitch",
											event.target.value ? {login: event.target.value} : null,
										)
									}
								/>
							</label>
							<label>
								YouTube URL / handle
								<input
									value={draftInput.youtube ?? ""}
									onChange={(event) =>
										update("youtube", event.target.value || null)
									}
								/>
							</label>
						</div>
						<section className='subpanel profile-accounts'>
							<h3>その他のプロフィールURL</h3>
							<p className='muted'>
								対応サービスのURLは同じMatching
								Engineで照合します。それ以外はURLだけで登録します。
							</p>
							{(draftInput.profileAccounts ?? []).map((url) => (
								<div key={url}>
									<span>{url}</span>
									<button
										type='button'
										onClick={() =>
											update(
												"profileAccounts",
												(draftInput.profileAccounts ?? []).filter(
													(item) => item !== url,
												),
											)
										}
									>
										削除
									</button>
								</div>
							))}
							<label>
								プロフィールURL
								<input
									value={profileAccountDraft}
									onChange={(event) =>
										setProfileAccountDraft(event.target.value)
									}
								/>
							</label>
							<button
								type='button'
								disabled={!profileAccountDraft.trim()}
								onClick={() => {
									const url = profileAccountDraft.trim();
									update("profileAccounts", [
										...(draftInput.profileAccounts ?? []),
										url,
									]);
									setProfileAccountDraft("");
								}}
							>
								追加
							</button>
						</section>
						{session.target && (
							<section className='subpanel'>
								<h3>表示名</h3>
								<label>
									Playerの表示名
									<input
										value={targetDisplayName}
										onChange={(event) =>
											setTargetDisplayName(event.target.value)
										}
									/>
								</label>
								<button
									type='button'
									disabled={targetNameCommitted}
									onClick={() =>
										void run(() =>
											request("setRegistrationDisplayName", {
												registrationId,
												value: targetDisplayName || null,
											}),
										)
									}
								>
									表示名を反映
								</button>
							</section>
						)}
						<p className='muted'>
							再探索で Matching 情報を更新します。有効な割り当てや Primary
							選択は保持され、再利用できない操作は破棄されます。
						</p>
						{inputDirty && (
							<p
								className='callout warning'
								role='status'
							>
								入力に未反映の変更があります。入力を再探索してから保存してください。
							</p>
						)}
						<div className='toolbar'>
							<button
								type='button'
								onClick={() =>
									void run(
										() =>
											request("resolveRegistration", {
												registrationId: registrationId,
												input: draftInput,
											}),
										true,
									)
								}
							>
								入力を再探索
							</button>
							{resolution && (
								<button
									type='button'
									onClick={() =>
										void run(() =>
											request("resolveRegistration", {
												registrationId: registrationId,
												input: session.input,
											}),
										)
									}
								>
									割り当てを初期状態に戻す
								</button>
							)}
						</div>
					</section>
					{resolution && view && (
						<>
							<ResolutionIssues
								resolution={resolution}
								view={view}
							/>
							<ResolutionMatrix
								view={view}
								showEvidence={!session.target}
								manualDisplayName={
									session.target
										? undefined
										: (draftInput.manualDisplayName ?? "")
								}
								onDisplayNameChange={
									session.target
										? undefined
										: (value) => update("manualDisplayName", value || null)
								}
								selectedAccountId={selectedAccountId}
								onSelectAccount={setSelectedAccountId}
								onAssign={(accountId, ownerId) =>
									void run(() =>
										request("assignRegistrationAccount", {
											registrationId: registrationId,
											accountId,
											ownerId,
										}),
									)
								}
								onDiscard={(accountId) =>
									void run(() =>
										request("setRegistrationAccountUsage", {
											registrationId: registrationId,
											accountId,
											use: false,
										}),
									)
								}
								onSetPrimary={(accountId) =>
									void run(() =>
										request("setRegistrationAccountPrimary", {
											registrationId,
											accountId,
										}),
									)
								}
								onToggleDeletion={(playerId, shouldDelete) =>
									void run(() =>
										request("setRegistrationPlayerDeletion", {
											registrationId: registrationId,
											playerId,
											delete: shouldDelete,
										}),
									)
								}
							/>
							<ConflictReview
								showEvidence={!session.target}
								resolution={resolution}
								view={view}
								onApprove={(conflictId) =>
									void run(() =>
										request("approveRegistrationConflict", {
											registrationId: registrationId,
											conflictId,
										}),
									)
								}
							/>
							<CandidateReview
								resolution={resolution}
								view={view}
								onConfirm={(accountId, ownerId) =>
									void run(() =>
										request("assignRegistrationAccount", {
											registrationId: registrationId,
											accountId,
											ownerId,
										}),
									)
								}
							/>
							<MergeProposalPanel
								resolution={resolution}
								view={view}
								selectedSurvivor={mergeSurvivorId}
								onSelect={setMergeSurvivorId}
								onApply={() =>
									void run(() =>
										request("selectRegistrationMergeSurvivor", {
											registrationId: registrationId,
											survivorId: mergeSurvivorId,
										}),
									)
								}
								onKeepSeparate={() =>
									void run(() =>
										request("setRegistrationMergeDecision", {
											registrationId: registrationId,
											decision: "keepSeparate",
										}),
									)
								}
							/>
							<section className='panel registration-actions'>
								<button
									className='primary'
									type='button'
									disabled={
										!resolution ||
										inputDirty ||
										!targetNameCommitted ||
										Boolean(newPlayer?.empty)
									}
									onClick={() => {
										if (newPlayer?.needsConfirmation) setConfirmNameOnly(true);
										else save();
									}}
								>
									この内容で保存
								</button>
								<button
									type='button'
									onClick={() =>
										void run(() =>
											request("cancelRegistration", {
												registrationId: registrationId,
											}),
										)
									}
								>
									キャンセル
								</button>
							</section>
						</>
					)}
				</fieldset>
			)}
			{confirmNameOnly && (
				<NameOnlyConfirmation
					name={draftInput.manualDisplayName?.trim() ?? ""}
					onBack={() => setConfirmNameOnly(false)}
					onConfirm={save}
				/>
			)}
		</main>
	);
}
render(<App />);
