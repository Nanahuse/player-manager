import type {
	MatchingInput,
	MergeProposal,
} from "@nanahuse/player-manager-protocol";

function inputKey(input: MatchingInput) {
	return JSON.stringify({
		racetime: input.racetime ?? null,
		speedrunCom: input.speedrunCom ?? null,
		twitch: input.twitch
			? {login: input.twitch.login, userId: input.twitch.userId ?? null}
			: null,
		youtube: input.youtube ?? null,
		manualDisplayName: input.manualDisplayName ?? null,
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
