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
import {ResolutionIssues} from "./ResolutionIssues.tsx";
import {ResolutionMatrix} from "./ResolutionMatrix.tsx";
import {
	isInputDirty,
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
		`player-manager.v2.${op}`,
		data,
	)) as Response<Operations[K]["response"]>;
	if (!response.ok)
		throw new Error(`${response.error.code}: ${response.error.message}`);
	return response.data;
}

function App() {
	const initialId =
		new URLSearchParams(window.location.search).get("registrationId") ?? "";
	const [registrationId, setRegistrationId] = useState(initialId);
	const [session, setSession] = useState<RegistrationSession | null>(null);
	const [draftInput, setDraftInput] = useState<MatchingInput>({});
	const [error, setError] = useState("");
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
	return (
		<main className='registration-page'>
			<header>
				<div>
					<p className='eyebrow'>PLAYER MANAGER</p>
					<h1>Player Registration</h1>
					<p>
						Account の所属、Evidence、Conflict を一つの Resolution
						で確認します。
					</p>
				</div>
			</header>
			{error && (
				<div
					className='notice'
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
				<section>
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
					<section>
						<h2>探索入力</h2>
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
						<label>
							新規Playerの表示名
							<input
								value={draftInput.manualDisplayName ?? ""}
								onChange={(event) =>
									update("manualDisplayName", event.target.value || null)
								}
							/>
						</label>
						<p className='muted'>
							この表示名は新規 Player に使用します。Existing Player の表示名は
							Account の割り当てを変更しても維持されます。
						</p>
						<p className='notice warning'>
							入力を変更して再探索すると、assignment、Conflict 承認、Candidate
							確認、Merge、削除選択がリセットされます。
						</p>
						{inputDirty && (
							<p
								className='notice warning'
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
								resolution={resolution}
								view={view}
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
								onSetUsage={(accountId, use) =>
									void run(() =>
										request("setRegistrationAccountUsage", {
											registrationId: registrationId,
											accountId,
											use,
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
							<section className='registration-actions'>
								<button
									className='primary'
									type='button'
									disabled={!resolution || inputDirty}
									onClick={() =>
										void run(async () => {
											await request("completeRegistration", {
												registrationId: registrationId,
											});
											const next = await request("getRegistration", {
												registrationId: registrationId,
											});
											return next ?? undefined;
										})
									}
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
		</main>
	);
}
render(<App />);
