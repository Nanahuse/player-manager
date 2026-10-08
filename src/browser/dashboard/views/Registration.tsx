import {
	type MatchingInput,
	type RegistrationSession,
	type Response,
	resolveDisplayName,
} from "@nanahuse/player-manager-protocol";
import {useEffect, useState} from "react";
import type {Operations} from "../../../protocol/index.ts";
import {render} from "../../render";
import {
	confirmCurrentAssignment,
	groupCandidatesByOrigin,
} from "./candidate-resolution.ts";
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
	const apply = (value: RegistrationSession) => {
		setSession(value);
		setInput(value.input);
	};
	useEffect(() => {
		let active = true;
		void request("getRegistration", {registrationId: id})
			.then((value) => {
				if (!value) throw new Error("登録セッションが見つかりません。");
				if (active) apply(value);
			})
			.catch((cause) => {
				if (active)
					setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			active = false;
		};
	}, [id]);
	const run = async (action: () => Promise<RegistrationSession | void>) => {
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
	const resolution = session?.resolution;
	return (
		<main>
			<header>
				<div>
					<p className='eyebrow'>PLAYER MANAGER</p>
					<h1>Resolve / Register Player</h1>
					<p>関連アカウントの割り当てを確認して登録します。</p>
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
				<section>
					<fieldset disabled={busy}>
						<h2>探索入力</h2>
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
							表示名
							<input
								value={input.manualDisplayName ?? ""}
								onChange={(event) =>
									update("manualDisplayName", event.target.value || null)
								}
							/>
						</label>
						<button
							onClick={() =>
								void run(async () =>
									request("resolveRegistration", {registrationId: id, input}),
								)
							}
						>
							再探索
						</button>
						{resolution && (
							<div className='resolution'>
								<h2>Accounts / Evidence</h2>
								{resolution.errors.map((message, index) => (
									<p
										className='notice'
										key={`e${index}`}
									>
										{message}
									</p>
								))}
								{resolution.warnings.map((warning, index) => (
									<p
										className='muted'
										key={`w${index}`}
									>
										{warning.operation}: {warning.message}
									</p>
								))}
								<ul>
									{resolution.accounts.map((account) => {
										const assignment = resolution.assignments.find(
											(item) => item.accountId === account.id,
										);
										return (
											<li key={account.id}>
												<strong>{account.service}</strong>{" "}
												{account.keys.join(", ")}{" "}
												<select
													value={assignment?.ownerId ?? ""}
													onChange={(event) =>
														void run(async () =>
															request("assignRegistrationAccount", {
																registrationId: id,
																accountId: account.id,
																ownerId: event.target.value,
															}),
														)
													}
												>
													{resolution.players.map((player) => (
														<option
															key={player.id}
															value={player.id}
														>
															{player.kind === "existing"
																? `${resolveDisplayName(player.player)} (${player.id})`
																: "New Player"}
														</option>
													))}
												</select>
											</li>
										);
									})}
								</ul>
								<h3>Evidence</h3>
								<ul>
									{resolution.evidence.map((item) => (
										<li key={item.id}>
											{item.source}: {item.accounts.join(" ↔ ")}
										</li>
									))}
								</ul>
								{resolution.candidates.length > 0 && (
									<div>
										<h3>検索候補</h3>
										{groupCandidatesByOrigin(
											resolution.candidates,
											resolution.assignments,
										).map((group) => {
											const owner = resolution.players.find(
												(player) => player.id === group.assignment?.ownerId,
											);
											const ownerName =
												owner?.kind === "existing"
													? `${resolveDisplayName(owner.player)} (${owner.id})`
													: owner?.kind === "new"
														? "New Player"
														: "未割り当て";
											return (
												<div key={group.originAccountId}>
													<p>
														検索元: {group.originAccountId} / owner: {ownerName}{" "}
														/{" "}
														{group.assignment?.source === "user"
															? "明示確定済み"
															: "未確定"}
													</p>
													<ul>
														{group.candidates.map((candidate) => (
															<li key={candidate.id}>
																{candidate.service}: {candidate.profile.name} (
																{candidate.profile.userId})
															</li>
														))}
													</ul>
													{group.assignment &&
														group.assignment.source !== "user" && (
															<button
																onClick={() =>
																	confirmCurrentAssignment(
																		group,
																		(accountId, ownerId) =>
																			void run(async () =>
																				request("assignRegistrationAccount", {
																					registrationId: id,
																					accountId,
																					ownerId,
																				}),
																			),
																	)
																}
															>
																現在の割り当てで確定
															</button>
														)}
												</div>
											);
										})}
									</div>
								)}
								{resolution.conflicts.map((conflict) => (
									<div
										className='notice'
										key={conflict.id}
									>
										<p>Conflict: {conflict.ownerIds.join(" / ")}</p>
										{conflict.status === "conflict" && (
											<button
												onClick={() =>
													void run(async () =>
														request("approveRegistrationConflict", {
															registrationId: id,
															conflictId: conflict.id,
														}),
													)
												}
											>
												この Conflict を承認
											</button>
										)}
									</div>
								))}
								{resolution.mergeProposal && (
									<div>
										<p>
											Merge proposal:{" "}
											{resolution.mergeProposal.playerIds.join(" + ")}
										</p>
										<p>{resolution.mergeProposal.reason}</p>
										<select
											defaultValue=''
											onChange={(event) =>
												event.target.value &&
												void run(async () =>
													request("selectRegistrationMergeSurvivor", {
														registrationId: id,
														survivorId: event.target.value,
													}),
												)
											}
										>
											<option value=''>survivor を選択</option>
											{resolution.mergeProposal.playerIds.map((playerId) => (
												<option
													key={playerId}
													value={playerId}
												>
													{playerId}
												</option>
											))}
										</select>
									</div>
								)}
								<p>
									Required:{" "}
									{resolution.requiredStatus
										.map(
											(item) =>
												`${item.accountId} ${item.satisfied ? "満たしています" : "未解決"}`,
										)
										.join("、") || "なし"}
								</p>
								{resolution.deletionCandidates.length > 0 && (
									<div>
										<h3>Account を失った Player</h3>
										{resolution.deletionCandidates.map((playerId) => {
											const player = resolution.players.find(
												(item) =>
													item.id === playerId && item.kind === "existing",
											);
											return (
												<label key={playerId}>
													<input
														type='checkbox'
														checked={resolution.deletePlayerIds.includes(
															playerId,
														)}
														onChange={(event) =>
															void run(async () =>
																request("setRegistrationPlayerDeletion", {
																	registrationId: id,
																	playerId,
																	delete: event.target.checked,
																}),
															)
														}
													/>
													{player?.kind === "existing"
														? resolveDisplayName(player.player)
														: playerId}{" "}
													を削除
												</label>
											);
										})}
									</div>
								)}
								<p>
									New Player required:{" "}
									{resolution.newPlayerRequired ? "はい" : "いいえ"}
								</p>
							</div>
						)}
						<button
							disabled={!resolution}
							onClick={() =>
								void run(async () => {
									await request("completeRegistration", {registrationId: id});
									const next = await request("getRegistration", {
										registrationId: id,
									});
									return next ?? undefined;
								})
							}
						>
							Resolution を確定
						</button>
						<button
							onClick={() =>
								void run(async () =>
									request("cancelRegistration", {registrationId: id}),
								)
							}
						>
							キャンセル
						</button>
					</fieldset>
				</section>
			)}
		</main>
	);
}
render(<App />);
