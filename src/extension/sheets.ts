import {readFile} from "node:fs/promises";
import {JWT} from "google-auth-library";
import {
	type Directory,
	DirectoryError,
	validateDirectory,
} from "../domain/player.ts";
export const TAB = "PlayerDirectory";
export const COLUMNS = [
	"playerId",
	"revision",
	"manualDisplayName",
	"racetimeId",
	"racetimeName",
	"speedrunComId",
	"speedrunComName",
	"speedrunComWeblink",
	"twitchId",
	"twitchLogin",
	"twitchDisplayName",
	"youtube",
];
export function spreadsheetId(value: string): string {
	const raw = value.trim();
	if (!raw) return "";
	let id = raw;
	if (raw.includes("://")) {
		const url = new URL(raw);
		if (
			url.origin !== "https://docs.google.com" ||
			url.username ||
			url.password
		)
			throw new DirectoryError(
				"invalid_input",
				"GoogleスプレッドシートのURLを指定してください",
			);
		id =
			/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(url.pathname)?.[1] ??
			"";
	}
	if (!/^[a-zA-Z0-9_-]{10,200}$/.test(id))
		throw new DirectoryError(
			"invalid_input",
			"スプレッドシートのURLまたはIDが不正です",
		);
	return id;
}
export function toRows(value: Directory): string[][] {
	const d = validateDirectory(value);
	return [
		["player-manager", "1", String(d.revision)],
		COLUMNS,
		...d.players.map((p) => [
			p.playerId,
			String(p.revision),
			p.manualDisplayName ?? "",
			p.racetime?.userId ?? "",
			p.racetime?.name ?? "",
			p.speedrunCom?.userId ?? "",
			p.speedrunCom?.name ?? "",
			p.speedrunCom?.weblink ?? "",
			p.twitch?.userId ?? "",
			p.twitch?.login ?? "",
			p.twitch?.displayName ?? "",
			p.youtube ?? "",
		]),
	];
}
export function fromRows(rows: unknown[][]): Directory | null {
	if (!rows.some((row) => row.some((cell) => cell !== "" && cell != null)))
		return null;
	if (
		rows[0]?.[0] !== "player-manager" ||
		String(rows[0]?.[1]) !== "1" ||
		COLUMNS.some((c, i) => rows[1]?.[i] !== c)
	)
		throw new Error("シートの形式がPlayer Directory形式ではありません");
	const number = (v: unknown) => {
		if (!/^\d+$/.test(String(v))) throw new Error("シートのrevisionが不正です");
		return Number(v);
	};
	return validateDirectory({
		schemaVersion: 1,
		revision: number(rows[0]?.[2]),
		players: rows
			.slice(2)
			.filter((r) => r.some((c) => c !== "" && c != null))
			.map((r) => {
				const v = (i: number) => (r[i] == null ? "" : String(r[i]));
				if (
					(!v(3) && v(4)) ||
					(!v(5) && (v(6) || v(7))) ||
					(!v(9) && (v(8) || v(10)))
				)
					throw new Error("アカウントのIDまたはユーザー名が空欄です");
				return {
					playerId: v(0),
					revision: number(r[1]),
					manualDisplayName: v(2) || null,
					racetime: v(3) ? {userId: v(3), name: v(4)} : null,
					speedrunCom: v(5)
						? {userId: v(5), name: v(6), ...(v(7) ? {weblink: v(7)} : {})}
						: null,
					twitch: v(9)
						? {
								userId: v(8) || null,
								login: v(9),
								...(v(10) ? {displayName: v(10)} : {}),
							}
						: null,
					youtube: v(11) || null,
				};
			}),
	});
}
export interface SharedDirectory {
	load(): Promise<Directory | null>;
	save(value: Directory): Promise<void>;
	checkWritable(): Promise<void>;
}
export function serviceAccountToken(keyFile?: string): () => Promise<string> {
	let client: JWT | undefined;
	return async () => {
		if (!keyFile)
			throw new Error(
				"Google認証が未設定です。サーバーのgoogleCredentialsFileを設定してください",
			);
		try {
			if (!client) {
				const credentials = JSON.parse(await readFile(keyFile, "utf8"));
				if (
					credentials.type !== "service_account" ||
					typeof credentials.client_email !== "string" ||
					typeof credentials.private_key !== "string"
				)
					throw new Error("Invalid service account");
				client = new JWT({
					email: credentials.client_email,
					key: credentials.private_key,
					scopes: ["https://www.googleapis.com/auth/spreadsheets"],
				});
			}
			const result = await client.getAccessToken();
			if (!result.token) throw new Error();
			return result.token;
		} catch {
			throw new Error(
				"Google認証に失敗しました。認証ファイルとSheets APIの有効化を確認してください",
			);
		}
	};
}
export class SheetsRepository implements SharedDirectory {
	private sheet: {
		sheetId: number;
		rowCount: number;
		columnCount: number;
	} | null = null;
	constructor(
		private readonly id: string,
		private readonly token: () => Promise<string>,
		private readonly fetcher: typeof fetch = fetch,
	) {}
	private async api(path: string, body?: unknown): Promise<any> {
		const token = await this.token();
		let response: Response;
		try {
			response = await this.fetcher(
				`https://sheets.googleapis.com/v4/spreadsheets/${this.id}${path}`,
				{
					method: body ? "POST" : "GET",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: body ? JSON.stringify(body) : undefined,
					signal: AbortSignal.timeout(12000),
				},
			);
		} catch {
			throw new Error("Google Sheetsに接続できませんでした");
		}
		if (!response.ok)
			throw new Error(
				`Google Sheets HTTP ${response.status}：シートの共有権限・ID・API設定を確認してください`,
			);
		return response.json();
	}
	async load(): Promise<Directory | null> {
		const meta = await this.api(
			"?fields=sheets(properties(sheetId,title,gridProperties))",
		);
		const p = meta.sheets?.find(
			(s: any) => s.properties?.title === TAB,
		)?.properties;
		this.sheet = p
			? {
					sheetId: p.sheetId,
					rowCount: p.gridProperties.rowCount,
					columnCount: p.gridProperties.columnCount,
				}
			: null;
		if (!this.sheet) return null;
		const result = await this.api(
			`/values/${encodeURIComponent("'" + TAB + "'!A:L")}?valueRenderOption=UNFORMATTED_VALUE`,
		);
		return fromRows(result.values ?? []);
	}
	async checkWritable(): Promise<void> {
		if (!this.sheet) throw new Error("保存先タブがありません");
		await this.api(":batchUpdate", {
			requests: [
				{
					updateCells: {
						start: {sheetId: this.sheet.sheetId, rowIndex: 0, columnIndex: 0},
						rows: [
							{values: [{userEnteredValue: {stringValue: "player-manager"}}]},
						],
						fields: "userEnteredValue",
					},
				},
			],
		});
	}
	async save(value: Directory): Promise<void> {
		const rows = toRows(value);
		if (!this.sheet) {
			const result = await this.api(":batchUpdate", {
				requests: [
					{
						addSheet: {
							properties: {
								title: TAB,
								gridProperties: {
									rowCount: Math.max(1000, rows.length),
									columnCount: COLUMNS.length,
									frozenRowCount: 2,
								},
							},
						},
					},
				],
			});
			const p = result.replies?.[0]?.addSheet?.properties;
			if (!p) throw new Error("保存先タブを作成できませんでした");
			this.sheet = {
				sheetId: p.sheetId,
				rowCount: p.gridProperties.rowCount,
				columnCount: p.gridProperties.columnCount,
			};
		}
		const sheet = this.sheet;
		const requests: unknown[] = [];
		if (rows.length > sheet.rowCount || sheet.columnCount < COLUMNS.length)
			requests.push({
				updateSheetProperties: {
					properties: {
						sheetId: sheet.sheetId,
						gridProperties: {
							rowCount: Math.max(rows.length, sheet.rowCount),
							columnCount: Math.max(COLUMNS.length, sheet.columnCount),
						},
					},
					fields: "gridProperties.rowCount,gridProperties.columnCount",
				},
			});
		requests.push({
			updateCells: {
				range: {
					sheetId: sheet.sheetId,
					startRowIndex: 0,
					startColumnIndex: 0,
					endColumnIndex: COLUMNS.length,
				},
				rows: rows.map((row) => ({
					values: row.map((stringValue) => ({userEnteredValue: {stringValue}})),
				})),
				fields: "userEnteredValue",
			},
		});
		await this.api(":batchUpdate", {requests});
	}
}
