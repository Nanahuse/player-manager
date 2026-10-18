import {useEffect, useRef, useState} from "react";
import {speedrunWeblink} from "../../../domain/player.ts";

type CachedUrl = string | null | Promise<string | null>;

const speedrunUrls = new Map<string, CachedUrl>();
const accountUrls = new Map<string, CachedUrl>();

function cached(
	cache: Map<string, CachedUrl>,
	key: string,
	fetcher: (key: string) => Promise<string | null>,
): Promise<string | null> {
	const cached = cache.get(key);
	if (cached instanceof Promise) return cached;
	if (cached !== undefined) return Promise.resolve(cached);
	const pending = fetcher(key).then(
		(url) => {
			cache.set(key, url);
			return url;
		},
		() => {
			cache.set(key, null);
			return null;
		},
	);
	cache.set(key, pending);
	return pending;
}

function httpUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

async function fetchSpeedrunUrl(userId: string): Promise<string | null> {
	try {
		const response = (await nodecg.sendMessage("player-manager.v3.getUser", {
			userId,
		})) as {ok: boolean; data?: {weblink?: unknown}};
		return response.ok ? speedrunWeblink(response.data?.weblink) : null;
	} catch {
		return null;
	}
}

async function fetchAccountUrl(accountId: string): Promise<string | null> {
	try {
		const response = (await nodecg.sendMessage(
			"player-manager.v3.getAccountProfileUrl",
			{accountId},
		)) as {ok: boolean; data?: {url?: unknown}};
		return response.ok ? httpUrl(response.data?.url) : null;
	} catch {
		return null;
	}
}

export function ProfileLink({
	profileUrl,
	speedrunUserId,
	accountId,
}: {
	profileUrl?: string | null;
	speedrunUserId?: string | null;
	accountId?: string | null;
}) {
	const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const attemptRef = useRef(attempt);
	attemptRef.current = attempt;
	const saved = Boolean(accountId);
	useEffect(() => {
		setResolvedUrl(null);
		setFailed(false);
		const effectAttempt = attempt;
		let current = true;
		const complete = (url: string | null) => {
			if (!current || effectAttempt !== attemptRef.current) return;
			setResolvedUrl(url);
			setFailed(!url);
		};
		if (accountId) {
			void cached(accountUrls, accountId, fetchAccountUrl).then(complete);
			return () => {
				current = false;
			};
		}
		setResolvedUrl(profileUrl ?? null);
		if (profileUrl || !speedrunUserId) return;
		void cached(speedrunUrls, speedrunUserId, fetchSpeedrunUrl).then(complete);
		return () => {
			current = false;
		};
	}, [accountId, profileUrl, speedrunUserId, attempt]);
	if (resolvedUrl)
		return (
			<a
				href={resolvedUrl}
				target='_blank'
				rel='noopener noreferrer'
			>
				開く↗
			</a>
		);
	if (!saved && !speedrunUserId) return null;
	if (failed)
		return (
			<button
				type='button'
				onClick={() => {
					if (saved) accountUrls.delete(accountId!);
					else speedrunUrls.delete(speedrunUserId!);
					setAttempt((value) => value + 1);
				}}
			>
				プロフィールリンクを再試行
			</button>
		);
	return <span role='status'>プロフィールリンクを取得中…</span>;
}
