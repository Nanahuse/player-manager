# @nanahuse/player-manager-protocol

Player Managerと連携するNodeCGバンドル向けの型と関数を提供します。APIのバージョンは **3**、メッセージの名前空間は **player-manager.v3**、送信先バンドル名は **player-manager** です。

## インストール

Node.js 24、pnpm 12.9.1を使用します。npmレジストリには公開していないため、GitHubのサブディレクトリを依存先に指定します。稼働するPlayer Managerと同じリリースタグまたはコミットに固定してください。以下は、このREADMEのAPIを含むコミットを指定した例です。

利用側バンドルの `package.json` に追加します。

```json
{
  "dependencies": {
    "@nanahuse/player-manager-protocol": "github:Nanahuse/player-manager#85456872b2d4409c4084c9e441d81b7b9a45a577&path:/packages/player-manager-protocol"
  }
}
```

利用側の `pnpm-workspace.yaml` に、Git依存のビルド許可を追加します。

```yaml
allowBuilds:
  '@nanahuse/player-manager-protocol@git+https://github.com/Nanahuse/player-manager.git': true
```

```sh
pnpm install
```

この許可は同じリポジトリのタグ・コミットに適用されます。`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` が出る場合は、設定が利用側のプロジェクトで読み込まれているか確認してください。

インストール時の `prepare` でJavaScriptと型定義を生成します。ソースを利用側の `tsconfig.json` に追加する必要はありません。実行時依存はなく、ESM・CommonJS、TypeScriptのNode16・NodeNext・Bundlerによる型解決に対応します。importはパッケージのルートから行ってください。

## 公開型と関数

型の定義元は [src/index.ts](src/index.ts) と [src/player.ts](src/player.ts) です。操作ごとの正確な引数・戻り値は `Operations[操作名]["request"]` と `Operations[操作名]["response"]` を参照してください。

| 用途 | 主な型・関数 |
| --- | --- |
| 登録済みデータ | `Player`、`PlayerId`、`Directory`、`DirectoryAccount` |
| 呼び出し・エラー | `PlayerManagerAPI`（`PlayerDirectoryAPI`と同じ型）、`Operations`、`Response<T>`、`FailureCode` |
| 突合・登録 | `MatchingInput`、`Resolution`、`RegistrationSession`、`RegistrationResult` |
| 直接更新 | `IdentityResolutionInput`、`Mutation`、`MutationResponse` |
| 通知・保存状態 | `PlayerManagerEvents`、`StorageStatus` |
| 表示・画面連携 | `resolveDisplayName(player)`、`playerEditUrl(playerId)` |
| 名前・バージョン | `BUNDLE_NAME`、`API_VERSION`、`MESSAGE_PREFIX`、`operationMessageName`、`eventMessageName` |

`Player.playerId` はPlayer Managerが生成するID、`revision` は更新確認に使う番号です。`accounts` にPrimary・Subを含むアカウントを保持し、`racetime`、`speedrunCom`、`twitch`、`youtube` は各サービスのPrimaryを表します。Subの `role` は `"secondary"` です。アカウントIDは返却値をそのまま使い、利用側で組み立てないでください。

`playerEditUrl` は既存プレイヤーの編集画面のNodeCG相対URLを返します。空のIDには `TypeError` を返します。表示名の選択は `resolveDisplayName` を使用できます。

## APIを呼び出す

### Dashboard・Graphicsから

`sendMessageToBundle` で `operationMessageName(操作名)` を `BUNDLE_NAME` へ送信します。Protocolは通信クライアントを提供しないため、利用側で次のような関数を用意すると引数・応答を型チェックできます。

```ts
import type NodeCG from "@nodecg/types";
import type {Operations, Response} from "@nanahuse/player-manager-protocol";
import {BUNDLE_NAME, operationMessageName} from "@nanahuse/player-manager-protocol";

declare const nodecg: NodeCG.ClientAPI;

export async function request<K extends keyof Operations>(
  operation: K,
  input: Operations[K]["request"],
): Promise<Operations[K]["response"]> {
  const response = await nodecg.sendMessageToBundle(
    operationMessageName(operation), BUNDLE_NAME, input,
  ) as Response<Operations[K]["response"]>;
  if (!response.ok) {
    throw new Error(`${response.error.code}: ${response.error.message}`);
  }
  return response.data;
}
```

`nodecg` は画面に提供されるAPIです。上の `declare` は型を示すための宣言です。以降のブラウザー例では、この関数を `client.ts` に保存したものとします。

```ts
import {request} from "./client.js";
import {playerEditUrl, resolveDisplayName} from "@nanahuse/player-manager-protocol";

async function showPlayer(login: string): Promise<void> {
  const player = await request("find", {provider: "twitch", value: login});
  if (!player) return;
  console.log(resolveDisplayName(player));
  window.open(playerEditUrl(player.playerId), "_blank", "noopener,noreferrer");
}
```

### Extensionから

利用側の `package.json` の `nodecg` に依存バンドルを宣言します。

```json
{
  "nodecg": {
    "bundleDependencies": {
      "player-manager": "^3.0.0"
    }
  }
}
```

```ts
import type NodeCG from "@nodecg/types";
import type {PlayerManagerAPI} from "@nanahuse/player-manager-protocol";
import {API_VERSION, BUNDLE_NAME} from "@nanahuse/player-manager-protocol";

export default async function (nodecg: NodeCG.ServerAPI): Promise<void> {
  const api = nodecg.extensions[BUNDLE_NAME] as PlayerManagerAPI | undefined;
  if (!api || api.apiVersion !== API_VERSION) {
    throw new Error("Player Manager APIを利用できません");
  }
  await api.ready;
  const status = await api.request("status", undefined);
  if (!status.ok) throw new Error(status.error.message);
  if (!status.data.ready) throw new Error(status.data.error ?? "Directory未準備");
  const result = await api.request("list", undefined);
  if (!result.ok) throw new Error(result.error.message);
  console.log(result.data.players);
}
```

`ready` は初期読み込み処理の終了を表します。読み込みの成功は `status` の `ready`、または取得操作の応答で確認してください。`API_VERSION` は通信契約のバージョンで、パッケージのバージョンとは別です。

## プレイヤーを取得・更新する

### 取得と外部プロフィール検索

| 操作 | 指定する値と返却データ |
| --- | --- |
| `list` / `get` | 全体の `Directory` を取得 / `{playerId}` で `Player` を取得 |
| `find` | `{provider, value}` でPrimaryアカウントから `Player` を検索 |
| `findAccount` | `{accountId}` でSubを含むアカウントから `{player, account}` を検索 |
| `searchIdentities` / `getIdentity` | 公開プロフィールを検索 / `{provider, value}` で取得 |

`get`、`find`、`findAccount` は該当しなければ `null` を返します。`find` の `provider` は `racetime`、`speedrunCom`、`twitch`、`youtube`。`value` にはRaceTime・Speedrun.comのユーザーID、Twitchログイン名またはチャンネルURL、YouTubeチャンネルURLまたはハンドルを指定します。

`searchIdentities` は `{provider, query, mode?}` を受け取り、`{identities, hasMore}` を返します。対応するのはRaceTimeの `name` 検索と、Speedrun.comの `name`・`lookup`・`twitch` 検索です。`mode` の既定値は `name`。`hasMore` が `true` の場合は検索語を絞ってください。`getIdentity` はRaceTimeのID・プロフィールURL、Speedrun.comのID・ユーザー名・プロフィールURLを受け取ります。Twitch・YouTubeへの直接検索・取得は `unsupported_operation` になります。

### 直接更新

対応サービスの新しいアカウントを登録・追加する場合は、次節の登録セッションを使用します。`create`・`update`・`mutate` は、表示名、その他のプロフィールURL、登録済みアカウントの整理などに使用できます。

- `create({input})` は `Player` を返します。RaceTime・Speedrun.com・Twitch・YouTubeの新規アカウントは指定できません。
- `update({playerId, revision, input})` は更新後の `Player` を返します。省略した表示名・アカウントは保持します。対応サービスのフィールドに `null` を指定すると現在のPrimaryを削除します。個別の削除には `removeAccountIds`、Primaryの指定には `profilePrimaryByService` を使います。Primary削除後にSubが残る場合は、次のPrimaryを明示します。対応サービスの未登録アカウントは追加できません。
- `delete({playerId, revision})` は削除した `{playerId}` を返します。
- `mutate({operations})` は最大100操作をまとめて保存し、`{directoryRevision, results}` を返します。各操作に一意の `ref` を指定し、同じプレイヤーへの更新・削除は一度だけ指定します。すべて検証・保存できた場合に反映されます。

`input` は `IdentityResolutionInput` です。任意サービスのプロフィールURLは `profileAccounts` で追加し、アカウント配列 `accounts` は直接書き換えません。更新・削除の `revision` には取得時の値を渡してください。削除されたプレイヤーを参照する側は、`null` や `player_not_found` を扱う必要があります。

## 登録セッションで突合・保存する

新規登録、対応サービスのアカウント追加、所属変更や統合には登録セッションを使用します。利用側は入力を渡して登録画面を開き、利用者が確認した結果を受け取れます。

```ts
import {request} from "./client.js";
import {watchRegistration} from "./notifications.js";

async function beginPlayerRegistration(login: string): Promise<string> {
  const registration = await request("beginRegistration", {
    input: {accountRequests: [{service: "twitch", value: login}]},
    requiredAccounts: [{service: "twitch", value: login}],
  });
  watchRegistration(registration.registrationId);
  window.open(registration.url, "_blank", "noopener,noreferrer");
  return registration.registrationId;
}
```

`beginRegistration` は `{registrationId, url}` を返します。`input` は `MatchingInput` で、複数アカウントを渡す場合は `accountRequests` に `{service, value}` を並べます。各項目を独立した探索の起点として扱います。`requiredAccounts` は必ず割り当てるアカウントで、RaceTime・Speedrun.com・Twitch・YouTubeを指定できます。未充足のまま保存することはできません。

既存プレイヤーの編集は、取得済みの `playerId` と `revision` を `target: {playerId, expectedRevision: revision}` に渡します。この場合、表示名の変更には `setRegistrationDisplayName` を使います。新規プレイヤーの表示名は `input.manualDisplayName` で指定します。探索入力が空でも新規プレイヤーを作る場合だけ `createPlayerOnEmpty: true` を指定してください。`target` とは併用できません。

画面を使わず操作する場合も、同じセッションを取得・更新し、最後に保存します。`getRegistration({registrationId})` は `RegistrationSession | null` を返します。操作に渡すアカウント・所属先・競合のIDは、その `resolution` から取得してください。

| 作業 | 使用する操作 |
| --- | --- |
| 入力全体を置き換えて再探索 | `resolveRegistration` |
| 所属先、Primary、除外・復元を指定 | `assignRegistrationAccount`、`setRegistrationAccountPrimary`、`setRegistrationAccountUsage` |
| 分離した所属を承認 | `approveRegistrationConflict` |
| 統合先・統合しない判断を指定 | `selectRegistrationMergeSurvivor`、`setRegistrationMergeDecision` |
| 空になったプレイヤーの削除、編集対象の表示名を指定 | `setRegistrationPlayerDeletion`、`setRegistrationDisplayName` |

これらの操作は `registrationId` と操作対象を受け取り、更新後の `RegistrationSession` を返します。引数は [Operations](src/index.ts) を参照してください。再探索では有効な割り当て・選択を再利用します。候補は、採用するIDを入力に追加して再探索するか、起点アカウントの現在の所属を `assignRegistrationAccount` で明示して確認します。

`completeRegistration({registrationId})` は変更をまとめて保存し、`RegistrationResult` を返します。`cancelRegistration({registrationId})` は保存せず取り消し、`RegistrationSession` を返します。セッションを作らずに探索だけを行う場合は `resolve({input, requiredAccounts?})` で `Resolution` を取得できます。

`Resolution` の `accounts` は探索したアカウント、`evidence` は関連付けの根拠、`assignments` は所属先とPrimary/Subです。利用側は `conflicts`、`roleConflicts`、`candidates`、`warnings`、`errors`、`requiredStatus`、`mergeProposal` を確認します。未解決の競合・Primary・候補・統合判断、必須アカウント不足、取得エラー、更新されたプレイヤーがある場合、完了操作は失敗します。

セッションはメモリ上で管理され、開始から30分で期限切れになり、再起動でも失われます。保存済みの完了セッションに対する `completeRegistration` の再呼び出しは同じ結果を返します。完了結果は `RegistrationSession.result` からも取得できます。

## 保存先と稼働状態を確認する

| 操作 | 用途 |
| --- | --- |
| `status` | `{ready, error}` を取得 |
| `storage` | `StorageStatus` を取得 |
| `configureStorage({spreadsheet})` | Google SheetsのURL・IDを設定。空文字でローカル保存に切り替え、`StorageStatus` を取得 |
| `reload` | 保存先を再読み込みし、`Directory` を取得 |
| `initializeDirectory({confirm: true})` | 読み込めない状態で、バックアップ後に空のローカルDirectoryを作成 |

Google Sheets接続に失敗しても `configureStorage` が成功応答を返し、ローカル保存になる場合があります。`destination`、`pending`、`message` を確認してください。`initializeDirectory` は読み込み済みの状態では使用できません。認証設定と復旧手順は[ルートREADME](../../README.md#データの保存)を参照してください。

## 通知とスナップショット

通知は `eventMessageName(通知名)` を `BUNDLE_NAME` で購読します。ペイロードの型は `PlayerManagerEvents[通知名]` です。

| 通知 | ペイロードと用途 |
| --- | --- |
| `directoryChanged` | `{directoryRevision}`。変更後のDirectoryを再取得するきっかけ |
| `registrationCompleted` | `RegistrationResult`：`registrationId`、`directoryRevision`、変更対象の `players`、`deletedPlayerIds` |
| `registrationCancelled` | `{registrationId}`。登録の取消 |

```ts
import type NodeCG from "@nodecg/types";
import type {PlayerManagerEvents} from "@nanahuse/player-manager-protocol";
import {BUNDLE_NAME, eventMessageName} from "@nanahuse/player-manager-protocol";
import {request} from "./client.js";

declare const nodecg: NodeCG.ClientAPI;

export function watchRegistration(registrationId: string): void {
  nodecg.listenFor(eventMessageName("registrationCompleted"), BUNDLE_NAME,
    (result: PlayerManagerEvents["registrationCompleted"]) => {
      if (result.registrationId === registrationId) console.log(result.players);
    });
  void request("getRegistration", {registrationId}).then(console.log).catch(console.error);
}
```

この関数を `notifications.ts` に保存すると、登録開始の例から利用できます。通知は永続化・再送されません。登録画面を開く前に購読し、接続時や再接続時には `getRegistration` でも状態を確認してください。`players` はDirectory全体ではありません。

`directoryChanged` を使う場合は購読時に `list` で初期状態を取得し、通知のたびに再取得します。同じrevisionでも再読み込みなどで内容が変わる場合があるため、revisionの大小だけで通知を捨てないでください。

全体の状態を継続して表示する場合は、名前空間 `player-manager` の次のReplicantも購読できます。

| Replicant | 型 |
| --- | --- |
| `player-directory` | `Directory` |
| `player-directory-status` | `{ready: boolean; error: string | null}` |
| `player-directory-storage` | `StorageStatus` |

これらは参照用スナップショットとして扱い、変更はAPIを通してください。

## エラー処理

応答は `Response<T>` です。成功は `{ok: true, data}`、失敗は `{ok: false, error: {code, message}}`。NodeCGの通信失敗によるPromiseの拒否も、別途 `try` / `catch` などで処理してください。

| `error.code` | 利用側の対応 |
| --- | --- |
| `invalid_input` | 入力形式、候補の確認、統合判断、必須アカウントを確認 |
| `unsupported_operation` | 操作・対応サービスを確認 |
| `identity_conflict` | 所属先やPrimaryの競合を確認 |
| `player_changed` | 最新プレイヤーを取得し直して編集を開始 |
| `player_not_found` | 削除済みなどの参照を解除・選択し直す |
| `lookup_failed` / `rate_limited` | 外部サービスの状態を確認し、時間をおいて再探索 |
| `registration_not_found` / `registration_expired` | 登録セッションを作り直す |
| `directory_unavailable` / `persistence_failed` | 保存状態・NodeCGログを確認し、必要に応じて復旧 |

Google Sheetsが未同期でもローカル保存が成功していれば更新APIは成功します。シートへの同期まで必要な利用側は `storage` も確認してください。
