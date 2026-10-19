import {
	type Resolution,
	resolveDisplayName,
} from "@nanahuse/player-manager-protocol";
import {
	confirmCurrentAssignment,
	groupCandidatesByOrigin,
} from "./candidate-resolution.ts";
import {ProfileLink} from "./ProfileLink.tsx";
import type {ResolutionView} from "./resolution-view.ts";
import {candidateProfileUrl} from "./resolution-view.ts";

export function CandidateReview({
	resolution,
	view,
	onConfirm,
}: {
	resolution: Resolution;
	view: ResolutionView;
	onConfirm: (accountId: string, ownerId: string) => void;
}) {
	if (!resolution.candidates.length) return null;
	const originAccounts = new Map(
		view.accounts.map((account) => [account.accountId, account]),
	);
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
						<h3>
							<ProfileLink
								accountId={
									originAccounts.get(group.originAccountId)?.savedAccountId
								}
								profileUrl={
									originAccounts.get(group.originAccountId)?.profileUrl
								}
								speedrunUserId={
									originAccounts.get(group.originAccountId)?.speedrunUserId
								}
							>
								{originAccounts.get(group.originAccountId)?.profileName ??
									originAccounts.get(group.originAccountId)?.label ??
									group.originAccountId}
							</ProfileLink>
						</h3>
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
									候補:
									<ProfileLink
										profileUrl={candidateProfileUrl(
											candidate.service,
											candidate.profile,
										)}
										speedrunUserId={
											candidate.service === "speedrunCom"
												? candidate.profile.userId
												: null
										}
									>
										{candidate.profile.name}
									</ProfileLink>{" "}
									/ {candidate.profile.userId}
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
