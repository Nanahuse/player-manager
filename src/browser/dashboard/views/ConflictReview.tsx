import type {Resolution} from "@nanahuse/player-manager-protocol";
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
}: {
	resolution: Resolution;
	view: ResolutionView;
	onApprove: (conflictId: string) => void;
}) {
	if (!resolution.conflicts.length) return null;
	const chipById = new Map(
		view.players.flatMap((player) =>
			Object.values(player.cells)
				.flat()
				.map((chip) => [chip.accountId, chip] as const),
		),
	);
	const ownerByAccount = new Map(
		resolution.assignments.map((item) => [item.accountId, item.ownerId]),
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
							{evidence
								? `${evidenceName[evidence.source]} evidence`
								: "Evidence"}
						</h3>
						<p>
							{evidence?.accounts
								.map((id) => chipById.get(id)?.label ?? id)
								.join(" ↔ ")}
						</p>
						<p>
							現在:{" "}
							{evidence?.accounts
								.map(
									(id) =>
										`${chipById.get(id)?.label ?? id} → ${labelByPlayer.get(ownerByAccount.get(id) ?? "") ?? "未割り当て"}`,
								)
								.join(" / ")}
						</p>
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
