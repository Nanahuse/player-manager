import {useEffect, useState} from "react";
import {speedrunWeblink} from "../../../domain/player.ts";

const speedrunUrls = new Map<string, string | null | Promise<string | null>>();

function fetchSpeedrunUrl(userId: string): Promise<string | null> {
	const cached = speedrunUrls.get(userId);
	if (cached instanceof Promise) return cached;
	if (cached !== undefined) return Promise.resolve(cached);
	const pending = (async () => {
		try {
			const response = (await nodecg.sendMessage("player-manager.v3.getUser", {
				userId,
			})) as {ok: boolean; data?: {weblink?: unknown}};
			const url = response.ok ? speedrunWeblink(response.data?.weblink) : null;
			speedrunUrls.set(userId, url);
			return url;
		} catch {
			speedrunUrls.set(userId, null);
			return null;
		}
	})();
	speedrunUrls.set(userId, pending);
	return pending;
}

export function ProfileLink({
	profileUrl,
	speedrunUserId,
}: {
	profileUrl: string | null;
	speedrunUserId?: string | null;
}) {
	const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		setResolvedUrl(profileUrl);
		setFailed(false);
		if (profileUrl || !speedrunUserId) return;
		let current = true;
		void fetchSpeedrunUrl(speedrunUserId).then((url) => {
			if (!current) return;
			setResolvedUrl(url);
			setFailed(!url);
		});
		return () => {
			current = false;
		};
	}, [profileUrl, speedrunUserId]);
	if (resolvedUrl)
		return (
			<a
				href={resolvedUrl}
				target='_blank'
				rel='noopener noreferrer'
			>
				プロフィールを開く ↗
			</a>
		);
	if (!speedrunUserId) return null;
	if (failed)
		return (
			<button
				type='button'
				onClick={() => {
					speedrunUrls.delete(speedrunUserId);
					setFailed(false);
					setResolvedUrl(null);
					void fetchSpeedrunUrl(speedrunUserId).then((url) => {
						setResolvedUrl(url);
						setFailed(!url);
					});
				}}
			>
				プロフィールリンクを再試行
			</button>
		);
	return <span role='status'>プロフィールリンクを取得中…</span>;
}
