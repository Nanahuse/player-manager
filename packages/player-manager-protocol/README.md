# @nanahuse/player-manager-protocol

Player Managerと連携するNodeCGバンドル向けの型と関数を提供します。APIのバージョンは3です。メッセージの名前空間は `player-manager.v3`、送信先バンドル名は `player-manager` です。

## インストール

Node.js 24、pnpm 12.9.1を使用します。npmレジストリには公開していないため、GitHubのサブディレクトリを依存先に指定します。稼働するPlayer Managerと同じリリースタグまたはコミットに固定してください。以下の例ではこのREADMEのAPIを提供するタグ `v3.1.0` を指定しています。

利用側バンドルの `package.json` に追加します。

```json
{
  "dependencies": {
    "@nanahuse/player-manager-protocol": "github:Nanahuse/player-manager#v3.1.0&path:/packages/player-manager-protocol"
  }
}
```

利用側の `pnpm-workspace.yaml` に、Git依存のビルド許可を追加します。

```yaml
allowBuilds:
  '@nanahuse/player-manager-protocol@git+https://github.com/Nanahuse/player-manager.git': true
```

```sh
pnpm install
```

この許可は同じリポジトリのタグ・コミットに適用されます。`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` が出る場合は、設定が利用側のプロジェクトで読み込まれているか確認してください。

インストール時の `prepare` でJavaScriptと型定義を生成します。ソースを利用側の `tsconfig.json` に追加する必要はありません。実行時の依存パッケージはありません。ESM・CommonJSと、TypeScriptのNode16・NodeNext・Bundlerによる型解決に対応します。importはパッケージのルートから行ってください。

## 公開APIへの案内

型の定義元は [src/index.ts](src/index.ts) と [src/player.ts](src/player.ts) です。操作ごとの引数・戻り値は `Operations[操作名]["request"]` と `Operations[操作名]["response"]` を参照してください。

| 用途 | 主な公開型 |
| --- | --- |
| プレイヤー情報 | `Player`、`Directory`、`DirectoryAccount` |
| アカウントのプロフィールURL | `Operations` の `getAccountProfileUrl` |
| APIの呼び出し | `PlayerManagerAPI`、`Operations`、`Response<T>`、`FailureCode` |
| 登録 | `MatchingInput`、`RegistrationSession`、`RegistrationResult` |
| 通知・保存状態 | `PlayerManagerEvents`、`StorageStatus` |

APIの呼び出し方、登録画面との連携、通知、エラー処理は[外部バンドルとの連携](../../docs/integration.md)を参照してください。
