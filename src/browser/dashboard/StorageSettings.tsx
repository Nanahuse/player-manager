import {useEffect, useState} from "react";
import type {StorageStatus} from "../../protocol/index.ts";
export function StorageSettings({
	busy,
	ready,
	configure,
}: {
	busy: boolean;
	ready: boolean;
	configure: (value: string) => void;
}) {
	const [status, setStatus] = useState<StorageStatus | null>(null);
	const [value, setValue] = useState("");
	useEffect(() => {
		const rep = nodecg.Replicant<StorageStatus>("player-directory-storage");
		const change = (s: StorageStatus | undefined) => {
			if (s) setStatus(JSON.parse(JSON.stringify(s)) as StorageStatus);
		};
		rep.on("change", change);
		return () => {
			rep.removeListener("change", change);
		};
	}, []);
	useEffect(() => {
		setValue(status?.spreadsheetId ?? "");
	}, [status?.spreadsheetId]);
	return (
		<section
			className='storage-settings'
			aria-label='保存先設定'
		>
			<div className='toolbar'>
				<h2>保存先</h2>
				<strong
					className={
						status?.destination === "spreadsheet"
							? "storage-cloud"
							: "storage-local"
					}
					role='status'
				>
					{status
						? status.destination === "spreadsheet"
							? "Googleスプレッドシート"
							: "このPC（ローカル）"
						: "確認中…"}
					{status?.pending ? " · シート未同期" : ""}
				</strong>
			</div>
			<p className='muted'>{status?.message}</p>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					configure(value);
				}}
			>
				<label>
					GoogleスプレッドシートのURLまたはID
					<input
						value={value}
						onChange={(e) => setValue(e.target.value)}
						disabled={busy || !ready}
						placeholder='https://docs.google.com/spreadsheets/d/…/edit'
					/>
				</label>
				<div className='toolbar'>
					<button
						type='submit'
						disabled={busy || !ready}
					>
						{value.trim() ? "接続・再試行" : "ローカル保存を使用"}
					</button>
					{status?.spreadsheetId && (
						<a
							href={
								"https://docs.google.com/spreadsheets/d/" +
								encodeURIComponent(status.spreadsheetId) +
								"/edit"
							}
							target='_blank'
							rel='noopener noreferrer'
						>
							設定中のシートを開く ↗
						</a>
					)}
				</div>
			</form>
			<p className='muted'>
				空欄でローカル保存。接続できない場合もこのPCに保存します。接続先にデータがあれば読み込み、空なら現在のDirectoryを書き込みます。切り替え前に編集中の内容を保存してください。
			</p>
			<p className='muted'>
				書き込みにはサーバーのGoogle認証設定と、サービスアカウントへのシートの編集権限が必要です。専用タブ「PlayerDirectory」を使用します。
			</p>
		</section>
	);
}
