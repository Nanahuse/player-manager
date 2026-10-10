import type {
	ProviderIdentity,
	Response,
} from "@nanahuse/player-manager-protocol";
import {useRef, useState} from "react";
import {speedrunWeblink} from "../../../domain/player.ts";
import type {Operations} from "../../../protocol/index.ts";

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

export function SpeedrunUserSearch({
	onSelect,
}: {
	onSelect: (identity: ProviderIdentity) => void;
}) {
	const [query, setQuery] = useState("");
	const [identities, setIdentities] = useState<ProviderIdentity[]>([]);
	const [hasMore, setHasMore] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const searchSequence = useRef(0);
	const search = async () => {
		const sequence = ++searchSequence.current;
		setBusy(true);
		setError("");
		try {
			const result = await request("searchIdentities", {
				provider: "speedrunCom",
				query,
				mode: "name",
			});
			if (sequence !== searchSequence.current) return;
			setIdentities(result.identities);
			setHasMore(result.hasMore);
		} catch (cause) {
			if (sequence !== searchSequence.current) return;
			setIdentities([]);
			setHasMore(false);
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(
				message.startsWith("rate_limited:")
					? "Speedrun.comのレート制限に達しました。時間をおいて再検索してください。"
					: message,
			);
		} finally {
			if (sequence === searchSequence.current) setBusy(false);
		}
	};
	return (
		<section aria-label='Speedrun.comユーザー検索'>
			<div className='search'>
				<label>
					Speedrun.comユーザー名で検索
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void search();
							}
						}}
					/>
				</label>
				<button
					type='button'
					disabled={busy || !query.trim()}
					onClick={() => void search()}
				>
					{busy ? "検索中…" : "検索"}
				</button>
			</div>
			{error && (
				<p
					className='notice warning'
					role='alert'
				>
					{error}
				</p>
			)}
			{hasMore && (
				<p
					className='notice warning'
					role='status'
				>
					結果上限を超えています。検索語を絞ってください。
				</p>
			)}
			<ul className='results'>
				{identities.map((identity) => {
					const profile =
						speedrunWeblink(identity.weblink) ??
						`https://www.speedrun.com/users/${encodeURIComponent(identity.userId)}`;
					return (
						<li key={identity.userId}>
							<button
								type='button'
								onClick={() => onSelect(identity)}
							>
								{identity.name} · {identity.userId} · Twitch:{" "}
								{identity.twitchLogin ?? "なし"}
							</button>{" "}
							<a
								href={profile}
								target='_blank'
								rel='noopener noreferrer'
							>
								プロフィール ↗
							</a>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
