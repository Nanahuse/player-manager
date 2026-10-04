import type {
	CompleteRegistration,
	Operations,
	RegistrationSession,
} from "../../protocol/index.ts";
type Request = <K extends keyof Operations>(
	operation: K,
	data: Operations[K]["request"],
) => Promise<Operations[K]["response"]>;
export async function completeRegistration(
	request: Request,
	registrationId: string,
	action: CompleteRegistration,
	needsResolution: boolean,
	input: Operations["resolve"]["request"]["input"],
	onResolved: (session: RegistrationSession) => void,
) {
	if (needsResolution) {
		const session = await request("resolveRegistration", {
			registrationId,
			input,
		});
		onResolved(session);
		const resolution = session.resolution;
		if (!resolution)
			throw new Error(
				"突合結果を取得できませんでした。もう一度登録してください。",
			);
		if (resolution.status === "conflict")
			throw new Error(
				"アカウントの競合があります。入力内容を修正してください。",
			);
		if (resolution.status === "ambiguous")
			throw new Error(
				"候補が複数あります。突合結果を確認して選択してください。",
			);
		if (action.action !== "existing")
			action = {
				...action,
				input: {
					...resolution.input,
					...Object.fromEntries(
						Object.entries(input).filter(([, value]) => value === null),
					),
				},
			};
	}
	await request("completeRegistration", {registrationId, ...action});
	return request("getRegistration", {registrationId});
}
