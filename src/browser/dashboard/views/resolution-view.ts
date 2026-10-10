import {
	type AccountService,
	type Resolution,
	resolveDisplayName,
} from "@nanahuse/player-manager-protocol";

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
	service: AccountService;
	label: string;
	profileName: string | null;
	evidenceLabels: string[];
	states: ("Required" | "Conflict" | "Resolved")[];
	ownerId: string | undefined;
	discarded: boolean;
};

export type MissingRequiredView = {
	service: AccountService;
	value: string;
};

export type ResolutionView = {
	players: {
		id: string;
		kind: "existing" | "new";
		label: string;
		mergeAbsorbed: boolean;
		mergeSurvivor: boolean;
		deletionCandidate: boolean;
		doDelete: boolean;
		cells: Record<AccountService, AccountChipView[]>;
	}[];
	discardedAccounts: AccountChipView[];
	availableOwnerIds: string[];
	newPlayerRequired: boolean;
	missingRequired: MissingRequiredView[];
	issues: {
		unresolvedConflicts: number;
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

function accountLabel(service: AccountService, keys: string[]) {
	const prefixes: Record<AccountService, string[]> = {
		racetime: ["racetime:"],
		speedrunCom: ["speedrunCom:"],
		twitch: ["twitch:", "twitch-id:"],
		youtube: ["youtube:"],
	};
	const values = keys
		.filter((key) => prefixes[service].some((prefix) => key.startsWith(prefix)))
		.map((key) => key.slice(key.indexOf(":") + 1));
	return values[0] ?? keys[0] ?? "(識別値なし)";
}

export function buildResolutionView(resolution: Resolution): ResolutionView {
	const missingRequired = resolution.requiredStatus.flatMap((status, index) => {
		const required = resolution.requiredAccounts[index];
		return !status.satisfied && required
			? [{service: required.service, value: required.value}]
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
			service: account.service,
			label: accountLabel(account.service, account.keys),
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
			discarded: discardedIds.has(account.id),
		});
	}
	const absorbed = new Set(resolution.mergeAssessment?.absorbedPlayerIds ?? []);
	const players = resolution.players.map((player) => {
		const cells: ResolutionView["players"][number]["cells"] = {
			racetime: [],
			speedrunCom: [],
			twitch: [],
			youtube: [],
		};
		for (const chip of chips.values())
			if (!chip.discarded && chip.ownerId === player.id)
				cells[chip.service].push(chip);
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
	const duplicateCells = players.flatMap((player) =>
		resolutionServices
			.filter(({id}) => player.cells[id].length > 1)
			.map(({id}) => ({playerId: player.id, service: id})),
	);
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
		players,
		discardedAccounts: [...chips.values()].filter((chip) => chip.discarded),
		availableOwnerIds: players
			.filter((player) => !player.mergeAbsorbed)
			.map((player) => player.id),
		newPlayerRequired: resolution.newPlayerRequired,
		missingRequired,
		issues: {
			unresolvedConflicts: resolution.conflicts.filter(
				(conflict) => conflict.status === "conflict",
			).length,
			candidateGroups: candidateOrigins.size,
			mergeNeedsSurvivor: resolution.mergeProposal !== null,
			unsatisfiedRequired: missingRequired.length,
			duplicateCells,
		},
	};
}
