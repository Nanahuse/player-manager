# Player Manager

独立したNodeCG Player Directoryバンドル。RaceTime / Speedrun.com / Twitchアカウントを内部UUIDの`playerId`へ紐付けます。レース、DraftConfig、RaceSessionには依存しません。

## 起動

Node.js 24、pnpmを使用します。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

NodeCG Dashboardの **Player Directory** パネルから作成・編集・削除・検索・自動突合ができます。別のNodeCGに導入するときは、ビルド済みリポジトリを`bundles/player-manager`へ配置してください。単体起動は本リポジトリのNodeCG CLIを使います。

## データと保存

- 内部`playerId`はUUID。各Playerは`revision`を持ち、編集・削除には読み取ったrevisionが必要です。
- `racetime` / `speedrunCom`: `{userId, name, weblink?}`または`null`。
- `twitch`: `{userId: string | null, login}`または`null`。loginは小文字へ正規化します。
- アカウント未登録は`null`。Race固有のdraft/active状態は持ちません。
- 既定の保存先はバンドル内`data/player-directory.json`。一時ファイルへの書込・同期・rename後にメモリとReplicantを更新します。ファイル破損時は起動時ロードを失敗させ、既存ファイルを上書きしません。
- 保存先は`cfg/player-manager.json`の`directoryFile`で変更できます。相対パスはNodeCGプロセスの作業ディレクトリ基準です。単一NodeCGプロセスで所有してください。
- `data`はGit管理対象外です。バックアップ対象に含めてください。外部でファイルを直す場合はNodeCGを停止してから行います。
- 他バンドルは削除済みplayerIdを扱える必要があります。Race参照の検査はこのバンドルでは行いません。

## 突合ルール

`resolve`は**保存を伴わないプレビュー**です。RaceTime/SRCプロフィールのTwitch loginからTwitchを補完し、SRCユーザー検索の結果をTwitch完全一致で検査します。名前だけの一致では紐付けません。候補複数または検索結果が途中の場合は`ambiguous`、既存の別Playerへの紐付けやプロフィールの不一致は`conflict`です。保存する場合は結果をフォームへ反映して確認します。確定は通常のcreate/update経由で再度重複検査します。

RaceTimeのIDまたは `https://racetime.gg/user/<id>` を入力すると、公開プロフィールAPIから名前とTwitchを取得します。resolveは `{input:{racetime:{userId:"<id>"}}}` だけで呼べます。RaceTime → Twitch → Speedrun.com の順に突合します。保存時もRaceTimeを再取得します。レース取得やTwitch APIによる本人確認は行いません。Twitch loginは変更され得るため、分かる場合はTwitch user IDも保存します。SRCは手動入力時も保存時に`getUser`で取得し直します。API障害・rate limitは明示的なエラーとし、未解決や一致に置き換えません。

## 公開API v1

公開契約はworkspace package [@nanahuse/player-manager-protocol](packages/player-manager-protocol/README.md)が唯一の定義元です。本体も同じpackageを利用します。npm registryへは公開しません。

consumerはpnpmのGitHub subdirectory dependencyを利用し、リリースタグまたはcommit SHAへ固定します。Gitインストール時のprepareで型定義とJavaScriptを生成するため、distのGit管理は不要です。

```json
{"dependencies":{"@nanahuse/player-manager-protocol":"github:Nanahuse/player-manager#v1.0.0&path:/packages/player-manager-protocol"}}
```

```ts
import type {Player, PlayerManagerAPI, Operations, Resolution} from "@nanahuse/player-manager-protocol";
import {resolveDisplayName, BUNDLE_NAME, operationMessageName} from "@nanahuse/player-manager-protocol";
```

Node16 / NodeNext / Bundlerに対応します。nodecg-race-layoutsのCommonJS＋Node16にも対応するため、ESMとCommonJSの出力・型定義を用意しています。内部pathのimportはexportsで拒否します。

他バンドルからはメッセージ`player-manager.v1.<operation>`を名前空間`player-manager`へ送ります。応答は`{ok:true,data}`または`{ok:false,error:{code,message}}`。NodeCG transport自体の失敗は別途catchします。

```ts
const result = await nodecg.sendMessageToBundle(
  "player-manager.v1.find", "player-manager",
  {provider: "twitch", value: "runner"},
);
if (result.ok) console.log(result.data); // Player | null
```

| operation | request | data |
| --- | --- | --- |
| list | undefined | Directory |
| get | `{playerId}` | Player / null |
| find | `{provider, value}` | Player / null |
| create | `{input: PlayerInput}` | Player |
| update | `{playerId, revision, input: PlayerInput}` | Player |
| delete | `{playerId, revision}` | `{playerId}` |
| resolve | `{input: PlayerInput}` | `{status,input,playerId,candidates,message}` |
| reload | undefined | Directory |
| searchIdentities | `{provider, query, mode?}` | `{identities,hasMore}` |
| getIdentity | `{provider, value}` | ProviderIdentity |

findのproviderは`racetime`, `speedrunCom`, `twitch`, `twitch-id`。updateは全フィールド置換で、リンク解除は`null`です。resolveのcandidatesは構造化形式です（下記参照）。Player IDがnullのmatchedはアカウント間の一致を意味し、まだDirectory登録されていません。

Extension間では`nodecg.extensions["player-manager"]`の`{apiVersion, ready, request}`も使えます。依存側のmanifestでbundleDependenciesを宣言してください。`ready`は初期ロードの終了を表し、成功状態はstatus Replicantまたはlist応答で確認します。

Replicant `player-directory`は`{schemaVersion:1,revision,players}`、`player-directory-status`は`{ready,error}`。両方とも名前空間`player-manager`で購読してください。これらは公開スナップショットです。利用側は書込を行わず、変更にはメッセージAPIを使用します。NodeCGのReplicant自体は書込権限を分離しないため、信頼済みバンドル内での利用が前提です。

## 検証

```sh
pnpm typecheck
pnpm test
pnpm build
```

参考: https://github.com/Nanahuse/nodecg-race-layouts のPlayerモデルと自動突合方針。既存リポジトリの変更や既存スプレッドシートからの自動移行は含みません。

### どのアカウントからでも突合
resolveはRaceTime ID、Speedrun.com ID、Twitch loginのどれか一つから開始できます。Directoryの既存リンクを補完し、Twitchを共通キーとして両サービスを検索します。RaceTimeはTwitch直接逆引きAPIがないためTwitch名/SRC名で検索した候補のTwitchを完全一致で検証します。名前が異なるアカウントを網羅するものではなく、見つからない場合はRaceTimeプロフィールURLを入力してください。補完先のAPI障害はwarningsへ返し、他の結果を保持します。ambiguousも確定済みの部分のみフォームへ反映できます。candidatesは構造化形式です。

### URL入力
Twitch欄にはユーザー名または `https://www.twitch.tv/nanahuse`、Speedrun.com欄にはID・ユーザー名または `https://www.speedrun.com/users/Nanahuse`（旧 `/user/Nanahuse` も可）を入力できます。末尾のスラッシュ・クエリ・フラグメントを除いてアカウントを取得します。保存するのはURLではなく、正規化したTwitch loginとAPIが返したSpeedrun.com userIdです。

### 表示名
手動表示名がない場合は、Twitch表示名 → Twitch login → Speedrun.com名 → RaceTime名の順です。Twitch表示名はRaceTime公開プロフィールのtwitch_display_nameから取得できた場合に保持します。未取得時はloginへフォールバックします。共通関数resolveDisplayNameを@nanahuse/player-manager-protocolから公開しています。自動解決した名前をmanualDisplayNameには書き込みません。

### YouTubeと任意アカウント
各アカウントおよび手動表示名は空欄で保存できます。空欄のみのPlayerも内部UUIDで区別します。YouTubeは任意のyoutubeフィールド（チャンネルURL文字列）です。/channel/UC…、/@handle、旧/user/・/c/形式に対応し、動画URLは拒否します。SRCプロフィールから取得したYouTubeリンクを補完し、共通URLをDirectory照合・重複検出・競合検出に使います。YouTube入力からSRC lookup検索を試み、応答のリンクが完全一致した候補だけを採用します。検索の網羅性は保証しません。RaceTime公開APIにはYouTubeがないため、RaceTimeとの橋渡しにはDirectoryの既存リンクか他の共通情報が必要です。チャンネルIDとハンドルの相互変換は行わず、異なる形式を同一チャンネルと推測しません。findのproviderにyoutubeを指定できます。表示名の優先順位は従来どおりです。

### 保存データ

RaceTimeはuserId/name、Speedrun.comはuserId/name/weblinkを保存します。Twitchのlogin/displayName/userIdとYouTubeのURLはプレイヤー直下に一度だけ保存します。外部APIの連携情報は突合時の証拠として扱い、取得元ごとのコピーは保存しません。表示名の優先順位に必要な各サービスの名前、内部playerIdと更新競合防止用revisionは保持します。

旧JSONは読み込み時に検証して重複を集約し、元ファイルを同じフォルダーのbefore-compact付き.bakへバックアップしてから置き換えます。不一致・競合のある旧データは移行せずエラーにします。

## Googleスプレッドシートへの保存

管理画面の「保存先」にGoogleスプレッドシートのURLまたはIDを入力して「接続・再試行」を押します。空欄で適用するとローカル保存に戻ります。設定は `data/player-directory.json.storage.json`（directoryFileを指定した場合はその末尾に `.storage.json`）に保存され、再起動後も保持します。

### 初回の認証設定

1. Google CloudでSheets APIを有効にし、サービスアカウントを作成します。
2. サービスアカウントのJSON鍵をリポジトリ外の安全なローカルフォルダーに置きます。チャットや画面のシート欄には貼り付けません。
3. NodeCGの `cfg/player-manager.json` に鍵ファイルのパスを設定し、NodeCGを再起動します。

```json
{
  "googleCredentialsFile": "C:/Private/google/player-manager-service-account.json"
}
```

代わりに環境変数 `GOOGLE_APPLICATION_CREDENTIALS` でサービスアカウントJSONファイルのパスを指定できます。鍵の内容はブラウザーへ送信しません。

4. 対象スプレッドシートを、JSON内の `client_email` に編集者として共有します。
5. 管理画面でシートURLまたはIDを設定します。閲覧権限のみ、認証未設定、通信エラーの場合はローカル保存になります。

### シートの形式と切り替え

専用タブ `PlayerDirectory` のA:L列を使用します。他のタブは変更しません。1行目は形式識別子・バージョン・Directory revision、2行目は列名、3行目以降がプレイヤーです。IDや名前は文字列として書き込みます。数式として解釈しません。

列: playerId / revision / manualDisplayName / racetimeId / racetimeName / speedrunComId / speedrunComName / speedrunComWeblink / twitchId / twitchLogin / twitchDisplayName / youtube。

- 既存の有効なDirectoryがシートにある場合は、それを読み込みます。異なるローカルデータは `.before-sheet-*.bak` に退避します。自動マージはしません。
- 専用タブがない、または空の場合は、現在のDirectoryから初期化します。同名タブに別形式のデータがある場合は上書きしません。
- シート保存時もローカルに控えを保存します。失敗した変更はローカルに保持し、「このPC（ローカル）・シート未同期」と理由を表示します。
- 未同期データがある場合は再起動後もローカルを使用します。「接続・再試行」で接続を確認し、シート側が変更されていなければ再同期します。通信応答だけが失われていた場合も再接続時に照合します。
- シート側にも変更がある場合は自動上書きを止め、両方を保持します。ローカルJSONを退避して比較・調整してください。シートを読み直す場合は空欄でローカルへ切り替えてから同じシートを接続します（切り替え時にローカルのバックアップを残します）。
- 保存前に共有データ全体の変更を検出します。ただしSheets APIには比較と更新をまとめた排他制御がないため、複数のNodeCGサーバーからの同時書き込みは避けてください。複数の操作画面は同じNodeCGサーバーへ接続してください。

公開API: `storage` で現在の状態、`configureStorage({spreadsheet})` で設定変更。Replicant `player-directory-storage` は `{destination:"local"|"spreadsheet", spreadsheetId, pending, message}` を通知します。設定・データ・バックアップはGitに含めません。

公式仕様: [Sheets APIの一括更新](https://developers.google.com/workspace/sheets/api/guides/batchupdate)、[Google認証ライブラリ](https://docs.cloud.google.com/nodejs/docs/reference/google-auth-library/latest/google-auth-library/jwt)。


## 登録画面・公開APIの追加

公開型は@nanahuse/player-manager-protocolのPlayerManagerAPI/Operationsを参照してください。旧player-directory.v1.*も受け付けますが、resolveのcandidatesは両名前空間とも {type:"identity",provider,value} または {type:"player",playerId} です。youtubeは必ず文字列またはnullで返します。

- status: 初期読み込み状態。
- mutate({operations}): create/update/deleteを最大100件、最終状態で重複検証して一括保存します。操作ごとに一意のref、update/deleteにはplayerIdとrevisionを指定します。同じPlayerへの複数操作は拒否します。失敗時は全件未適用、成功時はDirectory revisionを1回進めます。refは永続化しません。
- searchIdentities({provider,query,mode?}) / getIdentity({provider,value}): RaceTimeとSpeedrun.comに対応。Twitch/YouTubeの直接検索・取得はunsupported_operationです。共通リンクによるresolveは利用できます。
- beginRegistration({input}): 即時に{registrationId,url}を返します。同じNodeCGサーバー基準でURLを開きます。URLにアカウント情報は含みません。
- getRegistration({registrationId}): pending/completed/cancelled/expiredと結果を取得します。存在しないIDはnull。通知の取り逃しから復旧できます。

管理画面の「この入力で登録・突合画面を準備」から登録画面を開けます。既存Playerを選ぶだけでは更新しません。明示的な更新は全フィールド置換で、nullはリンク解除です。createのplayerIdはサーバーが発行します。

完了通知はplayer-manager.v1.registrationCompletedで{registrationId,action,player}（actionはexisting/created/updated）、取消通知はplayer-manager.v1.registrationCancelledで{registrationId}です。他バンドルはnodecg.listenForのbundle引数にplayer-managerを指定し、registrationIdで照合してください。通知登録後にbeginRegistrationを呼び、返されたURLへのリンクを表示します。

画面内部用APIはresolveRegistration、completeRegistration、cancelRegistrationです。セッションは30分で期限切れ、期限後最大1時間で削除されます。メモリのみで保持し再起動で消えます。操作待ちの長時間リクエストや呼び出し元のレース情報の保存は行いません。

Registrationのambiguous状態では新規登録・更新を拒否します。既存Playerの明示選択は許可します。identity候補の選択または入力修正後に再突合し、曖昧さを解消してから新規登録・更新してください。

Git依存のprepare実行には、consumer側でrepository URL形式のallowBuilds設定が必要です。具体的な設定はProtocol packageのREADMEを参照してください。
