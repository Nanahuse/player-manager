import type {ReactNode} from "react";

export function PageHeader({
	title,
	children,
}: {
	title: string;
	children?: ReactNode;
}) {
	return (
		<header>
			<div>
				<p className='eyebrow'>PLAYER MANAGER</p>
				<h1>{title}</h1>
			</div>
			{children}
		</header>
	);
}
