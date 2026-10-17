# Player Manager

Player Managerはプレイヤーに複数サービスのアカウントを紐付け、一元管理するNodeCGバンドルです。

表示名の変更やアカウントの追加・削除、サービスごとの代表アカウント（Primary）と追加アカウント（Sub）の管理ができます。

## アカウントの登録

RaceTimeやSpeedrun.comなどのアカウントを入力すると、公開プロフィールから連携済みのアカウントを自動的に探します。見つかったアカウントを確認し、同じプレイヤーに紐付けてまとめて登録できます。

## プレイヤーの検索

登録済みのアカウントからプレイヤーを特定し、その表示名や紐付けられた別サービスのアカウント情報を取得できます。例えば、Twitchのログイン名でプレイヤーを探し、同じプレイヤーに紐付けられたSpeedrun.comアカウントを取得できます。

登録情報はNodeCG Dashboardだけでなく、ほかのNodeCGバンドルからも利用できます。

## ドキュメント

- [インストール方法](docs/installation.md)
- [使い方](docs/usage.md)：登録、検索、編集の操作方法
- [データの保存](docs/storage.md)：保存先の設定と障害対応
- [外部NodeCGバンドルとの連携](docs/integration.md)：ほかのバンドルからの登録・検索
- [Protocolパッケージ](packages/player-manager-protocol/README.md)：パッケージの導入と公開型
