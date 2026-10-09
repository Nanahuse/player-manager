import {
	type MatchingInput,
	type RegistrationSession,
	type Response,
	resolveDisplayName,
} from "@nanahuse/player-manager-protocol";
import {useEffect, useMemo, useState} from "react";
import type {Operations} from "../../../protocol/index.ts";
import {render} from "../../render";
import {CandidateReview} from "./CandidateReview.tsx";
import {ConflictReview} from "./ConflictReview.tsx";
import {MergeProposalPanel} from "./MergeProposalPanel.tsx";
import {ResolutionIssues} from "./ResolutionIssues.tsx";
import {ResolutionMatrix} from "./ResolutionMatrix.tsx";
import {buildResolutionView} from "./resolution-view.ts";
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
	const id =
		new URLSearchParams(window.location.search).get("registrationId") ?? "";
	const [session, setSession] = useState<RegistrationSession | null>(null);
	const [input, setInput] = useState<MatchingInput>({});
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
		null,
	);
	const [mergeSurvivorId, setMergeSurvivorId] = useState("");
	const resolution = session?.resolution ?? null;
	const view = useMemo(
		() => (resolution ? buildResolutionView(resolution) : null),
		[resolution],
	);
	useEffect(() => {
		let active = true;
		void request("getRegistration", {registrationId: id})
			.then((value) => {
				if (!value) throw new Error("登録セッションが見つかりません。");
				if (active) {
					setSession(value);
					setInput(value.input);
				}
			})
			.catch((cause) => {
				if (active)
					setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			active = false;
		};
	}, [id]);
	const apply = (value: RegistrationSession) => {
		setSession(value);
		setInput(value.input);
		if (
			selectedAccountId &&
			!value.resolution?.accounts.some(
				(account) => account.id === selectedAccountId,
			)
		)
			setSelectedAccountId(null);
		if (
			value.resolution?.mergeProposal &&
			!value.resolution.mergeProposal.playerIds.includes(mergeSurvivorId)
		)
			setMergeSurvivorId(value.resolution.mergeProposal.playerIds[0] ?? "");
		if (!value.resolution?.mergeProposal) setMergeSurvivorId("");
	};
	const run = async (
		action: () => Promise<RegistrationSession | undefined>,
	) => {
		setBusy(true);
		setError("");
		try {
			const next = await action();
			if (next) apply(next);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};
	const update = <K extends keyof MatchingInput>(
		key: K,
		value: MatchingInput[K],
	) => setInput((current) => ({...current, [key]: value}));
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
			{session?.state === "completed" && (
				<section>
					<h2>登録が完了しました</h2>
					<p>{session.result?.players.map(resolveDisplayName).join(", ")}</p>
					<p>Directory revision: {session.result?.directoryRevision}</p>
				</section>
			)}
			{session?.state === "pending" && (
				<>
					<section>
						<h2>探索入力</h2>
						<fieldset disabled={busy}>
							<label>
								RaceTime ID / URL
								<input
									value={input.racetime ?? ""}
									onChange={(event) =>
										update("racetime", event.target.value || null)
									}
								/>
							</label>
							<label>
								Speedrun.com ID / URL
								<input
									value={input.speedrunCom ?? ""}
									onChange={(event) =>
										update("speedrunCom", event.target.value || null)
									}
								/>
							</label>
							<label>
								Twitch login
								<input
									value={input.twitch?.login ?? ""}
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
									value={input.youtube ?? ""}
									onChange={(event) =>
										update("youtube", event.target.value || null)
									}
								/>
							</label>
							<label>
								新規Playerの表示名
								<input
									value={input.manualDisplayName ?? ""}
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
							<div className='toolbar'>
								<button
									type='button'
									onClick={() =>
										void run(() =>
											request("resolveRegistration", {
												registrationId: id,
												input,
											}),
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
													registrationId: id,
													input: session.input,
												}),
											)
										}
									>
										割り当てを初期状態に戻す
									</button>
								)}
							</div>
						</fieldset>
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
											registrationId: id,
											accountId,
											ownerId,
										}),
									)
								}
								onToggleDeletion={(playerId, shouldDelete) =>
									void run(() =>
										request("setRegistrationPlayerDeletion", {
											registrationId: id,
											playerId,
											delete: shouldDelete,
										}),
									)
								}
							/>
							{resolution.requiredStatus.some((item) => !item.satisfied) && (
								<section>
									<h2>未解決の Required Account</h2>
									<ul>
										{resolution.requiredStatus
											.filter((item) => !item.satisfied)
											.map((item) => (
												<li key={item.accountId}>{item.accountId} — 未解決</li>
											))}
									</ul>
								</section>
							)}
							<ConflictReview
								resolution={resolution}
								view={view}
								onApprove={(conflictId) =>
									void run(() =>
										request("approveRegistrationConflict", {
											registrationId: id,
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
											registrationId: id,
											accountId,
											ownerId,
										}),
									)
								}
							/>
							<MergeProposalPanel
								resolution={resolution}
								selectedSurvivor={
									mergeSurvivorId ||
									resolution.mergeProposal?.playerIds[0] ||
									""
								}
								onSelect={setMergeSurvivorId}
								onApply={() =>
									void run(() =>
										request("selectRegistrationMergeSurvivor", {
											registrationId: id,
											survivorId:
												mergeSurvivorId ||
												resolution.mergeProposal?.playerIds[0] ||
												"",
										}),
									)
								}
							/>
							<section className='registration-actions'>
								<button
									className='primary'
									type='button'
									disabled={!resolution}
									onClick={() =>
										void run(async () => {
											await request("completeRegistration", {
												registrationId: id,
											});
											const next = await request("getRegistration", {
												registrationId: id,
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
											request("cancelRegistration", {registrationId: id}),
										)
									}
								>
									キャンセル
								</button>
							</section>
						</>
					)}
				</>
			)}
		</main>
	);
}
render(<App />);
