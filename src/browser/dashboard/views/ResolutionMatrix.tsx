import type {Resolution} from "@nanahuse/player-manager-protocol";
import type {AccountChipView, ResolutionView} from "./resolution-view.ts";
import {resolutionServices} from "./resolution-view.ts";

function Chip({
	account,
	selected,
	onClick,
}: {
	account: AccountChipView;
	selected: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type='button'
			className={`account-chip${selected ? " selected" : ""}`}
			aria-pressed={selected}
			onClick={onClick}
		>
			<strong>{account.label}</strong>
			{account.profileName && account.profileName !== account.label && (
				<small>{account.profileName}</small>
			)}
			{account.evidenceLabels.length > 0 && (
				<span className='chip-evidence'>
					Evidence: {account.evidenceLabels.join(" · ")}
				</span>
			)}
			{account.states.length > 0 && (
				<span className='chip-states'>
					{account.states.map((state) => (
						<span key={state}>{state}</span>
					))}
				</span>
			)}
		</button>
	);
}

export function ResolutionMatrix({
	resolution,
	view,
	selectedAccountId,
	onSelectAccount,
	onAssign,
	onSetUsage,
	onToggleDeletion,
}: {
	resolution: Resolution;
	view: ResolutionView;
	selectedAccountId: string | null;
	onSelectAccount: (id: string) => void;
	onAssign: (accountId: string, ownerId: string) => void;
	onSetUsage: (accountId: string, use: boolean) => void;
	onToggleDeletion: (playerId: string, shouldDelete: boolean) => void;
}) {
	const selectedAccount = resolution.accounts.find(
		(account) => account.id === selectedAccountId,
	);
	const selectedAssignment = resolution.assignments.find(
		(assignment) => assignment.accountId === selectedAccountId,
	);
	const selectedChip = selectedAccountId
		? [
				...view.players.flatMap((player) =>
					resolutionServices.flatMap(({id}) => player.cells[id]),
				),
				...view.discardedAccounts,
			].find((chip) => chip.accountId === selectedAccountId)
		: undefined;
	const playerLabels = new Map(
		view.players.map((player) => [player.id, player.label]),
	);
	return (
		<section aria-labelledby='matrix-title'>
			<h2 id='matrix-title'>Resolution Matrix</h2>
			<div className='matrix-scroll'>
				<table className='resolution-matrix'>
					<thead>
						<tr>
							<th scope='col'>Player</th>
							{resolutionServices.map((service) => (
								<th
									scope='col'
									key={service.id}
								>
									{service.label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{view.players.map((player) => (
							<tr key={player.id}>
								<th
									scope='row'
									className='matrix-player'
								>
									<strong>{player.label}</strong>
									<small>
										{player.kind === "existing" ? player.id : "New Player"}
									</small>
									{player.mergeAbsorbed && (
										<span className='state-badge danger-badge'>
											Mergeで削除
										</span>
									)}
									{player.mergeSurvivor && (
										<span className='state-badge'>Merge survivor</span>
									)}
									{player.kind === "new" && (
										<span className='state-badge'>
											{view.newPlayerRequired
												? "作成予定"
												: "現在は作成されません"}
										</span>
									)}
								</th>
								{resolutionServices.map((service) => {
									const accounts = player.cells[service.id];
									return (
										<td
											key={service.id}
											className={accounts.length > 1 ? "duplicate-cell" : ""}
										>
											{accounts.length > 1 && (
												<span className='state-badge conflict-badge'>
													修正が必要: 複数Account
												</span>
											)}
											{accounts.length === 0 ? (
												<span className='muted'>—</span>
											) : (
												accounts.map((account) => (
													<Chip
														key={account.accountId}
														account={account}
														selected={account.accountId === selectedAccountId}
														onClick={() => onSelectAccount(account.accountId)}
													/>
												))
											)}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{view.discardedAccounts.length > 0 && (
				<div className='discarded-accounts'>
					<h3>使用しないAccount</h3>
					{view.discardedAccounts.map((account) => (
						<div
							className='discarded-account'
							key={account.accountId}
						>
							<Chip
								account={account}
								selected={account.accountId === selectedAccountId}
								onClick={() => onSelectAccount(account.accountId)}
							/>
							<span className='state-badge'>
								{
									resolutionServices.find(({id}) => id === account.service)
										?.label
								}
							</span>
							<button
								type='button'
								onClick={() => onSetUsage(account.accountId, true)}
							>
								使用する
							</button>
						</div>
					))}
				</div>
			)}
			{selectedAccount && selectedChip && (
				<div className='account-detail'>
					<h3>
						{
							resolutionServices.find(({id}) => id === selectedChip.service)
								?.label
						}
						: {selectedChip.label}
					</h3>
					{selectedChip.profileName && (
						<p>Profile: {selectedChip.profileName}</p>
					)}
					<p>Evidence: {selectedChip.evidenceLabels.join(" · ") || "なし"}</p>
					<p>State: {selectedChip.states.join(" · ") || "通常"}</p>
					<p>
						現在の割り当て:{" "}
						{selectedChip.discarded
							? "使用しない"
							: selectedAssignment
								? (playerLabels.get(selectedAssignment.ownerId) ??
									selectedAssignment.ownerId)
								: "未割り当て"}
					</p>
					<label className='account-usage-option'>
						<input
							type='checkbox'
							checked={selectedChip.discarded}
							disabled={selectedChip.states.includes("Required")}
							onChange={(event) =>
								onSetUsage(selectedAccount.id, !event.target.checked)
							}
						/>
						このアカウントを使用しない
					</label>
					{selectedChip.states.includes("Required") && (
						<p className='muted'>
							Required Accountのため、使用しない状態にできません。
						</p>
					)}
					{selectedChip.discarded && (
						<p className='muted'>
							このAccountは保存対象と判定から除外されています。
						</p>
					)}
					<fieldset>
						<legend>割り当て先</legend>
						{view.players
							.filter((player) => view.availableOwnerIds.includes(player.id))
							.map((player) => (
								<label
									className='owner-option'
									key={player.id}
								>
									<input
										type='radio'
										name={`owner-${selectedAccount.id}`}
										value={player.id}
										checked={selectedAssignment?.ownerId === player.id}
										onChange={() => {
											if (selectedAssignment?.ownerId !== player.id)
												onAssign(selectedAccount.id, player.id);
										}}
									/>
									{player.label}
									{player.mergeAbsorbed && (
										<small>このPlayerを選ぶとMergeを取り消します。</small>
									)}
									{player.kind === "existing" ? ` (${player.id})` : ""}
								</label>
							))}
					</fieldset>
				</div>
			)}
			{view.players.some(
				(player) => player.deletionCandidate && !player.mergeAbsorbed,
			) && (
				<div className='deletion-proposals'>
					<h3>削除提案</h3>
					{view.players
						.filter(
							(player) => player.deletionCandidate && !player.mergeAbsorbed,
						)
						.map((player) => (
							<label
								className='deletion-option'
								key={player.id}
							>
								<input
									type='checkbox'
									checked={player.doDelete}
									onChange={(event) =>
										onToggleDeletion(player.id, event.target.checked)
									}
								/>
								{player.label}:
								再割り当てまたは「このアカウントを使用しない」によってAccountが0件になりました。このPlayerを削除
							</label>
						))}
				</div>
			)}
		</section>
	);
}
