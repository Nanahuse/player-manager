import {useEffect, useRef} from "react";

export function NameOnlyConfirmation({
	name,
	onBack,
	onConfirm,
}: {
	name: string;
	onBack: () => void;
	onConfirm: () => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const previous = document.activeElement;
		dialog.current?.showModal();
		return () => {
			if (previous instanceof HTMLElement) previous.focus();
		};
	}, []);
	return (
		<dialog
			ref={dialog}
			className='confirmation-dialog'
			aria-labelledby='name-only-title'
			aria-describedby='name-only-description'
			onCancel={(event) => {
				event.preventDefault();
				onBack();
			}}
		>
			<h2 id='name-only-title'>名前のみの登録確認</h2>
			<p id='name-only-description'>
				このPlayerにはアカウントが割り当てられていません。名前だけで登録しますか？
			</p>
			<dl>
				<dt>表示名</dt>
				<dd>{name}</dd>
				<dt>アカウント数</dt>
				<dd>0</dd>
			</dl>
			<p className='muted'>
				アカウントによる自動突合は行えません。登録後にアカウントを追加できます。
			</p>
			<div className='toolbar'>
				<button
					type='button'
					onClick={onBack}
				>
					戻る
				</button>
				<button
					type='button'
					className='primary'
					onClick={onConfirm}
				>
					名前だけで登録
				</button>
			</div>
		</dialog>
	);
}
