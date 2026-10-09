import type {Resolution} from "@nanahuse/player-manager-protocol";
import type {ResolutionView} from "./resolution-view.ts";

export function ResolutionIssues({
	resolution,
	view,
}: {
	resolution: Resolution;
	view: ResolutionView;
}) {
	const {issues} = view;
	const summary = [
		issues.unresolvedConflicts > 0 &&
			`${issues.unresolvedConflicts}件のConflict`,
		issues.candidateGroups > 0 && `${issues.candidateGroups}件の検索候補確認`,
		issues.mergeNeedsSurvivor && "Merge先の選択が必要",
		issues.unsatisfiedRequired > 0 &&
			`Required Account ${issues.unsatisfiedRequired}件が未解決`,
		...issues.duplicateCells.map(({playerId, service}) => {
			const player = view.players.find((entry) => entry.id === playerId);
			return `${player?.label ?? playerId} / ${service} に複数Account`;
		}),
	].filter((item): item is string => typeof item === "string");
	return (
		<section aria-labelledby='resolution-issues-title'>
			<h2 id='resolution-issues-title'>解決が必要</h2>
			{resolution.errors.length > 0 && (
				<div
					className='notice'
					role='alert'
				>
					<strong>探索エラー</strong>
					<ul>
						{resolution.errors.map((error, index) => (
							<li key={`${index}-${error}`}>{error}</li>
						))}
					</ul>
				</div>
			)}
			{resolution.warnings.length > 0 && (
				<div className='notice warning'>
					<strong>警告</strong>
					<ul>
						{resolution.warnings.map((warning, index) => (
							<li key={`${index}-${warning.operation}`}>
								{warning.operation}: {warning.message}
							</li>
						))}
					</ul>
				</div>
			)}
			{summary.length > 0 ? (
				<ul className='issue-list'>
					{summary.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
			) : (
				<p className='muted'>現在、対応が必要な項目はありません。</p>
			)}
		</section>
	);
}
