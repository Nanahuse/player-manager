import {
	type Resolution,
	resolveDisplayName,
} from "@nanahuse/player-manager-protocol";

export function MergeProposalPanel({
	resolution,
	selectedSurvivor,
	onSelect,
	onApply,
	onKeepSeparate,
}: {
	resolution: Resolution;
	selectedSurvivor: string;
	onSelect: (playerId: string) => void;
	onApply: () => void;
	onKeepSeparate: () => void;
}) {
	const proposal = resolution.mergeProposal;
	const assessment = resolution.mergeAssessment;
	if (!proposal && !assessment) return null;
	const names = new Map(
		resolution.players.map((player) => [
			player.id,
			player.kind === "existing"
				? resolveDisplayName(player.player)
				: "New Player",
		]),
	);
	return (
		<section>
			<h2>Merge proposal</h2>
			{assessment ? (
				<>
					<p>
						{assessment.absorbedPlayerIds
							.map((id) => names.get(id) ?? id)
							.join(" と ")}
						を{names.get(assessment.survivorId) ?? assessment.survivorId}
						へMerge中です。
					</p>
					<button
						type='button'
						onClick={onKeepSeparate}
					>
						Mergeを取り消す
					</button>
				</>
			) : proposal ? (
				<>
					<p>
						{proposal.playerIds.map((id) => names.get(id) ?? id).join(" と ")}{" "}
						が同一identityとして接続されています。
					</p>
					<fieldset>
						<legend>Merge survivor</legend>
						{proposal.playerIds.map((playerId) => (
							<label
								className='owner-option'
								key={playerId}
							>
								<input
									type='radio'
									name='merge-survivor'
									value={playerId}
									checked={selectedSurvivor === playerId}
									onChange={() => onSelect(playerId)}
								/>
								{names.get(playerId) ?? playerId}
							</label>
						))}
					</fieldset>
					<button
						type='button'
						disabled={!selectedSurvivor}
						onClick={onApply}
					>
						Mergeを適用
					</button>
					<button
						type='button'
						disabled={resolution.mergeDecision === "keepSeparate"}
						onClick={onKeepSeparate}
					>
						Mergeしない
					</button>
					{resolution.mergeDecision === "keepSeparate" && (
						<p className='state-badge'>Playerを統合せずに維持します。</p>
					)}
				</>
			) : null}
		</section>
	);
}
