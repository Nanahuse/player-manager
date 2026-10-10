import {
	DirectoryError,
	login,
	speedrunReference,
	youtubeUrl,
} from "../domain/player.ts";
import {raceTimeId} from "../extension/racetime.ts";
import {components, dedupeAccounts, dedupeEvidence} from "./graph.ts";
import type {
	Assignment,
	Collection,
	Conflict,
	Resolution,
	ResolutionChoices,
} from "./model.ts";

type AnalysisOptions = {
	createPlayerOnEmpty?: boolean;
	choices?: ResolutionChoices;
	discardedAccountIds?: string[];
	resolvedConflictIds?: string[];
};

export function analyze(
	collection: Collection,
	options: AnalysisOptions = {},
): Resolution {
	const accounts = dedupeAccounts(collection.accounts);
	const evidence = dedupeEvidence(collection.evidence);
	const discardedAccountIds = [...new Set(options.discardedAccountIds ?? [])];
	const discarded = new Set(discardedAccountIds);
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
	const allGroups = components(accounts, evidence);
	const relevant = new Set<string>();
	for (const group of allGroups)
		if (group.some((id) => collection.seedAccountIds.includes(id)))
			for (const id of group) relevant.add(id);
	const selectedAccounts = accounts.filter(({id}) => relevant.has(id));
	const selectedEvidence = evidence.filter((set) =>
		set.accounts.some((id) => relevant.has(id)),
	);
	const activeAccounts = selectedAccounts.filter(({id}) => !discarded.has(id));
	const activeIds = new Set(activeAccounts.map(({id}) => id));
	const activeEvidence = dedupeEvidence(
		selectedEvidence.flatMap((set) => {
			const activeSet = set.accounts.filter((id) => activeIds.has(id));
			return activeSet.length ? [{...set, accounts: activeSet}] : [];
		}),
	);
	const displayEvidenceById = new Map(
		activeEvidence.map((set) => [set.id, set]),
	);
	for (const set of selectedEvidence) displayEvidenceById.set(set.id, set);
	const groups = components(activeAccounts, activeEvidence);
	const directoryPlayerIds = new Set(
		knownPlayers.map(({playerId}) => playerId),
	);
	const validOwnerIds = new Set([
		...directoryPlayerIds,
		collection.newPlayerId,
	]);
	const previousChoices = options.choices ?? {
		assignments: [],
		merge: null,
		deletePlayerIds: [],
	};
	const explicitAssignments = previousChoices.assignments.filter(
		(assignment) =>
			selectedAccounts.some((account) => account.id === assignment.accountId) &&
			validOwnerIds.has(assignment.ownerId),
	);
	const explicitByAccount = new Map(
		explicitAssignments.map((assignment) => [assignment.accountId, assignment]),
	);
	const currentAssignments: Assignment[] = activeAccounts.map((account) => {
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
	const baseAssignments = currentAssignments.map(
		(assignment) => explicitByAccount.get(assignment.accountId) ?? assignment,
	);
	const baseOwnerByAccount = new Map(
		baseAssignments.map((assignment) => [
			assignment.accountId,
			assignment.ownerId,
		]),
	);
	const mergeComponent = groups
		.map((group) => ({
			accountIds: group,
			playerIds: [
				...new Set(
					group.flatMap((accountId) => {
						const ownerId = ownersByKey.get(accountId);
						return ownerId && baseOwnerByAccount.get(accountId) === ownerId
							? [ownerId]
							: [];
					}),
				),
			],
		}))
		.find(
			({playerIds}) =>
				playerIds.length > 1 &&
				playerIds.every((id) =>
					activeAccounts.some(
						(account) => baseOwnerByAccount.get(account.id) === id,
					),
				),
		);
	const baseMergeProposal =
		mergeComponent &&
		!collection.candidates.some(
			(candidate) =>
				!discarded.has(candidate.originAccountId) &&
				!explicitByAccount.has(candidate.originAccountId),
		) &&
		collection.errors.length === 0 &&
		canMergeAccountSet(mergeComponent.accountIds, activeAccounts)
			? {
					playerIds: mergeComponent.playerIds,
					accountIds: mergeComponent.accountIds,
					reason:
						"Players are connected by account evidence with no unresolved candidates or lookup errors.",
				}
			: null;
	const selectedMerge =
		baseMergeProposal &&
		previousChoices.merge &&
		baseMergeProposal.playerIds.includes(previousChoices.merge.survivorId) &&
		baseMergeProposal.playerIds.length ===
			previousChoices.merge.playerIds.length &&
		baseMergeProposal.playerIds.every((id) =>
			previousChoices.merge!.playerIds.includes(id),
		)
			? {
					survivorId: previousChoices.merge.survivorId,
					playerIds: baseMergeProposal.playerIds,
				}
			: null;
	const assignments = selectedMerge
		? baseAssignments.map((assignment) =>
				baseMergeProposal!.accountIds.includes(assignment.accountId)
					? {
							...assignment,
							ownerId: selectedMerge.survivorId,
							source: "inferred" as const,
						}
					: assignment,
			)
		: baseAssignments;
	const ownerByAccount = new Map(
		assignments.map((assignment) => [assignment.accountId, assignment.ownerId]),
	);
	const conflicts: Conflict[] = activeEvidence.flatMap((set) => {
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
	const mergeProposal = selectedMerge ? null : baseMergeProposal;
	const activeAssignments = assignments;
	const availablePlayerIds = new Set([
		...selectedAccounts
			.map((account) => ownersByKey.get(account.id))
			.filter((id): id is string => Boolean(id)),
		...assignments.map((assignment) => assignment.ownerId),
		...(selectedMerge?.playerIds ?? []),
		...previousChoices.deletePlayerIds,
	]);
	const accountIdsByOwner = new Map<string, string[]>();
	for (const assignment of activeAssignments)
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
		((options.createPlayerOnEmpty ?? collection.createPlayerOnEmpty) === true &&
			activeAccounts.length === 0)
	)
		players.push({
			id: collection.newPlayerId,
			kind: "new",
			assignedAccountIds: accountIdsByOwner.get(collection.newPlayerId) ?? [],
		});
	const requiredStatus = collection.requiredAccounts.map((required) => {
		const key = requiredKey(required);
		const account = activeAccounts.find(
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
	const mergeAssessment = selectedMerge
		? {
				survivorId: selectedMerge.survivorId,
				absorbedPlayerIds: selectedMerge.playerIds.filter(
					(id) => id !== selectedMerge.survivorId,
				),
				playersWithoutAccounts: selectedMerge.playerIds.filter(
					(id) =>
						id !== selectedMerge.survivorId &&
						(accountIdsByOwner.get(id) ?? []).length === 0,
				),
				conflictsRemaining: conflicts.length,
			}
		: null;
	const deletePlayerIds = previousChoices.deletePlayerIds.filter(
		(id) =>
			directoryPlayerIds.has(id) &&
			(accountIdsByOwner.get(id) ?? []).length === 0,
	);
	const absorbedPlayerIds = mergeAssessment?.absorbedPlayerIds ?? [];
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
				!absorbedPlayerIds.includes(player.playerId)
			);
		})
		.map((player) => player.playerId);
	return {
		input: collection.input,
		discardedAccountIds,
		confirmedCandidateAccountIds: collection.candidates
			.filter(
				(candidate) =>
					!discarded.has(candidate.originAccountId) &&
					explicitByAccount.has(candidate.originAccountId),
			)
			.map((candidate) => candidate.originAccountId)
			.filter((id, index, all) => all.indexOf(id) === index),
		players,
		accounts: selectedAccounts,
		evidence: [...displayEvidenceById.values()],
		assignments,
		conflicts,
		candidates: collection.candidates.filter(
			(candidate) => !discarded.has(candidate.originAccountId),
		),
		warnings: collection.warnings,
		errors: collection.errors,
		mergeProposal,
		requiredAccounts: collection.requiredAccounts,
		newPlayerRequired:
			(accountIdsByOwner.get(collection.newPlayerId) ?? []).length > 0 ||
			(activeAccounts.length === 0 &&
				(Boolean(collection.input.manualDisplayName) ||
					(options.createPlayerOnEmpty ?? collection.createPlayerOnEmpty) ===
						true)),
		requiredStatus,
		mergeAssessment,
		deletePlayerIds: [...new Set([...deletePlayerIds, ...absorbedPlayerIds])],
		deletionCandidates,
		context: collection,
		choices: {
			assignments: explicitAssignments,
			merge: selectedMerge,
			deletePlayerIds,
		},
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
	choices: ResolutionChoices,
	discardedAccountIds = resolution.discardedAccountIds,
): Resolution {
	return analyze(resolution.context, {
		choices,
		discardedAccountIds,
		resolvedConflictIds: resolution.conflicts
			.filter((conflict) => conflict.status === "resolved")
			.map((conflict) => conflict.id),
	});
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
	const assignments = resolution.choices.assignments.filter(
		(entry) => entry.accountId !== accountId,
	);
	assignments.push({accountId, ownerId, source: "user"});
	return reevaluate(
		resolution,
		{...resolution.choices, assignments},
		resolution.discardedAccountIds.filter((id) => id !== accountId),
	);
}

export function setAccountUsage(
	resolution: Resolution,
	accountId: string,
	use: boolean,
): Resolution {
	if (!resolution.accounts.some((account) => account.id === accountId))
		throw new DirectoryError("invalid_input", "Unknown account");
	const discarded = new Set(resolution.discardedAccountIds);
	if (
		!use &&
		resolution.requiredStatus.some((entry) => entry.accountId === accountId)
	)
		throw new DirectoryError(
			"invalid_input",
			"Required accounts cannot be marked unused",
		);
	const isDiscarded = discarded.has(accountId);
	if (use === !isDiscarded) return resolution;
	if (use) discarded.delete(accountId);
	else discarded.add(accountId);
	return reevaluate(resolution, resolution.choices, [...discarded]);
}

export function assignMergeSurvivor(
	resolution: Resolution,
	survivorId: string,
): Resolution {
	if (!resolution.mergeProposal?.playerIds.includes(survivorId))
		throw new DirectoryError("invalid_input", "Unknown merge survivor");
	return reevaluate(resolution, {
		...resolution.choices,
		merge: {survivorId, playerIds: resolution.mergeProposal.playerIds},
	});
}

export function setPlayerDeletion(
	resolution: Resolution,
	playerId: string,
	shouldDelete: boolean,
): Resolution {
	const player = resolution.players.find(
		(entry) => entry.id === playerId && entry.kind === "existing",
	);
	if (!player)
		throw new DirectoryError(
			"player_not_found",
			"Delete target not found in Resolution",
		);
	if (
		shouldDelete &&
		resolution.assignments.some((assignment) => assignment.ownerId === playerId)
	)
		throw new DirectoryError(
			"invalid_input",
			"Reassign or remove accounts before deleting Player",
		);
	const deletePlayerIds = shouldDelete
		? [...new Set([...resolution.choices.deletePlayerIds, playerId])]
		: resolution.choices.deletePlayerIds.filter((id) => id !== playerId);
	return reevaluate(resolution, {...resolution.choices, deletePlayerIds});
}
