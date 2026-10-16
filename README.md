# Player Manager

## 概要

Player Managerは複数サービスのアカウントをプレイヤー単位で登録・検索するNodeCGバンドルです。RaceTime、Speedrun.com、Twitch、YouTubeに対応しています。

## 主な機能

- 登録では入力したアカウントから連携済みのアカウントを自動的に発見し、確認してまとめて登録できます。
- 検索では登録済みプレイヤーを名前、ID、各サービスのアカウントから探せます。外部NodeCGバンドルからも検索・取得できます。
- プレイヤーごとに同じサービスの複数アカウントや、その他のプロフィールURLを管理し、表示名やアカウントを編集できます。
- 保存先にローカルJSONまたはGoogle Sheetsを使えます。

## インストール

必要環境は **Node.js 24、pnpm 12.9.1、Git** です。既存のNodeCGへ導入する場合は、NodeCG 2.5.0以上の2.x を使用してください。

### 単体で起動する

本リポジトリにはNodeCGが依存パッケージとして含まれます。

```sh
git clone https://github.com/Nanahuse/player-manager.git
cd player-manager
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

既定では [http://localhost:9090](http://localhost:9090) を開き、Dashboardの「Player Directory」を選択します。

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

## 基本操作

### 登録する

1. 「Player Directory」の「＋ 新規」を押します。
2. 分かっているアカウントを「探索入力」に入力し、「入力を再探索」を押します。
3. 見つかったアカウントを確認します。所属や重複の確認が必要な場合は、画面の案内に沿って対応します。
4. 「この内容で保存」を押し、確認したアカウントをまとめて登録します。

### 検索する

「Player Directory」の「名前 / ID / アカウントを検索」に入力して一覧を絞り込みます。プレイヤーを選ぶと登録済みの情報を確認・編集できます。

詳しい手順は目的に応じて次の文書を参照してください。

- [使い方](docs/usage.md)：登録、検索、編集、競合解決
- [データの保存](docs/storage.md)：保存先の設定、Google Sheets、障害対応
- [外部バンドルとの連携](docs/integration.md)：外部NodeCGバンドルからの利用
