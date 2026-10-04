import {useEffect, useState} from "react";
import {completeRegistration} from "../complete-registration.ts";
import {render} from "../../render";
import {
	resolveDisplayName,
	type Operations,
	type CompleteRegistration,
	type Response,
	type IdentityResolutionInput,
	type RegistrationSession,
	type Player,
	type ResolutionCandidate,
} from "../../../protocol/index.ts";
import "../player-mapping.css";
async function request<K extends keyof Operations>(
	op: K,
	data: Operations[K]["request"],
): Promise<Operations[K]["response"]> {
	const r = (await nodecg.sendMessage(
		`player-manager.v1.${op}`,
		data,
	)) as Response<Operations[K]["response"]>;
	if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
	return r.data;
}
function App() {
	const id =
		new URLSearchParams(window.location.search).get("registrationId") ?? "";
	const [session, setSession] = useState<RegistrationSession | null>(null),
		[input, setInput] = useState<IdentityResolutionInput>({}),
		[players, setPlayers] = useState<Player[]>([]),
		[chosen, setChosen] = useState(""),
		[query, setQuery] = useState(""),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false),
		[dirty, setDirty] = useState(false);
	const apply = (s: RegistrationSession) => {
		setSession(s);
		if (s.resolution && s.resolution.status !== "conflict")
			setInput(s.resolution.input);
		else setInput(s.input);
		setChosen(s.resolution?.playerId ?? "");
		setDirty(false);
	};
	useEffect(() => {
		let active = true;
		void (async () => {
			try {
				if (!id)
					throw new Error(
						"登録セッションが指定されていません。呼び出し元から開いてください。",
					);
				let s = await request("getRegistration", {registrationId: id});
				if (!s)
					throw new Error(
						"登録セッションが見つかりません。呼び出し元から開き直してください。",
					);
				if (s.state === "pending" && !s.resolution) {
					try {
						s = await request("resolveRegistration", {
							registrationId: id,
							input: s.input,
						});
					} catch (e) {
						if (active) setError(String(e));
					}
				}
				const d = await request("list", undefined);
				if (!active) return;
				setPlayers(d.players);
				apply(s);
			} catch (e) {
				if (active) setError(String(e));
			}
		})();
		return () => {
			active = false;
		};
	}, [id]);
	const run = async (fn: () => Promise<void>) => {
		setBusy(true);
		setError("");
		try {
			await fn();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const resolve = async (value: IdentityResolutionInput) => {
		apply(
			await request("resolveRegistration", {registrationId: id, input: value}),
		);
		setPlayers((await request("list", undefined)).players);
	};
	const field = (label: string, value: string, change: (v: string) => void) => (
		<label>
			{label}
			<input
				value={value}
				onChange={(e) => {
					change(e.target.value);
					setDirty(true);
				}}
			/>
		</label>
	);
	const selectCandidate = async (c: ResolutionCandidate) => {
		if (c.type === "player") {
			setChosen(c.playerId);
			return;
		}
		if (c.provider === "racetime" || c.provider === "speedrunCom") {
			await resolve({...input, [c.provider]: {userId: c.value}});
		} else if (c.provider === "twitch") {
			await resolve({...input, twitch: {login: c.value}});
		} else if (c.provider === "youtube") {
			await resolve({...input, youtube: c.value});
		}
	};
	const selected = players.find((p) => p.playerId === chosen);
	const blocked = !dirty && session?.resolution?.status === "conflict";
	const complete = async (action: CompleteRegistration) => {
		const result = await completeRegistration(
			request,
			id,
			action,
			dirty || !session?.resolution,
			input,
			apply,
		);
		if (result) setSession(result);
	};
	return (
		<main>
			<header>
				<div>
					<p className='eyebrow'>PLAYER MANAGER</p>
					<h1>Resolve / Register Player</h1>
					<p>アカウントを確認して、呼び出し元へPlayerを返します。</p>
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
					<p>{session.result && resolveDisplayName(session.result.player)}</p>
					<p>Player ID: {session.result?.player.playerId}</p>
					<p>呼び出し元へ通知しました。この画面を閉じられます。</p>
				</section>
			)}
			{session && ["cancelled", "expired"].includes(session.state) && (
				<section>
					<h2>
						{session.state === "expired"
							? "セッションの有効期限が切れました"
							: "キャンセルしました"}
					</h2>
					<p>呼び出し元から開き直してください。</p>
				</section>
			)}
			{session?.state === "pending" && (
				<section>
					<fieldset disabled={busy}>
						<h2>登録するアカウント</h2>
						{field("表示名", input.manualDisplayName ?? "", (v) =>
							setInput({...input, manualDisplayName: v || null}),
						)}
						{field("RaceTime ID / URL", input.racetime?.userId ?? "", (v) =>
							setInput({...input, racetime: v ? {userId: v} : null}),
						)}
						{field("Twitchユーザー名 / URL", input.twitch?.login ?? "", (v) =>
							setInput({...input, twitch: v ? {login: v} : null}),
						)}
						{field(
							"Speedrun.com ID / URL",
							input.speedrunCom?.userId ?? "",
							(v) => setInput({...input, speedrunCom: v ? {userId: v} : null}),
						)}
						{field("YouTube URL / @ハンドル", input.youtube ?? "", (v) =>
							setInput({...input, youtube: v || null}),
						)}
						<button onClick={() => void run(() => resolve(input))}>
							Identityを確認・再突合
						</button>
						{session.resolution && (
							<div className='resolution'>
								<strong>{session.resolution.status}</strong>
								<p>{session.resolution.message}</p>
								{session.resolution.warnings.map((w, i) => (
									<p key={i}>{w}</p>
								))}
								<ul>
									{session.resolution.candidates.map((c, i) => (
										<li key={i}>
											<button
												onClick={() => void run(() => selectCandidate(c))}
											>
												{c.type === "player"
													? `Player: ${c.playerId}`
													: `${c.provider}: ${c.value}`}{" "}
												を選択
											</button>
										</li>
									))}
								</ul>
							</div>
						)}
						{blocked && (
							<p className='notice'>
								アカウントの競合があります。入力内容を修正して登録してください。
							</p>
						)}
						<h2>既存Player</h2>
						<label>
							既存Playerを検索
							<input
								value={query}
								onChange={(e) => setQuery(e.target.value)}
							/>
						</label>
						<label>
							使用するPlayer
							<select
								value={chosen}
								onChange={(e) => setChosen(e.target.value)}
							>
								<option value=''>選択してください</option>
								{players
									.filter(
										(p) =>
											p.playerId === chosen ||
											JSON.stringify(p)
												.toLowerCase()
												.includes(query.toLowerCase()),
									)
									.map((p) => (
										<option
											value={p.playerId}
											key={p.playerId}
										>
											{resolveDisplayName(p)} ({p.playerId})
										</option>
									))}
							</select>
						</label>
						{selected && (
							<>
								<p>現在の登録内容（自動更新しません）</p>
								<dl>
									<dt>表示名</dt>
									<dd>{resolveDisplayName(selected)}</dd>
									<dt>RaceTime</dt>
									<dd>{selected.racetime?.name ?? "未登録"}</dd>
									<dt>Speedrun.com</dt>
									<dd>{selected.speedrunCom?.name ?? "未登録"}</dd>
									<dt>Twitch</dt>
									<dd>{selected.twitch?.login ?? "未登録"}</dd>
									<dt>YouTube</dt>
									<dd>{selected.youtube ?? "未登録"}</dd>
								</dl>
								<div className='toolbar'>
									<button
										disabled={blocked}
										onClick={() =>
											void run(async () => {
												await complete({
													action: "existing",
													playerId: selected.playerId,
												});
											})
										}
									>
										このPlayerを使用（変更しない）
									</button>
									<button
										disabled={blocked}
										onClick={() =>
											void run(async () => {
												await complete({
													action: "updated",
													playerId: selected.playerId,
													revision: selected.revision,
													input,
												});
											})
										}
									>
										入力内容でこのPlayerを更新して使用
									</button>
								</div>
								<p className='muted'>
									更新は全フィールドを置き換えます。空欄のアカウントは解除されます。
								</p>
							</>
						)}
						<h2>新規Player</h2>
						<p className='muted'>
							入力を変更した場合は、登録時に自動で突合します。競合や複数候補があれば確認のため停止します。
						</p>
						<button
							disabled={blocked}
							onClick={() =>
								void run(async () => {
									await complete({
										action: "created",
										input,
									});
								})
							}
						>
							入力内容で新規登録して使用
						</button>
						<div className='danger'>
							<button
								onClick={() =>
									void run(async () =>
										setSession(
											await request("cancelRegistration", {registrationId: id}),
										),
									)
								}
							>
								キャンセル
							</button>
						</div>
					</fieldset>
				</section>
			)}
		</main>
	);
}
render(<App />);
