import {
	type Resolution,
	resolveDisplayName,
} from "@nanahuse/player-manager-protocol";
import {ProfileLink} from "./ProfileLink.tsx";
import type {ResolutionView} from "./resolution-view.ts";

export function MergeProposalPanel({
	resolution,
	view,
	selectedSurvivor,
	onSelect,
	onApply,
	onKeepSeparate,
}: {
	resolution: Resolution;
	view: ResolutionView;
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
	const playerAccounts = (playerId: string) =>
		view.accounts.filter((account) => account.ownerId === playerId);
	const renderPlayerAccounts = (playerId: string) => {
		const accounts = playerAccounts(playerId);
		return accounts.length ? (
			<ul>
				{accounts.map((account) => (
					<li key={account.accountId}>
						{view.services.find(({id}) => id === account.service)?.label ??
							account.service}
						: {account.profileName ?? account.label}{" "}
						<ProfileLink
							profileUrl={account.profileUrl}
							speedrunUserId={account.speedrunUserId}
						/>
					</li>
				))}
			</ul>
		) : (
			<p className='muted'>Accountはありません。</p>
		);
	};
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
					{[assessment.survivorId, ...assessment.absorbedPlayerIds].map(
						(id) => (
							<div key={id}>
								<strong>{names.get(id) ?? id}</strong>
								{renderPlayerAccounts(id)}
							</div>
						),
					)}
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
					{proposal.playerIds.map((id) => (
						<div key={id}>
							<strong>{names.get(id) ?? id}</strong>
							{renderPlayerAccounts(id)}
						</div>
					))}
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
