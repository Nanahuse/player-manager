# 外部NodeCGバンドルとの連携

別のNodeCGバンドルからプレイヤー情報を登録し、登録済みの情報を検索・取得・編集できます。[Protocol README](../packages/player-manager-protocol/README.md)の手順で、先に利用側へパッケージを導入してください。

## プレイヤー情報

`Player.playerId` はPlayer Managerが生成するID、`revision` は更新時の確認に使う番号です。`Player.accounts` にはPrimaryとSubの両方が含まれます。`racetime`、`speedrunCom`、`twitch`、`youtube` は各サービスのPrimaryを表し、Subの `role` は `"secondary"` です。アカウントIDは返却値をそのまま使い、利用側で組み立てないでください。

`playerEditUrl` は既存プレイヤーの編集画面を開くためのNodeCG相対URLを返します。空のIDを渡すと `TypeError` をスローします。表示名を選ぶには `resolveDisplayName` を使用できます。

## APIを呼び出す

### Dashboard・Graphicsから

`sendMessageToBundle` のメッセージ名に `operationMessageName(操作名)`、送信先に `BUNDLE_NAME` を指定します。Protocolには通信クライアントが含まれないため、利用側で次のような関数を用意すると引数と応答を型チェックできます。

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

`nodecg` はNodeCGが画面に提供するAPIです。上の `declare` はその型を示しています。以降のブラウザー例ではこの関数を `client.ts` に保存したものとします。APIから取得したURLをリンクに設定し、ユーザーがクリックして別タブで開く形にします。

```ts
import {request} from "./client.js";
import {playerEditUrl, resolveDisplayName} from "@nanahuse/player-manager-protocol";

export async function showPlayer(login: string, link: HTMLAnchorElement): Promise<void> {
  link.hidden = true;
  link.removeAttribute("href");
  const player = await request("find", {provider: "twitch", value: login});
  if (!player) return;
  link.href = playerEditUrl(player.playerId);
  link.textContent = `${resolveDisplayName(player)}を編集`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.hidden = false;
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

## 登録済みプレイヤーを検索・取得する

検索・取得の対象はPlayer Managerに登録済みのプレイヤーです。

| 操作 | 指定する値と返却データ |
| --- | --- |
| `list` / `get` | 全体の `Directory` を取得 / `{playerId}` で `Player` を取得 |
| `find` | `{provider, value}` でPrimaryアカウントから `Player` を検索 |
| `findAccount` | `{accountId}` でSubを含むアカウントから `{player, account}` を検索 |

`get`、`find`、`findAccount` は該当するデータがなければ `null` を返します。`find` の `provider` は `racetime`、`speedrunCom`、`twitch`、`youtube` です。`value` にはRaceTime・Speedrun.comのユーザーID、Twitchログイン名またはチャンネルURL、YouTubeチャンネルURLまたはハンドルを指定します。

プレイヤー名による検索には専用のAPIがないため、`list` で取得した `Directory.players` を利用側で絞り込みます。

## 登録に使う外部プロフィールを検索・取得する

登録するアカウントを探すには、外部サービスの公開プロフィールを検索・取得します。

`searchIdentities` は `{provider, query, mode?}` を受け取り、`{identities, hasMore}` を返します。対応するのはRaceTimeの `name` 検索と、Speedrun.comの `name`・`lookup`・`twitch` 検索です。`mode` の既定値は `name` です。`hasMore` が `true` の場合は検索語を絞ってください。`getIdentity` はRaceTimeのID・プロフィールURL、Speedrun.comのID・ユーザー名・プロフィールURLを受け取ります。Twitch・YouTubeへの直接検索・取得は `unsupported_operation` になります。

## プレイヤー情報を直接登録・更新する

対応サービスの新しいアカウントを登録・追加する場合は、次節の登録セッションを使用します。`create`・`update`・`mutate` は、表示名、その他のプロフィールURL、登録済みアカウントの整理などに使用できます。

- `create({input})` は `Player` を返します。RaceTime・Speedrun.com・Twitch・YouTubeのアカウントは指定できません。
- `update({playerId, revision, input})` は更新後の `Player` を返します。表示名やアカウントを省略すると、その情報を保持します。対応サービスのフィールドに `null` を指定すると現在のPrimaryを削除します。個別の削除には `removeAccountIds`、Primaryの指定には `profilePrimaryByService` を使います。Primaryを削除してSubが残る場合は、次のPrimaryも指定します。対応サービスの未登録アカウントは追加できません。
- `delete({playerId, revision})` は削除した `{playerId}` を返します。
- `mutate({operations})` は最大100操作をまとめて保存し、`{directoryRevision, results}` を返します。各操作に一意の `ref` を指定し、同じプレイヤーへの更新・削除は一度だけ指定します。すべて検証・保存できた場合に反映されます。

`input` の型は `IdentityResolutionInput` です。任意サービスのプロフィールURLを追加するには `profileAccounts` を使います。アカウント配列 `accounts` は直接書き換えません。更新・削除の `revision` には取得時の値を渡してください。削除されたプレイヤーを参照する側は、`null` や `player_not_found` を扱う必要があります。

## 登録セッションでアカウントを登録する

新規登録、対応サービスのアカウント追加、所属変更や統合には登録セッションを使用します。入力したアカウントから連携済みのアカウントを自動的に探し、ユーザーが登録画面で確認した結果をまとめて保存します。次の例では用意したリンク要素を `link` に渡します。

```ts
import {request} from "./client.js";
import "./notifications.js";

export async function beginPlayerRegistration(
  login: string, link: HTMLAnchorElement,
): Promise<string> {
  link.hidden = true;
  link.removeAttribute("href");
  const registration = await request("beginRegistration", {
    input: {accountRequests: [{service: "twitch", value: login}]},
    requiredAccounts: [{service: "twitch", value: login}],
  });
  link.href = registration.url;
  link.textContent = "登録画面を開く";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.hidden = false;
  return registration.registrationId;
}
```

`beginRegistration` は `{registrationId, url}` を返します。`input` の型は `MatchingInput` です。複数アカウントを渡す場合は `accountRequests` に `{service, value}` を並べます。`requiredAccounts` には必ず割り当てるアカウントを指定します。対象はRaceTime・Speedrun.com・Twitch・YouTubeで、必要な割り当てが済むまで保存できません。

既存プレイヤーを編集するには、取得済みの `playerId` と `revision` を `target: {playerId, expectedRevision: revision}` に渡します。この場合、表示名を変更する操作は `setRegistrationDisplayName` です。新規プレイヤーの表示名は `input.manualDisplayName` で指定します。探索入力が空でも新規プレイヤーを作る場合だけ `createPlayerOnEmpty: true` を指定してください。`target` とは併用できません。

画面を使わず操作する場合も、同じセッションを取得・更新し、最後に保存します。`getRegistration({registrationId})` は `RegistrationSession | null` を返します。操作に渡すアカウント・所属先・競合のIDは、取得したセッションの `resolution` を参照してください。

| 作業 | 使用する操作 |
| --- | --- |
| 入力全体を置き換えて再探索 | `resolveRegistration` |
| 所属先、Primary、除外・復元を指定 | `assignRegistrationAccount`、`setRegistrationAccountPrimary`、`setRegistrationAccountUsage` |
| 分離した所属を承認 | `approveRegistrationConflict` |
| 統合先・統合しない判断を指定 | `selectRegistrationMergeSurvivor`、`setRegistrationMergeDecision` |
| 空になったプレイヤーの削除、編集対象の表示名を指定 | `setRegistrationPlayerDeletion`、`setRegistrationDisplayName` |

これらの操作は `registrationId` と操作対象を受け取り、更新後の `RegistrationSession` を返します。引数は [Operations](../packages/player-manager-protocol/src/index.ts) を参照してください。再探索では有効な割り当て・選択を再利用します。候補を採用する場合は、そのIDを入力に追加して再探索します。起点アカウントの現在の所属でよければ、`assignRegistrationAccount` で所属先を明示して確認します。

`completeRegistration({registrationId})` は変更をまとめて保存し、`RegistrationResult` を返します。`cancelRegistration({registrationId})` は保存せず取り消し、`RegistrationSession` を返します。セッションを作らずに探索だけを行う場合は `resolve({input, requiredAccounts?})` で `Resolution` を取得できます。

競合の解決、Primaryの選択、候補の確認、統合の判断が済んでいない場合、完了操作は失敗します。必須アカウントが不足している場合、`errors` に取得エラーがある場合、編集中のプレイヤーが更新された場合も同様です。

セッションの有効期間は[使い方](usage.md#新しいプレイヤーを登録する)を参照してください。完了済みのセッションが残っていれば、`completeRegistration` を再び呼び出しても同じ結果が返ります。この結果は `RegistrationSession.result` からも取得できます。

## 保存先と稼働状態を確認する

| 操作 | 用途 |
| --- | --- |
| `status` | `{ready, error}` を取得 |
| `storage` | `StorageStatus` を取得 |
| `configureStorage({spreadsheet})` | Google SheetsのURL・IDを設定。空文字でローカル保存に切り替え、`StorageStatus` を取得 |
| `reload` | 保存先を再読み込みし、`Directory` を取得 |
| `initializeDirectory({confirm: true})` | 読み込めない状態で、バックアップ後に空のローカルDirectoryを作成 |

Google Sheetsに接続できなくても、`configureStorage` が成功応答を返す場合があります。このときの保存先はローカルです。ローカル保存が成功していれば、シートが未同期でも更新APIは成功します。実際の保存先と未同期の有無は `storage` の `destination`、`pending`、`message` で確認してください。`initializeDirectory` は読み込み済みの状態では使用できません。認証設定と復旧手順は[データの保存](storage.md)を参照してください。

## 通知とスナップショット

通知は `eventMessageName(通知名)` を `BUNDLE_NAME` で購読します。ペイロードの型は `PlayerManagerEvents[通知名]` です。

| 通知 | ペイロードと用途 |
| --- | --- |
| `directoryChanged` | `{directoryRevision}`。変更後のDirectoryを再取得するきっかけ |
| `registrationCompleted` | `RegistrationResult`：`registrationId`、`directoryRevision`、対象の `players`、`deletedPlayerIds` |
| `registrationCancelled` | `{registrationId}`。登録の取消 |

```ts
import type NodeCG from "@nodecg/types";
import type {PlayerManagerEvents} from "@nanahuse/player-manager-protocol";
import {BUNDLE_NAME, eventMessageName} from "@nanahuse/player-manager-protocol";
import {request} from "./client.js";

declare const nodecg: NodeCG.ClientAPI;

nodecg.listenFor(eventMessageName("registrationCompleted"), BUNDLE_NAME,
  (result: PlayerManagerEvents["registrationCompleted"]) => console.log(result));
nodecg.listenFor(eventMessageName("registrationCancelled"), BUNDLE_NAME,
  (result: PlayerManagerEvents["registrationCancelled"]) => console.log(result));

export async function refreshRegistration(registrationId: string): Promise<void> {
  const session = await request("getRegistration", {registrationId});
  console.log(session?.state, session?.result);
}
```

このコードを `notifications.ts` に保存し、利用側の画面を初期化するときに一度だけimportします。登録開始の例もこのモジュールを読み込みますが、セッションごとにリスナーを追加しません。通知の `registrationId` で対象のセッションを識別できます。登録リンクは別タブで開くため、通知を購読する元の画面は残ります。

通知は永続化・再送されません。登録画面を開く前に購読し、接続時や再接続時には `refreshRegistration` で `getRegistration` を呼び出して状態を確認してください。`registrationCompleted` の `players` はこの登録で扱ったプレイヤーの情報で、Directory全体ではありません。

`directoryChanged` を使う場合は購読時に `list` で初期状態を取得し、通知のたびに再取得します。再読み込みなどによって同じrevisionでも内容が変わる場合があるため、revisionの大小だけで通知を無視しないでください。

全体の状態を継続して表示する場合は、名前空間 `player-manager` の次のReplicantも購読できます。

| Replicant | 型 |
| --- | --- |
| `player-directory` | `Directory` |
| `player-directory-status` | `{ready: boolean; error: string | null}` |
| `player-directory-storage` | `StorageStatus` |

これらのReplicantは参照用のスナップショットとして扱い、データの変更にはAPIを使ってください。

## エラー処理

応答の型は `Response<T>` です。成功すると `{ok: true, data}`、失敗すると `{ok: false, error: {code, message}}` が返ります。NodeCGの通信に失敗してPromiseが拒否された場合も、別途 `try` / `catch` などで処理してください。

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
