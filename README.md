# Player Manager

## 概要

Player Managerは、プレイヤーの表示名と各サービスのアカウントをまとめて管理するNodeCGバンドルです。RaceTime、Speedrun.com、Twitch、YouTubeのアカウントや、その他のプロフィールURLを、一人のプレイヤーに紐付けて保存できます。

NodeCG Dashboardの **Player Directory** から登録・編集し、別のバンドルからもプレイヤー情報を取得できます。

## 主な機能

- 同じサービスの複数アカウントを管理し、代表の **Primary** と追加の **Sub** を選択できます。
- 公開プロフィールの連携情報と登録済みアカウントから、同じプレイヤーに属するアカウントを自動突合します。
- 候補や競合を確認して、所属先の変更、不要なアカウントの除外、プレイヤーの統合・分離を選べます。
- 保存先にはローカルJSONまたはGoogle Sheetsを使用できます。

入力できる情報は次のとおりです。

| サービス | 入力方法 |
| --- | --- |
| RaceTime | ユーザーID、`https://racetime.gg/user/<id>` |
| Speedrun.com | ユーザーID、ユーザー名、プロフィールURL。新規登録画面では名前による検索も可能 |
| Twitch | ログイン名、チャンネルURL |
| YouTube | チャンネルURL、`@handle`。動画URLは不可 |
| その他 | HTTPまたはHTTPSのプロフィールURL |

その他のURLは、対応サービスのURLなら突合し、それ以外はURLとして保存します。YouTubeのチャンネルIDとハンドルは相互変換しないため、形式の異なるURLを同一チャンネルとは判定しません。

## インストール

必要環境は **Node.js 24、pnpm 12.9.1、Git** です。既存のNodeCGへ導入する場合は、NodeCG **2.5.0以上の2.x** を使用してください。

### 単体で起動する

本リポジトリにはNodeCGが依存パッケージとして含まれます。

```sh
git clone https://github.com/Nanahuse/player-manager.git
cd player-manager
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

既定では [http://localhost:9090](http://localhost:9090) を開き、Dashboardの **Player Directory** を選択します。

### 既存のNodeCGへ導入する

NodeCGを停止し、そのルートディレクトリで次を実行します。

```sh
git clone https://github.com/Nanahuse/player-manager.git bundles/player-manager
cd bundles/player-manager
pnpm install --frozen-lockfile
pnpm build
cd ../..
nodecg start
```

最後のコマンドはNodeCG CLIを利用します。NodeCGの準備については[公式の導入手順](https://www.nodecg.dev/docs/installing/)を参照してください。

## 使い方

画面上ではプレイヤーを **Player**、アカウントを **Account** と表記します。探索や割り当ての変更は、保存ボタンを押した時点で登録データに反映されます。

### 新しいプレイヤーを登録する

1. **Player Directory** の **＋ 新規** を押し、**Player Registration** を開きます。
2. **探索入力** に分かっているアカウントを入力します。Speedrun.comは **Speedrun.comユーザー名で検索** から結果を選ぶこともできます。その他のURLは **その他のプロフィールURL** で **追加** します。
3. 必要なら **新規Playerの表示名** を入力し、**入力を再探索** を押します。
4. **Resolution Matrix** で、見つかったアカウントと割り当て先を確認します。候補・競合があれば、下記の手順で解決します。
5. **この内容で保存** を押します。既存プレイヤーに一致した場合は、そのプレイヤーに変更を反映します。

表示名やアカウントが空でも登録できます。表示名を指定しない場合は、Twitchの表示名・ログイン名、Speedrun.com名、RaceTime名の順に利用し、いずれもなければプレイヤーIDを表示します。

登録・編集の作業セッションは開始から30分で期限切れになり、NodeCGの再起動でも失われます。期限切れの場合は画面を開き直して作業してください。

### 表示名・複数アカウントを編集する

1. **Player Directory** で名前・ID・アカウントを検索し、プレイヤーを選択します。
2. **表示名** を編集します。空欄にすると、アカウントから表示名を選びます。
3. アカウントを追加するには、**Accountを追加** でサービスと **ID / login / URL** を入力し、**追加** を押します。追加するたびに突合が行われます。
4. 各サービスの代表を変えるには **Primaryにする** を押します。使わないアカウントは **使用しない** にし、戻す場合は **復元** を押します。
5. **変更を保存** を押します。入力欄に未追加の値が残っている場合は、先に追加するか入力を消してください。

同じサービスに複数アカウントがある場合も、Primaryは一つです。Subも保存されますが、代表として外部バンドルへ提供するアカウントはPrimaryです。

別の画面からプレイヤーが更新された場合は、**最新データを再読込** で最新の状態を取得してから編集します。削除は **Playerを削除** → **削除を確定** で行います。

### 自動突合の結果・競合を確認する

自動突合は、RaceTime・Speedrun.comの公開プロフィール、Twitch・YouTubeとの連携情報、登録済みデータを手掛かりにします。名前による検索結果だけで所属を確定しないため、候補の確認を求める場合があります。外部検索の結果は網羅性を保証しません。

既存プレイヤーの編集では **競合・確認事項を開く** または **競合を解決** から詳細を表示します。新規登録では、探索結果の下に同じ確認画面が表示されます。

| 確認する場所 | 操作 |
| --- | --- |
| **Resolution Matrix** | アカウントを選び、**割り当て先** または **使用しない** を選択。代表は **このAccountをPrimaryにする** で指定 |
| **Candidate Review** | プロフィールを確認。候補を採用する場合は、そのID・URLを探索入力やアカウント追加欄に追加。現在の所属でよければ **現在の割り当てで確定** |
| **Conflict Resolution** | 同じ人として取得されたアカウントが別々のプレイヤーに割り当てられている状態を確認。割り当てを直すか、別人として扱うなら **この分離状態を承認** |
| **Merge proposal** | 同一人物なら **Merge survivor** で残すプレイヤーを選び **Mergeを適用**。別人なら **Mergeしない** |

統合すると、アカウントは選択したプレイヤーへ集まり、統合される側のプレイヤーは削除対象になります。移動・除外でアカウントがなくなったプレイヤーには **削除提案** が出ます。削除するか確認してください。

未解決の競合、Primaryの未選択、候補の未確認、必須アカウントの不足、アカウント情報の取得エラーがあると保存できません。画面の理由を確認し、入力や割り当てを修正してから保存します。

## データの保存

### ローカル保存

初期状態では、バンドル内の `data/player-directory.json` に保存します。保存先を変える場合は、NodeCGルートの `cfg/player-manager.json` を作成し、再起動します。

```json
{
  "directoryFile": "data/players.json"
}
```

`directoryFile` は任意の設定項目で、相対パスはNodeCGの作業ディレクトリを基準にします。保存先の選択は、このJSONファイル名に `.storage.json` を付けたファイルに保持されます。データと保存先設定をバックアップ対象に含めてください。

### Google Sheetsを設定する

認証にはサーバーの[Application Default Credentials（ADC）](https://docs.cloud.google.com/docs/authentication/application-default-credentials)を使用します。サービスアカウントのJSON鍵を使う場合は、次の手順で設定します。

1. Google CloudのプロジェクトでGoogle Sheets APIを有効にし、サービスアカウントを作成します。
2. JSON鍵をリポジトリ外に保存し、NodeCGを起動する環境の `GOOGLE_APPLICATION_CREDENTIALS` にファイルパスを設定します。PowerShellの例は以下のとおりです。

   ```powershell
   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\Private\google\service-account.json"
   ```

3. 対象スプレッドシートを、鍵の `client_email` に **編集者** として共有します。
4. 環境変数を設定した同じ環境からNodeCGを起動します。
5. **Player Directory** の **保存先** にシートのURLまたはIDを入力し、**接続・再試行** を押します。

専用タブ **PlayerDirectory** に保存します。タブがない、または空なら現在のデータを書き込みます。有効なデータがある場合はシートを読み込み、内容の異なるローカルデータは `.before-sheet-*.bak` に退避します。同名タブに別形式のデータがある場合は接続できません。

接続前に編集中の内容を保存してください。シート保存時もローカルに控えを残します。ローカルへ戻す場合はURL・ID欄を空にし、**ローカル保存を使用** を押します。

### 接続・読み込みに問題がある場合

- **シート未同期** と表示された変更はローカルに保存されています。認証・共有権限・通信を確認し、同じシートへ **接続・再試行** してください。再起動だけでは未同期の変更は送信されません。
- シート側にも変更がある場合は自動上書きしません。ローカルJSONとシートを退避・比較してから調整してください。シートの内容を採用する場合は、ローカルJSONを別途バックアップし、空欄でローカルへ切り替えてから同じシートへ接続し直します。
- **Directoryを復旧** と表示された場合はNodeCGのログで原因を確認し、保存ファイルや設定を修正して **再読み込み** します。**空のDirectoryを初期化** は、既存ファイル・保存先設定をバックアップした上で空のローカルデータを作る操作です。データを復元する操作ではありません。

ファイルを直接修正する場合はNodeCGを停止してください。同じシートへの複数NodeCGサーバーからの同時書き込みは避け、複数の操作画面は同じサーバーへ接続してください。

## 外部バンドルとの連携

外部連携には `@nanahuse/player-manager-protocol` を使用します。インストール、プレイヤーの取得・登録、通知の購読、エラー処理は[Protocol README](packages/player-manager-protocol/README.md)を参照してください。

Protocolはプレイヤーの型、APIの引数・応答型、メッセージ名、表示名や編集URLを扱う関数を提供します。例えば、取得済みプレイヤーの編集画面は次のように開けます。

```ts
import {playerEditUrl} from "@nanahuse/player-manager-protocol";

function openPlayerEditor(playerId: string): void {
  window.open(playerEditUrl(playerId), "_blank", "noopener,noreferrer");
}
```

## 開発

リポジトリのルートで実行します。

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | Protocolをビルドし、型チェック・Vite・NodeCGを監視起動 |
| `pnpm build` | Protocol、Dashboard、Extensionをビルド |
| `pnpm build:protocol` | Protocolのみビルド |
| `pnpm typecheck` | Protocolをビルドし、ブラウザー・Extensionの型をチェック |
| `pnpm test` | Protocolをビルドし、Node.jsのテストを実行 |
