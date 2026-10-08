import type {Assignment, Candidate} from "@nanahuse/player-manager-protocol";

export type CandidateGroup = {
	originAccountId: string;
	candidates: Candidate[];
	assignment: Assignment | undefined;
};

export function groupCandidatesByOrigin(
	candidates: Candidate[],
	assignments: Assignment[],
): CandidateGroup[] {
	const groups = new Map<string, CandidateGroup>();
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
	group: CandidateGroup,
	assign: (accountId: string, ownerId: string) => void,
) {
	if (!group.assignment || group.assignment.source === "user") return;
	assign(group.originAccountId, group.assignment.ownerId);
}
