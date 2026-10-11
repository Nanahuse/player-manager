import {
	type Resolution,
	resolveDisplayName,
} from "@nanahuse/player-manager-protocol";
import {
	confirmCurrentAssignment,
	groupCandidatesByOrigin,
} from "./candidate-resolution.ts";

export function CandidateReview({
	resolution,
	onConfirm,
}: {
	resolution: Resolution;
	onConfirm: (accountId: string, ownerId: string) => void;
}) {
	if (!resolution.candidates.length) return null;
	return (
		<section>
			<h2>Candidate Review</h2>
			{groupCandidatesByOrigin(
				resolution.candidates,
				resolution.assignments,
				resolution.confirmedCandidateAccountIds,
			).map((group) => {
				const owner = resolution.players.find(
					(player) => player.id === group.assignment?.ownerId,
				);
				const ownerName =
					owner?.kind === "existing"
						? `${resolveDisplayName(owner.player)} (${owner.id})`
						: owner?.kind === "new"
							? "New Player"
							: "未割り当て";
				const confirmed = group.confirmed;
				return (
					<article
						className='candidate-group'
						key={group.originAccountId}
					>
						<h3>{group.originAccountId}</h3>
						<p>現在の割り当て: {ownerName}</p>
						{confirmed ? (
							<p className='state-badge'>確認済み</p>
						) : (
							<p className='muted'>未確認</p>
						)}
						<ul>
							{group.candidates.map((candidate) => (
								<li key={candidate.id}>
									{candidate.service === "speedrunCom"
										? "Speedrun.com"
										: "RaceTime"}
									候補: {candidate.profile.name} / {candidate.profile.userId}
								</li>
							))}
						</ul>
						{group.assignment && !confirmed && (
							<button
								type='button'
								onClick={() => confirmCurrentAssignment(group, onConfirm)}
							>
								現在の割り当てで確定
							</button>
						)}
					</article>
				);
			})}
		</section>
	);
}
