# Player Manager

Player Managerは複数サービスのアカウントを一人のプレイヤーにまとめて登録・検索するNodeCGバンドルです。

## アカウントの登録

RaceTimeやSpeedrun.comなどのアカウントを入力すると、公開プロフィールから連携済みのアカウントを自動的に探します。見つかったアカウントを確認し、同じプレイヤーの情報としてまとめて登録できます。

## プレイヤーの検索

登録済みのアカウントからプレイヤーを特定し、その表示名や別サービスのアカウントを取得できます。例えば、Twitchのログイン名でプレイヤーを探し、登録されているSpeedrun.comアカウントを取得できます。

登録情報はNodeCG Dashboardだけでなく、ほかのNodeCGバンドルからも利用できます。

## ドキュメント

- [インストール方法](docs/installation.md)
- [使い方](docs/usage.md)：登録、検索、編集の操作方法
- [データの保存](docs/storage.md)：保存先の設定と障害対応
- [外部NodeCGバンドルとの連携](docs/integration.md)：ほかのバンドルからの登録・検索
- [Protocolパッケージ](packages/player-manager-protocol/README.md)：パッケージの導入と公開型
