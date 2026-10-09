import type {Assignment, Candidate} from "@nanahuse/player-manager-protocol";

export type CandidateOriginGroup = {
	originAccountId: string;
	candidates: Candidate[];
	assignment: Assignment | undefined;
};

export function groupCandidatesByOrigin(
	candidates: Candidate[],
	assignments: Assignment[],
): CandidateOriginGroup[] {
	const groups = new Map<string, CandidateOriginGroup>();
	for (const candidate of candidates) {
		let group = groups.get(candidate.originAccountId);
		if (!group) {
			group = {
				originAccountId: candidate.originAccountId,
				candidates: [],
				assignment: assignments.find(
					(assignment) => assignment.accountId === candidate.originAccountId,
				),
			};
			groups.set(candidate.originAccountId, group);
		}
		group.candidates.push(candidate);
	}
	return [...groups.values()];
}

export function confirmCurrentAssignment(
	group: CandidateOriginGroup,
	assign: (accountId: string, ownerId: string) => void,
) {
	if (!group.assignment || group.assignment.source === "user") return;
	assign(group.originAccountId, group.assignment.ownerId);
}
