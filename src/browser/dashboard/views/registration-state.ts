import type {
	MatchingInput,
	MergeProposal,
	Resolution,
} from "@nanahuse/player-manager-protocol";

function inputKey(input: MatchingInput) {
	return JSON.stringify({
		racetime: input.racetime ?? null,
		speedrunCom: input.speedrunCom ?? null,
		twitch: input.twitch ? {login: input.twitch.login} : null,
		youtube: input.youtube ?? null,
		profileAccounts: input.profileAccounts ?? [],
		accountRequests: input.accountRequests ?? [],
	});
}

export function isInputDirty(
	draftInput: MatchingInput,
	sessionInput: MatchingInput,
) {
	return inputKey(draftInput) !== inputKey(sessionInput);
}

export function nextMergeSurvivorSelection(
	current: string,
	proposal: Pick<MergeProposal, "playerIds"> | null,
) {
	return proposal?.playerIds.includes(current) ? current : "";
}

export function newPlayerRegistration(resolution: Resolution, name: string) {
	const player = resolution.players.find((entry) => entry.kind === "new");
	const validIds = new Set(resolution.accounts.map((account) => account.id));
	const discarded = new Set(resolution.discardedAccountIds);
	const accountCount = new Set(
		resolution.assignments
			.filter(
				(assignment) =>
					assignment.ownerId === player?.id &&
					validIds.has(assignment.accountId) &&
					!discarded.has(assignment.accountId),
			)
			.map((assignment) => assignment.accountId),
	).size;
	const hasName = Boolean(name.trim());
	const hasActiveAssignment = resolution.assignments.some(
		({accountId}) => validIds.has(accountId) && !discarded.has(accountId),
	);
	const hasExistingRemoval =
		resolution.deletePlayerIds.length > 0 ||
		resolution.players.some(
			(entry) =>
				entry.kind === "existing" &&
				entry.player.accounts?.some((account) => discarded.has(account.id)),
		);
	return {
		accountCount,
		needsConfirmation: hasName && accountCount === 0,
		empty:
			!hasName &&
			accountCount === 0 &&
			(resolution.newPlayerRequired ||
				(!hasActiveAssignment && !hasExistingRemoval)),
	};
}
