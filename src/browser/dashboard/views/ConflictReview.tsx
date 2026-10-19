import type {Resolution} from "@nanahuse/player-manager-protocol";
import {ProfileLink} from "./ProfileLink.tsx";
import type {ResolutionView} from "./resolution-view.ts";

const evidenceName = {
	user: "User",
	input: "Input",
	racetime: "RaceTime",
	src: "SRC",
} as const;

export function ConflictReview({
	resolution,
	view,
	onApprove,
	showEvidence = true,
}: {
	showEvidence?: boolean;
	resolution: Resolution;
	view: ResolutionView;
	onApprove: (conflictId: string) => void;
}) {
	if (!resolution.conflicts.length) return null;
	const accounts = new Map(
		view.accounts.map((account) => [account.accountId, account]),
	);
	const labelByPlayer = new Map(
		view.players.map((player) => [player.id, player.label]),
	);
	return (
		<section>
			<h2>Conflict Resolution</h2>
			{resolution.conflicts.map((conflict) => {
				const evidence = resolution.evidence.find(
					(item) => item.id === conflict.evidenceId,
				);
				return (
					<article
						className='conflict-item'
						key={conflict.id}
					>
						<h3>
							{!showEvidence
								? "Accountの競合"
								: evidence
									? `${evidenceName[evidence.source]} evidence`
									: "Evidence"}
						</h3>
						<ul>
							{evidence?.accounts.map((id) => {
								const account = accounts.get(id);
								const service =
									view.services.find(
										({id: serviceId}) => serviceId === account?.service,
									)?.label ??
									account?.service ??
									"Account";
								return (
									<li key={id}>
										<strong>
											{service}:{" "}
											<ProfileLink
												profileUrl={account?.profileUrl}
												speedrunUserId={account?.speedrunUserId}
											>
												{account?.profileName ?? account?.label ?? id}
											</ProfileLink>
										</strong>
										<p>
											現在の割り当て先:{" "}
											{labelByPlayer.get(account?.ownerId ?? "") ??
												"未割り当て"}
										</p>
									</li>
								);
							})}
						</ul>
						{conflict.status === "conflict" ? (
							<button
								type='button'
								onClick={() => onApprove(conflict.id)}
							>
								この分離状態を承認
							</button>
						) : (
							<span className='state-badge'>Resolved</span>
						)}
					</article>
				);
			})}
		</section>
	);
}
