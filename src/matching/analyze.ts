import {
	DirectoryError,
	login,
	speedrunReference,
	youtubeUrl,
} from "../domain/player.ts";
import {raceTimeId} from "../extension/racetime.ts";
import {components, dedupeAccounts, dedupeEvidence} from "./graph.ts";
import type {Assignment, Collection, Conflict, Resolution} from "./model.ts";

type AnalysisOptions = {
	createPlayerOnEmpty?: boolean;
	assignments?: Assignment[];
	resolvedConflictIds?: string[];
	mergeAssessment?: {survivorId: string; absorbedPlayerIds: string[]};
	deletePlayerIds?: string[];
};

export function analyze(
	collection: Collection,
	options: AnalysisOptions = {},
): Resolution {
	const accounts = dedupeAccounts(collection.accounts);
	const evidence = dedupeEvidence(collection.evidence);
	const knownPlayers = collection.directory.players;
	const keysByPlayer = new Map(
		knownPlayers.map((player) => [player.playerId, playerKeys(player)]),
	);
	const ownersByKey = new Map<string, string>();
	for (const player of knownPlayers)
		for (const account of accounts)
			if (
				account.keys.some((key) =>
					keysByPlayer.get(player.playerId)?.includes(key),
				)
			)
				ownersByKey.set(account.id, player.playerId);
	const groups = components(accounts, evidence);
	const relevant = new Set<string>();
	for (const group of groups)
		if (group.some((id) => collection.seedAccountIds.includes(id)))
			for (const id of group) relevant.add(id);
	const selectedAccounts = accounts.filter(({id}) => relevant.has(id));
	const selectedEvidence = evidence.filter((set) =>
		set.accounts.some((id) => relevant.has(id)),
	);
	const currentAssignments: Assignment[] = selectedAccounts.map((account) => {
		const current = ownersByKey.get(account.id);
		if (current)
			return {accountId: account.id, ownerId: current, source: "user"};
		const group = groups.find((g) => g.includes(account.id)) ?? [];
		const existing = [
			...new Set(
				group
					.map((id) => ownersByKey.get(id))
					.filter((id): id is string => Boolean(id)),
			),
		];
		if (existing.length === 1)
			return {accountId: account.id, ownerId: existing[0]!, source: "inferred"};
		return {
			accountId: account.id,
			ownerId: collection.newPlayerId,
			source: "new",
		};
	});
	const overrides = new Map(
		(options.assignments ?? []).map((assignment) => [
			assignment.accountId,
			assignment,
		]),
	);
	const assignments = currentAssignments.map(
		(assignment) => overrides.get(assignment.accountId) ?? assignment,
	);
	const ownerByAccount = new Map(
		assignments.map((assignment) => [assignment.accountId, assignment.ownerId]),
	);
	const conflicts: Conflict[] = selectedEvidence.flatMap((set) => {
		const pairs = set.accounts
			.map((accountId) => [accountId, ownerByAccount.get(accountId)] as const)
			.filter((pair): pair is readonly [string, string] => Boolean(pair[1]));
		const ownerIds = [...new Set(pairs.map(([, ownerId]) => ownerId))];
		if (ownerIds.length < 2) return [];
		const assignmentKey = pairs
			.map(([accountId, ownerId]) => `${accountId}=${ownerId}`)
			.sort()
			.join("|");
		const id = `conflict:${set.id}:${assignmentKey}`;
		return [
			{
				id,
				evidenceId: set.id,
				ownerIds,
				status: options.resolvedConflictIds?.includes(id)
					? "resolved"
					: "conflict",
			},
		];
	});
	const mergeComponent = groups
		.filter((group) => group.some((id) => relevant.has(id)))
		.map((group) => ({
			accountIds: group.filter((id) => relevant.has(id)),
			playerIds: [
				...new Set(
					group
						.map((id) => ownersByKey.get(id))
						.filter((id): id is string => Boolean(id)),
				),
			],
		}))
		.find(
			({playerIds}) =>
				playerIds.length > 1 &&
				playerIds.every((id) =>
					selectedAccounts.some(
						(account) => ownerByAccount.get(account.id) === id,
					),
				),
		);
	const mergeProposal =
		mergeComponent &&
		collection.candidates.length === 0 &&
		collection.errors.length === 0 &&
		canMergeAccountSet(mergeComponent.accountIds, selectedAccounts)
			? {
					playerIds: mergeComponent.playerIds,
					accountIds: mergeComponent.accountIds,
					reason:
						"Players are connected by account evidence with no unresolved candidates or lookup errors.",
				}
			: null;
	const availablePlayerIds = new Set([
		...selectedAccounts
			.map((account) => ownersByKey.get(account.id))
			.filter((id): id is string => Boolean(id)),
		...assignments.map((assignment) => assignment.ownerId),
	]);
	const accountIdsByOwner = new Map<string, string[]>();
	for (const assignment of assignments)
		accountIdsByOwner.set(assignment.ownerId, [
			...(accountIdsByOwner.get(assignment.ownerId) ?? []),
			assignment.accountId,
		]);
	const players: Resolution["players"] = knownPlayers
		.filter((player) => availablePlayerIds.has(player.playerId))
		.map((player) => ({
			id: player.playerId,
			kind: "existing",
			player,
			assignedAccountIds: accountIdsByOwner.get(player.playerId) ?? [],
		}));
	if (
		selectedAccounts.length > 0 ||
		collection.input.manualDisplayName ||
		(options.createPlayerOnEmpty === true && selectedAccounts.length === 0)
	)
		players.push({
			id: collection.newPlayerId,
			kind: "new",
			assignedAccountIds: accountIdsByOwner.get(collection.newPlayerId) ?? [],
		});
	const requiredStatus = collection.requiredAccounts.map((required) => {
		const key = requiredKey(required);
		const account = accounts.find(
			(candidate) =>
				candidate.service === required.service && candidate.keys.includes(key),
		);
		const ownerId = account ? ownerByAccount.get(account.id) : undefined;
		return {
			accountId: account?.id ?? `missing:${key}`,
			satisfied: Boolean(ownerId),
			...(ownerId ? {ownerId} : {}),
		};
	});
	const mergeAssessment = options.mergeAssessment
		? {
				...options.mergeAssessment,
				playersWithoutAccounts:
					options.mergeAssessment.absorbedPlayerIds.filter(
						(id) => (accountIdsByOwner.get(id) ?? []).length === 0,
					),
				conflictsRemaining: conflicts.length,
			}
		: null;
	const deletionCandidates = knownPlayers
		.filter((player) => {
			const initiallyOwned = selectedAccounts.some(
				(account) =>
					ownersByKey.get(account.id) === player.playerId &&
					playerKeys(player).some((key) => account.keys.includes(key)),
			);
			return (
				initiallyOwned &&
				(accountIdsByOwner.get(player.playerId) ?? []).length === 0 &&
				!mergeAssessment?.absorbedPlayerIds.includes(player.playerId)
			);
		})
		.map((player) => player.playerId);
	return {
		input: collection.input,
		players,
		accounts: selectedAccounts,
		evidence: selectedEvidence,
		assignments,
		conflicts,
		candidates: collection.candidates,
		warnings: collection.warnings,
		errors: collection.errors,
		mergeProposal,
		requiredAccounts: collection.requiredAccounts,
		newPlayerRequired:
			(accountIdsByOwner.get(collection.newPlayerId) ?? []).length > 0 ||
			(selectedAccounts.length === 0 &&
				(Boolean(collection.input.manualDisplayName) ||
					options.createPlayerOnEmpty === true)),
		requiredStatus,
		mergeAssessment,
		deletePlayerIds: options.deletePlayerIds ?? [],
		deletionCandidates,
		context: collection,
	};
}

export function canMergeAccountSet(
	accountIds: string[],
	accounts: Collection["accounts"],
): boolean {
	const selected = new Set(accountIds);
	const counts = new Map<string, number>();
	for (const account of accounts) {
		if (!selected.has(account.id)) continue;
		counts.set(account.service, (counts.get(account.service) ?? 0) + 1);
	}
	return [...counts.values()].every((count) => count <= 1);
}

function requiredKey(required: Collection["requiredAccounts"][number]): string {
	if (required.service === "racetime")
		return `racetime:${raceTimeId(required.value)}`;
	if (required.service === "speedrunCom")
		return `speedrunCom:${speedrunReference(required.value)}`;
	if (required.service === "twitch") return `twitch:${login(required.value)}`;
	return `youtube:${youtubeUrl(required.value)}`;
}

function playerKeys(
	player: import("@nanahuse/player-manager-protocol").Player,
): string[] {
	const keys: string[] = [];
	if (player.racetime) keys.push(`racetime:${player.racetime.userId}`);
	if (player.speedrunCom) keys.push(`speedrunCom:${player.speedrunCom.userId}`);
	if (player.twitch?.userId) keys.push(`twitch-id:${player.twitch.userId}`);
	if (player.twitch) keys.push(`twitch:${player.twitch.login}`);
	if (player.youtube) keys.push(`youtube:${player.youtube}`);
	return keys;
}

function reevaluate(
	resolution: Resolution,
	assignments: Assignment[],
	mergeAssessment?: {survivorId: string; absorbedPlayerIds: string[]},
): Resolution {
	const next = analyze(resolution.context, {
		assignments,
		resolvedConflictIds: resolution.conflicts
			.filter((conflict) => conflict.status === "resolved")
			.map((conflict) => conflict.id),
		...((mergeAssessment ?? resolution.mergeAssessment)
			? {
					mergeAssessment: mergeAssessment ?? {
						survivorId: resolution.mergeAssessment!.survivorId,
						absorbedPlayerIds: resolution.mergeAssessment!.absorbedPlayerIds,
					},
				}
			: {}),
		deletePlayerIds: resolution.deletePlayerIds,
	});
	const ownersWithAccounts = new Set(
		next.assignments.map((assignment) => assignment.ownerId),
	);
	return {
		...next,
		deletePlayerIds: next.deletePlayerIds.filter(
			(id) => !ownersWithAccounts.has(id),
		),
	};
}

export function approveConflict(
	resolution: Resolution,
	conflictId: string,
): Resolution {
	return {
		...resolution,
		conflicts: resolution.conflicts.map((conflict) =>
			conflict.id === conflictId ? {...conflict, status: "resolved"} : conflict,
		),
	};
}

export function assignAccount(
	resolution: Resolution,
	accountId: string,
	ownerId: string,
): Resolution {
	if (!resolution.accounts.some((account) => account.id === accountId))
		throw new DirectoryError("invalid_input", "Unknown account");
	if (!resolution.players.some((player) => player.id === ownerId))
		throw new DirectoryError("invalid_input", "Unknown assignment owner");
	const assignment = resolution.assignments.find(
		(entry) => entry.accountId === accountId,
	);
	if (!assignment)
		throw new DirectoryError("invalid_input", "Account has no assignment");
	const assignments = resolution.assignments.map((entry) =>
		entry.accountId === accountId
			? {
					...entry,
					ownerId,
					source: "user" as const,
				}
			: entry,
	);
	return reevaluate(resolution, assignments);
}

export function assignMergeSurvivor(
	resolution: Resolution,
	survivorId: string,
): Resolution {
	if (!resolution.mergeProposal?.playerIds.includes(survivorId))
		throw new DirectoryError("invalid_input", "Unknown merge survivor");
	const absorbedPlayerIds = resolution.mergeProposal.playerIds.filter(
		(id) => id !== survivorId,
	);
	const componentAccounts = new Set(resolution.mergeProposal.accountIds);
	const assignments = resolution.assignments.map((assignment) =>
		componentAccounts.has(assignment.accountId)
			? {...assignment, ownerId: survivorId, source: "inferred" as const}
			: assignment,
	);
	const next = reevaluate(resolution, assignments, {
		survivorId,
		absorbedPlayerIds,
	});
	return {
		...next,
		deletePlayerIds: [
			...new Set([...resolution.deletePlayerIds, ...absorbedPlayerIds]),
		],
		mergeAssessment: {
			...next.mergeAssessment!,
			conflictsRemaining: next.conflicts.length,
		},
	};
}
