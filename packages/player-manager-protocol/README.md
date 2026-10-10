# @nanahuse/player-manager-protocol

Player Managerと外部NodeCG bundleが共有する唯一のPublic Contractです。Player、Directory、Identity、Operations、Registration Session、通知payload型とpure helperを定義します。実行時依存はありません。npm registryには公開しません（private: true）。

## pnpmでの利用

リリースタグへ固定します。mainへの依存は使用しません。

```json
{"dependencies":{"@nanahuse/player-manager-protocol":"github:Nanahuse/player-manager#v2.2.0&path:/packages/player-manager-protocol"}}
```

開発時は `github:Nanahuse/player-manager#<full-commit-SHA>&path:/packages/player-manager-protocol` も利用できます。`<full-commit-SHA>`を実際のコミットで置き換えてください。

Gitインストールのprepareでbuildします。TypeScriptはこのpackage自身のdevDependencyです。ソースをconsumerのtsconfigへ追加する必要はありません。distはGitへコミットしません。利用環境はNode.js 24以上、pnpm 12.9.1です。

```ts
import type {
  Player, PlayerId, PlayerManagerAPI, Operations, MatchingInput,
  Resolution, Account, EvidenceSet, Assignment, RegistrationSession, PlayerManagerEvents,
} from '@nanahuse/player-manager-protocol';
import {
  API_VERSION, BUNDLE_NAME, MESSAGE_PREFIX, resolveDisplayName, playerEditUrl,
  operationMessageName, eventMessageName,
} from '@nanahuse/player-manager-protocol';

const playerId: PlayerId = "existing-player-id";
window.open(playerEditUrl(playerId), "_blank", "noopener,noreferrer");

operationMessageName('resolve'); // player-manager.v2.resolve
eventMessageName('registrationCompleted'); // player-manager.v2.registrationCompleted
eventMessageName('directoryChanged'); // player-manager.v2.directoryChanged
const receive = (result: PlayerManagerEvents['registrationCompleted']) => result.players;
```

`directoryChanged`は`{directoryRevision: number}`をpayloadとする変更通知です。Playerの全情報や変更差分、変更履歴は含みません。Playerの作成・更新・削除、Registrationによる変更、内容の異なる再読込、保存先変更でDirectoryの内容が変わった場合に発行されます。初回読み込み、変更のないRegistration、空の`mutate`、内容が同じ再読込や保存先変更では発行されません。受信側はイベントをDirectory再取得のトリガーとして扱い、`list()`を呼び出してください。イベントは永続化・再送されないため、起動時にも必ず`list()`で初期状態を取得してください。イベント受信時にrevisionの大小比較だけで通知を破棄してはいけません。revisionが同じでもDirectoryの内容が変化する場合があります。

API_VERSIONはwire互換性のバージョンで、package versionとは独立しています。現在は2です。Node16 / NodeNext / Bundlerの型解決、ESM importに対応します。既存nodecg-race-layoutsのCommonJS＋Node16環境に合わせてCommonJS出力も提供します。

`playerEditUrl(playerId: PlayerId): string` は既存Playerの編集画面URLをNodeCG相対URLで返します。playerIdはURLエンコードされ、空文字はTypeErrorになります。Player Managerの既存Directory編集フォームを使い、`get` / `update` / `delete` APIで操作します。

Public Registration APIはbeginRegistration/getRegistration、resolveRegistration、assignRegistrationAccount、approveRegistrationConflict、selectRegistrationMergeSurvivor、setRegistrationPlayerDeletion、completeRegistration、cancelRegistrationとregistrationCompleted/registrationCancelledイベントです。`beginRegistration`の`createPlayerOnEmpty`は任意指定で、trueの場合のみ空入力の保存で新しいPlayerを作成します。省略時の空入力はPlayerを作成しません。`searchIdentities`はSpeedrun.comの名前検索にも利用できます。旧searchUsers/getUserは本体の内部契約にのみ存在します。これらの内部操作、本体srcやこのpackageの内部ファイルには依存しないでください。exportする入口はpackageルートだけです。

## 単独ビルド

このディレクトリだけを別の場所へコピーしても、`pnpm install`（prepareを含む）または`pnpm build`でビルドできます。rootのdomainやtsconfigには依存しません。表示名解決の実装もこのpackageが所有します。

### Git prepareの許可（pnpm 12）

Git依存のビルドはconsumer側のallowBuildsによる明示許可が必要です。単なるpackage名だけでは許可されません。repository URL形式で指定すると、同repositoryの任意のtag・commitを許可でき、参照先のtagやSHAを更新してもキーを書き換える必要はありません。

```yaml
allowBuilds:
  '@nanahuse/player-manager-protocol@git+https://github.com/Nanahuse/player-manager.git': true
```

`github:`依存がtarballとして取得される場合も、このrepository URL形式のキーにマッチします。初回installがERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWEDを返す場合は、エラーに表示されるキーも利用できます。
