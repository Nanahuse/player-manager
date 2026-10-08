import {components, dedupeAccounts, dedupeEvidence} from "./graph.ts";
import type {Collection, Conflict, Resolution} from "./model.ts";

export function analyze(
	collection: Collection,
	resolvedConflictIds: string[] = [],
): Resolution {
	const accounts = dedupeAccounts(collection.accounts);
	const evidence = dedupeEvidence(collection.evidence);
	const knownPlayers = collection.directory.players;
	const ownersByKey = new Map<string, string>();
	for (const player of knownPlayers) {
		for (const account of accounts)
			if (account.keys.some((key) => playerKeys(player).includes(key)))
				ownersByKey.set(account.id, player.playerId);
	}
	const groups = components(accounts, evidence);
	const relevant = new Set<string>();
	const playerIds = new Set<string>();
	for (const group of groups) {
		const related = group.some((id) => collection.inputAccountIds.includes(id));
		if (!related) continue;
		for (const id of group) {
			relevant.add(id);
			const owner = ownersByKey.get(id);
			if (owner) playerIds.add(owner);
		}
	}
	const selectedAccounts = accounts.filter(({id}) => relevant.has(id));
	const selectedEvidence = evidence.filter((set) =>
		set.accounts.some((id) => relevant.has(id)),
	);
	const newPlayerId = collection.newPlayerId;
	const assignments = selectedAccounts.map((account) => {
		const current = ownersByKey.get(account.id);
		if (current)
			return {accountId: account.id, ownerId: current, source: "user" as const};
		const group = groups.find((g) => g.includes(account.id)) ?? [];
		const existing = [
			...new Set(
				group
					.map((id) => ownersByKey.get(id))
					.filter((id): id is string => Boolean(id)),
			),
		];
		if (existing.length === 1)
			return {
				accountId: account.id,
				ownerId: existing[0]!,
				source: "inferred" as const,
			};
		return {
			accountId: account.id,
			ownerId: newPlayerId,
			source: "new" as const,
		};
	});
	const assignmentOwner = new Map(
		assignments.map((a) => [a.accountId, a.ownerId]),
	);
	const conflicts: Conflict[] = selectedEvidence.flatMap((set) => {
		const ownerIds = [
			...new Set(
				set.accounts
					.map((id) => assignmentOwner.get(id))
					.filter((id): id is string => Boolean(id)),
			),
		];
		if (ownerIds.length < 2) return [];
		return [
			{
				id: `conflict:${set.id}`,
				evidenceId: set.id,
				ownerIds,
				status: resolvedConflictIds.includes(`conflict:${set.id}`)
					? "resolved"
					: "conflict",
			},
		];
	});
	const existingInGroups = groups
		.filter((g) => g.some((id) => collection.inputAccountIds.includes(id)))
		.map((g) => [
			...new Set(
				g
					.map((id) => ownersByKey.get(id))
					.filter((id): id is string => Boolean(id)),
			),
		])
		.filter((ids) => ids.length > 1);
	const mergeIds = existingInGroups.find((ids) =>
		ids.every((id) => playerIds.has(id)),
	);
	const mergeProposal =
		mergeIds &&
		collection.candidates.length === 0 &&
		collection.errors.length === 0
			? {
					playerIds: mergeIds,
					reason:
						"Players are connected by non-User account evidence with no unresolved candidates or lookup errors.",
				}
			: null;
	const players: Resolution["players"] = knownPlayers
		.filter((p) => playerIds.has(p.playerId))
		.map((player) => ({id: player.playerId, kind: "existing", player}));
	if (
		selectedAccounts.some(
			(a) =>
				assignments.find((x) => x.accountId === a.id)?.ownerId === newPlayerId,
		)
	)
		players.push({id: newPlayerId, kind: "new"});
	return {
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
	};
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

export function approveConflict(
	resolution: Resolution,
	conflictId: string,
): Resolution {
	return {
		...resolution,
		conflicts: resolution.conflicts.map((c) =>
			c.id === conflictId ? {...c, status: "resolved"} : c,
		),
	};
}

export function assignAccount(
	resolution: Resolution,
	accountId: string,
	ownerId: string,
): Resolution {
	return {
		...resolution,
		assignments: resolution.assignments.map((a) =>
			a.accountId === accountId
				? {...a, ownerId, source: "inferred" as const}
				: a,
		),
	};
}

export function assignMergeSurvivor(
	resolution: Resolution,
	survivorId: string,
): Resolution {
	if (!resolution.mergeProposal?.playerIds.includes(survivorId))
		throw new Error("Unknown merge survivor");
	const losingIds = new Set(
		resolution.mergeProposal.playerIds.filter((id) => id !== survivorId),
	);
	return {
		...resolution,
		assignments: resolution.assignments.map((a) =>
			losingIds.has(a.ownerId) ? {...a, ownerId: survivorId} : a,
		),
	};
}
