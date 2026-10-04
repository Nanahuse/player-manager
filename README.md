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
- `racetime` / `speedrunCom`: `{userId, name, twitchLogin}`または`null`。
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

型定義の入口は`src/protocol/index.ts`。独立した契約型として利用できます。

他バンドルからはメッセージ`player-directory.v1.<operation>`を名前空間`player-manager`へ送ります。応答は`{ok:true,data}`または`{ok:false,error:{code,message}}`。NodeCG transport自体の失敗は別途catchします。

```ts
const result = await nodecg.sendMessageToBundle(
  "player-directory.v1.find", "player-manager",
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
| searchUsers | `{query, mode: "name" / "lookup" / "twitch"}` | `{users,hasMore}` |
| getUser | `{userId}` | ProviderIdentity |

findのproviderは`racetime`, `speedrunCom`, `twitch`, `twitch-id`。updateは全フィールド置換で、リンク解除は`null`です。resolveのcandidatesはambiguous時にSRC user IDs、conflict時に該当Player IDsを返します。Player IDがnullのmatchedはアカウント間の一致を意味し、まだDirectory登録されていません。

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
resolveはRaceTime ID、Speedrun.com ID、Twitch loginのどれか一つから開始できます。Directoryの既存リンクを補完し、Twitchを共通キーとして両サービスを検索します。RaceTimeはTwitch直接逆引きAPIがないためTwitch名/SRC名で検索した候補のTwitchを完全一致で検証します。名前が異なるアカウントを網羅するものではなく、見つからない場合はRaceTimeプロフィールURLを入力してください。補完先のAPI障害はwarningsへ返し、他の結果を保持します。ambiguousも確定済みの部分のみフォームへ反映できます。candidatesはprovider:userId形式（Directory競合ではplayerId）です。

### URL入力
Twitch欄にはユーザー名または `https://www.twitch.tv/nanahuse`、Speedrun.com欄にはID・ユーザー名または `https://www.speedrun.com/users/Nanahuse`（旧 `/user/Nanahuse` も可）を入力できます。末尾のスラッシュ・クエリ・フラグメントを除いてアカウントを取得します。保存するのはURLではなく、正規化したTwitch loginとAPIが返したSpeedrun.com userIdです。

### 表示名
手動表示名がない場合は、Twitch表示名 → Twitch login → Speedrun.com名 → RaceTime名の順です。Twitch表示名はRaceTime公開プロフィールのtwitch_display_nameから取得できた場合に保持します。未取得時はloginへフォールバックします。共通関数resolveDisplayNameをsrc/protocol/index.tsから公開しています。自動解決した名前をmanualDisplayNameには書き込みません。

### YouTubeと任意アカウント
各アカウントおよび手動表示名は空欄で保存できます。空欄のみのPlayerも内部UUIDで区別します。YouTubeは任意のyoutubeフィールド（チャンネルURL文字列）です。/channel/UC…、/@handle、旧/user/・/c/形式に対応し、動画URLは拒否します。SRCプロフィールから取得したYouTubeリンクを補完し、共通URLをDirectory照合・重複検出・競合検出に使います。YouTube入力からSRC lookup検索を試み、応答のリンクが完全一致した候補だけを採用します。検索の網羅性は保証しません。RaceTime公開APIにはYouTubeがないため、RaceTimeとの橋渡しにはDirectoryの既存リンクか他の共通情報が必要です。チャンネルIDとハンドルの相互変換は行わず、異なる形式を同一チャンネルと推測しません。findのproviderにyoutubeを指定できます。表示名の優先順位は従来どおりです。

### 保存データ

RaceTimeはuserId/name、Speedrun.comはuserId/name/weblinkを保存します。Twitchのlogin/displayName/userIdとYouTubeのURLはプレイヤー直下に一度だけ保存します。外部APIの連携情報は突合時の証拠として扱い、取得元ごとのコピーは保存しません。表示名の優先順位に必要な各サービスの名前、内部playerIdと更新競合防止用revisionは保持します。

旧JSONは読み込み時に検証して重複を集約し、元ファイルを同じフォルダーのbefore-compact付き.bakへバックアップしてから置き換えます。不一致・競合のある旧データは移行せずエラーにします。
