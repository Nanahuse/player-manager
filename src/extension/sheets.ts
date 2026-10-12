import {type Directory} from "@nanahuse/player-manager-protocol";
import {GoogleAuth} from "google-auth-library";
import {DirectoryError, validateDirectory} from "../domain/player.ts";
export const TAB = "PlayerDirectory";
const V1_COLUMNS = [
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
const V2_COLUMNS = [...V1_COLUMNS, "accounts"];
export const COLUMNS = [
	"playerId",
	"revision",
	"manualDisplayName",
	"racetimeId",
	"racetimeName",
	"speedrunComId",
	"speedrunComName",
	"speedrunComWeblink",
	"twitchLogin",
	"twitchDisplayName",
	"youtube",
	"accounts",
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
		["player-manager", "3", String(d.revision)],
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
			p.twitch?.login ?? "",
			p.twitch?.displayName ?? "",
			p.youtube ?? "",
			JSON.stringify(p.accounts ?? []),
		]),
	];
}
export function fromRows(rows: unknown[][]): Directory | null {
	if (!rows.some((row) => row.some((cell) => cell !== "" && cell != null)))
		return null;
	const version = String(rows[0]?.[1]);
	const columns =
		version === "1" ? V1_COLUMNS : version === "2" ? V2_COLUMNS : COLUMNS;
	if (
		rows[0]?.[0] !== "player-manager" ||
		!["1", "2", "3"].includes(version) ||
		columns.some((c, i) => rows[1]?.[i] !== c)
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
				const oldLayout = version !== "3";
				const twitchLoginIndex = oldLayout ? 9 : 8;
				const twitchNameIndex = oldLayout ? 10 : 9;
				const youtubeIndex = oldLayout ? 11 : 10;
				const accountsIndex = oldLayout ? 12 : 11;
				if (
					(!v(3) && v(4)) ||
					(!v(5) && (v(6) || v(7))) ||
					(!v(twitchLoginIndex) && v(twitchNameIndex))
				)
					throw new Error("アカウントのIDまたはユーザー名が空欄です");
				const legacy = {
					playerId: v(0),
					revision: number(r[1]),
					manualDisplayName: v(2) || null,
					racetime: v(3) ? {userId: v(3), name: v(4)} : null,
					speedrunCom: v(5)
						? {userId: v(5), name: v(6), ...(v(7) ? {weblink: v(7)} : {})}
						: null,
					twitch: v(twitchLoginIndex)
						? {
								login: v(twitchLoginIndex),
								...(v(twitchNameIndex)
									? {displayName: v(twitchNameIndex)}
									: {}),
							}
						: null,
					youtube: v(youtubeIndex) || null,
				};
				if (version === "1") return legacy;
				try {
					return {...legacy, accounts: JSON.parse(v(accountsIndex))};
				} catch {
					throw new Error("シートのaccounts JSONが不正です");
				}
			}),
	});
}
export interface SharedDirectory {
	load(): Promise<Directory | null>;
	save(value: Directory): Promise<void>;
	checkWritable(): Promise<void>;
}
export function applicationDefaultToken(): () => Promise<string> {
	const auth = new GoogleAuth({
		scopes: ["https://www.googleapis.com/auth/spreadsheets"],
	});
	let client: Awaited<ReturnType<typeof auth.getClient>> | undefined;
	return async () => {
		try {
			client ??= await auth.getClient();
			const result = await client.getAccessToken();
			if (!result.token) throw new Error();
			return result.token;
		} catch (error) {
			throw new Error(
				"Google認証を利用できません。ADCの認証情報とSheets APIの有効化を確認してください",
				{cause: error},
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
		} catch (error) {
			throw new Error("Google Sheetsに接続できませんでした", {cause: error});
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
			`/values/${encodeURIComponent("'" + TAB + "'!A:M")}?valueRenderOption=UNFORMATTED_VALUE`,
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
					endColumnIndex: Math.max(COLUMNS.length, sheet.columnCount),
				},
				rows: rows.map((row) => ({
					values: Array.from(
						{length: Math.max(COLUMNS.length, sheet.columnCount)},
						(_, index) => ({
							userEnteredValue: {stringValue: row[index] ?? ""},
						}),
					),
				})),
				fields: "userEnteredValue",
			},
		});
		await this.api(":batchUpdate", {requests});
	}
}
