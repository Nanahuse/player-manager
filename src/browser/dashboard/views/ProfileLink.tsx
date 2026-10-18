import {useCallback, useEffect, useRef, useState} from "react";
import {speedrunWeblink} from "../../../domain/player.ts";

const inFlight = new Map<string, Promise<string | null>>();

function dedupe(
	key: string,
	run: () => Promise<string | null>,
): Promise<string | null> {
	const pending = inFlight.get(key);
	if (pending) return pending;
	const promise = run().finally(() => {
		if (inFlight.get(key) === promise) inFlight.delete(key);
	});
	inFlight.set(key, promise);
	return promise;
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
	const saved = Boolean(accountId);
	const lookup = Boolean(accountId) || (!profileUrl && Boolean(speedrunUserId));
	const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const attemptRef = useRef(attempt);
	attemptRef.current = attempt;
	const apply = useCallback((url: string | null) => {
		if (url) {
			setResolvedUrl(url);
			setFailed(false);
		} else {
			setResolvedUrl(null);
			setFailed(true);
		}
	}, []);
	const resolve = useCallback((): Promise<string | null> => {
		if (accountId)
			return dedupe(`account:${accountId}`, () => fetchAccountUrl(accountId));
		if (!profileUrl && speedrunUserId)
			return dedupe(`speedrun:${speedrunUserId}`, () =>
				fetchSpeedrunUrl(speedrunUserId),
			);
		return Promise.resolve(profileUrl ?? null);
	}, [accountId, profileUrl, speedrunUserId]);
	useEffect(() => {
		if (!lookup) {
			apply(profileUrl ?? null);
			return;
		}
		setFailed(false);
		setResolvedUrl(null);
		const effectAttempt = attempt;
		let current = true;
		void resolve().then((url) => {
			if (!current || effectAttempt !== attemptRef.current) return;
			apply(url);
		});
		return () => {
			current = false;
		};
	}, [lookup, resolve, attempt, profileUrl, apply]);
	const refresh = useCallback(() => {
		if (!lookup) return;
		void resolve().then(apply);
	}, [lookup, resolve, apply]);
	if (resolvedUrl)
		return (
			<a
				href={resolvedUrl}
				target='_blank'
				rel='noopener noreferrer'
				onPointerEnter={saved ? refresh : undefined}
				onFocus={saved ? refresh : undefined}
			>
				開く↗
			</a>
		);
	if (!saved && !speedrunUserId && !profileUrl) return null;
	if (failed)
		return (
			<button
				type='button'
				onClick={() => setAttempt((value) => value + 1)}
			>
				プロフィールリンクを再試行
			</button>
		);
	return <span role='status'>プロフィールリンクを取得中…</span>;
}
