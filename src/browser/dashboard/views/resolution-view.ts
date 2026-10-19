import {
	type AccountService,
	type Resolution,
	resolveDisplayName,
} from "@nanahuse/player-manager-protocol";
import {
	login,
	normalizeProfileUrl,
	speedrunWeblink,
	youtubeUrl,
} from "../../../domain/player.ts";

export const resolutionServices: {
	id: AccountService;
	label: string;
}[] = [
	{id: "racetime", label: "RaceTime"},
	{id: "speedrunCom", label: "Speedrun.com"},
	{id: "twitch", label: "Twitch"},
	{id: "youtube", label: "YouTube"},
];

export type AccountChipView = {
	accountId: string;
	savedAccountId: string | null;
	service: AccountService;
	profileUrl: string | null;
	speedrunUserId: string | null;
	label: string;
	profileName: string | null;
	evidenceLabels: string[];
	states: ("Required" | "Conflict" | "Resolved")[];
	ownerId: string | undefined;
	role: "primary" | "secondary" | undefined;
	roleConflict: boolean;
	discarded: boolean;
};

export type MissingRequiredView = {
	service: AccountService;
	value: string;
	label: string;
};

export type ResolutionView = {
	services: {id: AccountService; label: string}[];
	players: {
		id: string;
		kind: "existing" | "new";
		label: string;
		mergeAbsorbed: boolean;
		mergeSurvivor: boolean;
		deletionCandidate: boolean;
		doDelete: boolean;
		cells: Record<string, AccountChipView[]>;
	}[];
	discardedAccounts: AccountChipView[];
	accounts: AccountChipView[];
	newPlayerRequired: boolean;
	missingRequired: MissingRequiredView[];
	issues: {
		unresolvedConflicts: number;
		roleConflicts: number;
		candidateGroups: number;
		mergeNeedsSurvivor: boolean;
		unsatisfiedRequired: number;
		duplicateCells: {playerId: string; service: AccountService}[];
	};
};

const sourceLabel = {
	user: "User",
	input: "Input",
	racetime: "RaceTime",
	src: "SRC",
} as const;
const evidenceOrder = ["User", "Input", "RaceTime", "SRC"] as const;
const accountKeyPrefixes: Partial<Record<AccountService, string[]>> = {
	racetime: ["racetime:"],
	speedrunCom: ["speedrunCom:"],
	twitch: ["twitch:"],
	youtube: ["youtube:"],
};

function youtubeAccountLabel(value: string) {
	try {
		youtubeUrl(value);
		const url = new URL(value, "https://www.youtube.com/");
		const last = url.pathname.split("/").filter(Boolean).at(-1);
		return last ? decodeURIComponent(last) : value;
	} catch {
		return value;
	}
}

export function accountLabel(service: AccountService, value: string) {
	const prefix = accountKeyPrefixes[service]?.find((item) =>
		value.startsWith(item),
	);
	const urlPrefix = `url:${service}:`;
	const identity = prefix
		? value.slice(prefix.length)
		: value.startsWith(urlPrefix)
			? value.slice(urlPrefix.length)
			: value;
	return service === "youtube" ? youtubeAccountLabel(identity) : identity;
}

function safeProfileUrl(value: unknown): string | null {
	try {
		const normalized = normalizeProfileUrl(value);
		const url = new URL(normalized);
		return ["http:", "https:"].includes(url.protocol) ? normalized : null;
	} catch {
		return null;
	}
}

function accountKeyValue(
	account: Resolution["accounts"][number],
	prefix: string,
) {
	return account.keys
		.find((key) => key.startsWith(prefix))
		?.slice(prefix.length);
}

function profileUrl(account: Resolution["accounts"][number]): string | null {
	const profile = account.profile;
	try {
		switch (account.service) {
			case "racetime": {
				const id = profile?.userId ?? accountKeyValue(account, "racetime:");
				return id ? `https://racetime.gg/user/${encodeURIComponent(id)}` : null;
			}
			case "twitch": {
				const value = accountKeyValue(account, "twitch:");
				const twitchLogin = value ? login(value) : null;
				return twitchLogin ? `https://www.twitch.tv/${twitchLogin}` : null;
			}
			case "youtube": {
				const value = profile?.youtube ?? accountKeyValue(account, "youtube:");
				return value ? youtubeUrl(value) : null;
			}
			case "speedrunCom":
				return speedrunWeblink(profile?.weblink);
			default: {
				const raw = account.keys.find((key) => key.startsWith("url:"));
				if (!raw) return null;
				const match = /^url:[^:]+:(.+)$/s.exec(raw);
				return match ? safeProfileUrl(match[1]) : null;
			}
		}
	} catch {
		return null;
	}
}

export function candidateProfileUrl(
	service: "racetime" | "speedrunCom",
	profile: {userId: string; weblink?: string},
): string | null {
	if (service === "speedrunCom") return speedrunWeblink(profile.weblink);
	return profile.userId
		? `https://racetime.gg/user/${encodeURIComponent(profile.userId)}`
		: null;
}

export function buildResolutionView(
	resolution: Resolution,
	knownAccountIds: ReadonlySet<string> = new Set(),
): ResolutionView {
	const savedAccountIds = new Set([
		...knownAccountIds,
		...resolution.players.flatMap((player) =>
			player.kind === "existing"
				? (player.player.accounts ?? []).map((account) => account.id)
				: [],
		),
	]);
	const discovered = new Set(
		resolution.accounts.map((account) => account.service),
	);
	const services = [
		...resolutionServices,
		...[...discovered]
			.filter((id) => !resolutionServices.some((service) => service.id === id))
			.sort()
			.map((id) => ({id, label: id})),
	];
	const missingRequired = resolution.requiredStatus.flatMap((status, index) => {
		const required = resolution.requiredAccounts[index];
		return !status.satisfied && required
			? [
					{
						service: required.service,
						value: required.value,
						label: accountLabel(required.service, required.value),
					},
				]
			: [];
	});
	const assignments = new Map(
		resolution.assignments.map((assignment) => [
			assignment.accountId,
			assignment,
		]),
	);
	const conflictByEvidence = new Map(
		resolution.conflicts.map((conflict) => [
			conflict.evidenceId,
			conflict.status,
		]),
	);
	const requiredIds = new Set(
		resolution.requiredStatus.map((status) => status.accountId),
	);
	const chips = new Map<string, AccountChipView>();
	const discardedIds = new Set(resolution.discardedAccountIds);
	const roleConflictAccountIds = new Set(
		(resolution.roleConflicts ?? []).flatMap(({accountIds}) => accountIds),
	);
	for (const account of resolution.accounts) {
		const evidence = resolution.evidence.filter((set) =>
			set.accounts.includes(account.id),
		);
		const relatedConflictStatuses = evidence
			.map((set) => conflictByEvidence.get(set.id))
			.filter((status): status is "conflict" | "resolved" => Boolean(status));
		const states: AccountChipView["states"] = [];
		if (requiredIds.has(account.id)) states.push("Required");
		if (relatedConflictStatuses.includes("conflict")) states.push("Conflict");
		else if (relatedConflictStatuses.includes("resolved"))
			states.push("Resolved");
		chips.set(account.id, {
			accountId: account.id,
			savedAccountId: savedAccountIds.has(account.id) ? account.id : null,
			service: account.service,
			profileUrl: profileUrl(account),
			speedrunUserId:
				account.service === "speedrunCom"
					? (account.profile?.userId ??
						accountKeyValue(account, "speedrunCom:") ??
						null)
					: null,
			label: accountLabel(
				account.service,
				account.keys.find((key) =>
					(accountKeyPrefixes[account.service] ?? []).some((prefix) =>
						key.startsWith(prefix),
					),
				) ??
					account.keys[0] ??
					"(識別値なし)",
			),
			profileName: account.profile?.name ?? null,
			evidenceLabels: [
				...new Set(evidence.map((set) => sourceLabel[set.source])),
			].sort(
				(a, b) =>
					evidenceOrder.indexOf(a as (typeof evidenceOrder)[number]) -
					evidenceOrder.indexOf(b as (typeof evidenceOrder)[number]),
			),
			states,
			ownerId: assignments.get(account.id)?.ownerId,
			role: assignments.get(account.id)?.role,
			roleConflict: roleConflictAccountIds.has(account.id),
			discarded: discardedIds.has(account.id),
		});
	}
	const absorbed = new Set(resolution.mergeAssessment?.absorbedPlayerIds ?? []);
	const players = resolution.players.map((player) => {
		const cells: ResolutionView["players"][number]["cells"] =
			Object.fromEntries(services.map(({id}) => [id, []]));
		for (const chip of chips.values())
			if (!chip.discarded && chip.ownerId === player.id) {
				const cell = cells[chip.service] ?? [];
				cells[chip.service] = cell;
				cell.push(chip);
			}
		return {
			id: player.id,
			kind: player.kind,
			label:
				player.kind === "existing"
					? resolveDisplayName(player.player)
					: "New Player",
			mergeAbsorbed: absorbed.has(player.id),
			mergeSurvivor: resolution.mergeAssessment?.survivorId === player.id,
			deletionCandidate:
				resolution.deletionCandidates.includes(player.id) &&
				!absorbed.has(player.id),
			doDelete: resolution.deletePlayerIds.includes(player.id),
			cells,
		};
	});
	const duplicateCells: ResolutionView["issues"]["duplicateCells"] = [];
	const candidateOrigins = new Set(
		resolution.candidates
			.filter(
				(candidate) =>
					!resolution.confirmedCandidateAccountIds.includes(
						candidate.originAccountId,
					),
			)
			.map((candidate) => candidate.originAccountId),
	);
	return {
		services,
		players,
		discardedAccounts: [...chips.values()].filter((chip) => chip.discarded),
		accounts: [...chips.values()],
		newPlayerRequired: resolution.newPlayerRequired,
		missingRequired,
		issues: {
			unresolvedConflicts: resolution.conflicts.filter(
				(conflict) => conflict.status === "conflict",
			).length,
			roleConflicts: resolution.roleConflicts?.length ?? 0,
			candidateGroups: candidateOrigins.size,
			mergeNeedsSurvivor:
				resolution.mergeProposal !== null &&
				resolution.mergeDecision !== "keepSeparate",
			unsatisfiedRequired: missingRequired.length,
			duplicateCells,
		},
	};
}
