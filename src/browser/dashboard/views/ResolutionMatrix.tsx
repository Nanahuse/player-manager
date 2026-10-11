import type {AccountChipView, ResolutionView} from "./resolution-view.ts";

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
			<span className='state-badge'>
				{account.role === "primary" ? "Primary" : "Sub"}
			</span>
			{account.roleConflict && (
				<span className='state-badge danger-badge'>Primary選択が必要</span>
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
	view,
	selectedAccountId,
	onSelectAccount,
	onAssign,
	onDiscard,
	onSetPrimary,
	onToggleDeletion,
}: {
	view: ResolutionView;
	selectedAccountId: string | null;
	onSelectAccount: (id: string) => void;
	onAssign: (accountId: string, ownerId: string) => void;
	onDiscard: (accountId: string) => void;
	onSetPrimary: (accountId: string) => void;
	onToggleDeletion: (playerId: string, shouldDelete: boolean) => void;
}) {
	const selectedChip = selectedAccountId
		? [
				...view.players.flatMap((player) =>
					view.services.flatMap(({id}) => player.cells[id] ?? []),
				),
				...view.discardedAccounts,
			].find((chip) => chip.accountId === selectedAccountId)
		: undefined;
	const renderCells = (
		serviceId: string,
		accounts: AccountChipView[],
		showDuplicateWarning: boolean,
	) => (
		<td
			key={serviceId}
			className={
				showDuplicateWarning && accounts.length > 1 ? "duplicate-cell" : ""
			}
		>
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
	return (
		<section aria-labelledby='matrix-title'>
			<h2 id='matrix-title'>Resolution Matrix</h2>
			<div className='matrix-scroll'>
				<table className='resolution-matrix'>
					<thead>
						<tr>
							<th scope='col'>Player</th>
							{view.services.map((service) => (
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
								{view.services.map((service) =>
									renderCells(
										service.id,
										player.cells[service.id] ?? [],
										false,
									),
								)}
							</tr>
						))}
						<tr>
							<th
								scope='row'
								className='matrix-player'
							>
								使用しない
							</th>
							{view.services.map((service) =>
								renderCells(
									service.id,
									view.discardedAccounts.filter(
										(account) => account.service === service.id,
									),
									false,
								),
							)}
						</tr>
					</tbody>
				</table>
			</div>
			{selectedChip && (
				<div className='account-detail'>
					<h3>
						{view.services.find(({id}) => id === selectedChip.service)?.label}:{" "}
						{selectedChip.label}
					</h3>
					{selectedChip.profileName && (
						<p>Profile: {selectedChip.profileName}</p>
					)}
					<p>Evidence: {selectedChip.evidenceLabels.join(" · ") || "なし"}</p>
					<p>State: {selectedChip.states.join(" · ") || "通常"}</p>
					{selectedChip.discarded && (
						<p className='muted'>
							このAccountは保存対象と判定から除外されています。
						</p>
					)}
					<fieldset>
						<legend>割り当て先</legend>
						{view.players.map((player) => (
							<label
								className='owner-option'
								key={player.id}
							>
								<input
									type='radio'
									name={`owner-${selectedChip.accountId}`}
									value={player.id}
									checked={
										!selectedChip.discarded &&
										selectedChip.ownerId === player.id
									}
									onChange={() => onAssign(selectedChip.accountId, player.id)}
								/>
								{player.label}
								{player.mergeAbsorbed && (
									<small>このPlayerを選ぶとMergeを取り消します。</small>
								)}
								{player.kind === "existing" ? ` (${player.id})` : ""}
							</label>
						))}
						<label className='owner-option'>
							<input
								type='radio'
								name={`owner-${selectedChip.accountId}`}
								value='unused'
								checked={selectedChip.discarded}
								disabled={selectedChip.states.includes("Required")}
								onChange={() => onDiscard(selectedChip.accountId)}
							/>
							使用しない
						</label>
					</fieldset>
					{!selectedChip.discarded && selectedChip.ownerId && (
						<button
							type='button'
							disabled={
								selectedChip.role === "primary" && !selectedChip.roleConflict
							}
							onClick={() => onSetPrimary(selectedChip.accountId)}
						>
							このAccountをPrimaryにする
						</button>
					)}
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
