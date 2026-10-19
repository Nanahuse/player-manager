import {type ReactNode, useEffect, useRef, useState} from "react";
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
	children,
}: {
	profileUrl?: string | null;
	speedrunUserId?: string | null;
	accountId?: string | null;
	children: ReactNode;
}) {
	const [attempt, setAttempt] = useState(0);
	const key = JSON.stringify([accountId, profileUrl, speedrunUserId, attempt]);
	const refreshRef = useRef<() => void>(() => {});
	const [result, setResult] = useState<{
		key: string;
		url: string | null;
	} | null>(null);
	const lookup = Boolean(accountId) || (!profileUrl && Boolean(speedrunUserId));
	useEffect(() => {
		if (!lookup) return;
		let active = true;
		setResult(null);
		const resolve = () =>
			accountId
				? dedupe(`account:${accountId}`, () => fetchAccountUrl(accountId))
				: dedupe(`speedrun:${speedrunUserId}`, () =>
						fetchSpeedrunUrl(speedrunUserId!),
					);
		refreshRef.current = () => {
			void resolve().then((url) => {
				if (active) setResult({key, url});
			});
		};
		refreshRef.current();
		return () => {
			active = false;
			refreshRef.current = () => {};
		};
	}, [lookup, accountId, speedrunUserId, key]);
	const url = lookup
		? result?.key === key
			? result.url
			: null
		: httpUrl(profileUrl);
	const failed = lookup && result?.key === key && !result.url;
	return (
		<span className='profile-link'>
			{url ? (
				<a
					href={url}
					target='_blank'
					rel='noopener noreferrer'
					onFocus={accountId ? () => refreshRef.current() : undefined}
					onPointerEnter={accountId ? () => refreshRef.current() : undefined}
				>
					{children}
				</a>
			) : (
				<span>{children}</span>
			)}
			{failed && (
				<button
					type='button'
					className='retry-link'
					aria-label='プロフィールリンクを再試行'
					onClick={() => setAttempt((value) => value + 1)}
				>
					プロフィールリンクを再試行
				</button>
			)}
		</span>
	);
}
