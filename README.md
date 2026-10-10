# Player Manager

独立したNodeCG Player Directoryバンドル。RaceTime / Speedrun.com / Twitchアカウントを内部UUIDの`playerId`へ紐付けます。レース、DraftConfig、RaceSessionには依存しません。

## 起動

Node.js 24、pnpmを使用します。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

NodeCG Dashboardの **Player Directory** パネルで既存Playerを編集・削除し、**＋ 新規**から独立した **Player Registration** 画面を開いてPlayerを登録できます。Registrationでは入力したアカウントの探索・突合・競合解消・保存を行い、Speedrun.comユーザーも名前で検索できます。新規画面ではアカウントや表示名が空のPlayerも、保存操作をした場合に登録できます。別のNodeCGに導入するときは、ビルド済みリポジトリを`bundles/player-manager`へ配置してください。単体起動は本リポジトリのNodeCG CLIを使います。

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

Registration は Matching Engine の closure exploration を使用します。Input と Required Account を seed とし、RaceTime / Speedrun.com profile、Twitch / YouTube による検索、発見した Account の関連 profile を訪問済み管理付きで展開します。Account / Evidence graph はユーザーが assignment や Conflict を確認するまで Directory に保存しません。検索 Candidate は完全な結果を確認できない場合や複数結果の場合に保持します。

確定時は Resolution から Commit Plan を作り、Existing Player の revision、Required constraint、Conflict、Candidate、account schema と uniqueness を検証します。外部 profile の再取得はせず、create/update/delete を一回の Directory 保存で適用します。名前のみでは identity を接続しません。
## 公開API v2

公開契約はworkspace package [@nanahuse/player-manager-protocol](packages/player-manager-protocol/README.md)が唯一の定義元です。本体も同じpackageを利用します。npm registryへは公開しません。

バージョンの定義元はルートの`package.json`です。バージョンを更新するときは`packages/player-manager-protocol/package.json`も同じ値に更新してください。mainへマージ後、CIが成功すると`v{version}`形式のGitタグが自動発行されます。バージョンを変更しないマージではタグは発行されません。Protocolは従来どおりGitタグを指定してインストールしてください。

consumerはpnpmのGitHub subdirectory dependencyを利用し、リリースタグまたはcommit SHAへ固定します。Gitインストール時のprepareで型定義とJavaScriptを生成するため、distのGit管理は不要です。

```json
{"dependencies":{"@nanahuse/player-manager-protocol":"github:Nanahuse/player-manager#v2.0.1&path:/packages/player-manager-protocol"}}
```

```ts
import type {Player, PlayerManagerAPI, Operations, Resolution} from "@nanahuse/player-manager-protocol";
import {resolveDisplayName, BUNDLE_NAME, operationMessageName} from "@nanahuse/player-manager-protocol";
```

Node16 / NodeNext / Bundlerに対応します。nodecg-race-layoutsのCommonJS＋Node16にも対応するため、ESMとCommonJSの出力・型定義を用意しています。内部pathのimportはexportsで拒否します。

他バンドルからはメッセージ`player-manager.v2.<operation>`を名前空間`player-manager`へ送ります。応答は`{ok:true,data}`または`{ok:false,error:{code,message}}`。NodeCG transport自体の失敗は別途catchします。

```ts
const result = await nodecg.sendMessageToBundle(
  "player-manager.v2.find", "player-manager",
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
| resolve | `{input: MatchingInput, requiredAccounts?}` | graph Resolution |
| reload | undefined | Directory |
| searchIdentities | `{provider, query, mode?}` | `{identities,hasMore}` |
| getIdentity | `{provider, value}` | ProviderIdentity |

Registration は `beginRegistration`, `getRegistration`, `resolveRegistration`, `assignRegistrationAccount`, `approveRegistrationConflict`, `selectRegistrationMergeSurvivor`, `setRegistrationPlayerDeletion`, `completeRegistration`, `cancelRegistration` を使用します。`completeRegistration` は registrationId のみを受け取り、最終処理は Resolution の assignment から決まります。

findのproviderは`racetime`, `speedrunCom`, `twitch`, `twitch-id`, `youtube`。updateは全フィールド置換で、リンク解除は`null`です。

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
RaceTime ID、Speedrun.com ID、Twitch login、YouTube channel のいずれからでも Matching を開始できます。Required Account も Input と同じ seed として探索します。探索候補と検索時の warnings は Resolution に保持されます。

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

公開型は `@nanahuse/player-manager-protocol` の `PlayerManagerAPI` / `Operations` を参照してください。Wire API は `player-manager.v2.*` を使います。Resolution は Account / Evidence / Assignment graph で表現し、Directory を変更せずに探索・割り当て・Conflict 承認・Merge survivor 選択を行います。

- `beginRegistration({input, requiredAccounts?, createPlayerOnEmpty?})`: Matching Engine で探索して Resolution を持つ session を開始します。`createPlayerOnEmpty: true` は探索入力が空の場合も保存時に新規Playerを作る明示的なモードです。省略時の空入力は従来どおりPlayerを作成しません。
- `getRegistration({registrationId})`: session の input、Required constraint、Resolution、commit 結果を取得します。
- `resolveRegistration`, `assignRegistrationAccount`, `approveRegistrationConflict`, `selectRegistrationMergeSurvivor`, `setRegistrationPlayerDeletion`: サーバー側で Resolution 操作を行い、再評価結果を保存します。
- `completeRegistration({registrationId})`: action を指定せず、Resolution から commit plan を生成します。Conflict、未充足 Required、lookup error、未解決 Candidate、stale revision を検証し、create/update/delete を一回の保存で適用します。
- `cancelRegistration({registrationId})`: session をキャンセルします。

セッションはメモリ上で30分保持され、期限後最大1時間で削除されます。再起動をまたいだセッション復旧は行いません。完了通知は `player-manager.v2.registrationCompleted` で `{registrationId, directoryRevision, players, deletedPlayerIds}`、取消通知は `player-manager.v2.registrationCancelled` で `{registrationId}` を送ります。
Git依存のprepare実行には、consumer側でrepository URL形式のallowBuilds設定が必要です。具体的な設定はProtocol packageのREADMEを参照してください。
