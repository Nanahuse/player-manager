# Player Manager

## 概要

Player Managerは入力したアカウントから連携済みのアカウントを発見し、プレイヤー情報にまとめて登録するNodeCGバンドルです。RaceTime、Speedrun.com、Twitch、YouTubeに対応しています。

NodeCG Dashboardの「Player Directory」で、見つかったアカウントを確認して保存できます。

## 主な機能

- 入力したアカウントを手掛かりに連携先を探し、見つかったアカウントをまとめて登録できます。
- 一人のプレイヤーに同じサービスの複数アカウントや、その他のプロフィールURLを登録できます。
- プレイヤーの表示名やアカウントを編集できます。
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

1. 「Player Directory」の「＋ 新規」を押します。
2. 分かっているアカウントを「探索入力」に入力し、「入力を再探索」を押します。
3. 見つかったアカウントを確認します。所属や重複の確認が必要な場合は、画面の案内に沿って対応します。
4. 「この内容で保存」を押し、確認したアカウントをまとめて登録します。

登録済みのプレイヤーは「Player Directory」で選んで編集します。

詳しい手順は目的に応じて次の文書を参照してください。

- [使い方](docs/usage.md)：アカウントの入力方法、登録、編集、競合解決
- [データの保存](docs/storage.md)：保存先の設定、Google Sheets、障害対応
- [外部バンドルとの連携](docs/integration.md)：外部NodeCGバンドルからの利用
