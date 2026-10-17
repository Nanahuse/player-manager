# インストールと起動

必要環境は **Node.js 24、pnpm 12.9.1、Git** です。既存のNodeCGへ導入する場合は、NodeCG 2.5.0以上の2.x を使用してください。

## 単体で起動する

本リポジトリにはNodeCGが依存パッケージとして含まれます。

```sh
git clone https://github.com/Nanahuse/player-manager.git
cd player-manager
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

既定では [http://localhost:9090](http://localhost:9090) を開き、Dashboardの「Player Directory」を選択します。

## 既存のNodeCGへ導入する

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
