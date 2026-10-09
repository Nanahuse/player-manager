import {
	type Resolution,
	resolveDisplayName,
} from "@nanahuse/player-manager-protocol";

export function MergeProposalPanel({
	resolution,
	selectedSurvivor,
	onSelect,
	onApply,
}: {
	resolution: Resolution;
	selectedSurvivor: string;
	onSelect: (playerId: string) => void;
	onApply: () => void;
}) {
	const proposal = resolution.mergeProposal;
	if (!proposal) return null;
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
			<p>
				{proposal.playerIds.map((id) => names.get(id) ?? id).join(" と ")}{" "}
				は同一identityとして接続されています。
			</p>
			<fieldset>
				<legend>残すPlayer</legend>
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
		</section>
	);
}
