# @nanahuse/player-manager-protocol

Player Managerと外部NodeCG bundleが共有する唯一のPublic Contractです。Player、Directory、Identity、Operations、Registration Session、通知payload型とpure helperを定義します。実行時依存はありません。npm registryには公開しません（private: true）。

## pnpmでの利用

リリースタグへ固定します。mainへの依存は使用しません。

```json
{"dependencies":{"@nanahuse/player-manager-protocol":"github:Nanahuse/player-manager#v2.0.1&path:/packages/player-manager-protocol"}}
```

開発時は `github:Nanahuse/player-manager#<full-commit-SHA>&path:/packages/player-manager-protocol` も利用できます。`<full-commit-SHA>`を実際のコミットで置き換えてください。

Gitインストールのprepareでbuildします。TypeScriptはこのpackage自身のdevDependencyです。ソースをconsumerのtsconfigへ追加する必要はありません。distはGitへコミットしません。利用環境はNode.js 24以上、pnpm 12.9.1です。

```ts
import type {
  Player, PlayerId, PlayerManagerAPI, Operations, MatchingInput,
  Resolution, Account, EvidenceSet, Assignment, RegistrationSession, PlayerManagerEvents,
} from '@nanahuse/player-manager-protocol';
import {
  API_VERSION, BUNDLE_NAME, MESSAGE_PREFIX, resolveDisplayName,
  operationMessageName, eventMessageName,
} from '@nanahuse/player-manager-protocol';

operationMessageName('resolve'); // player-manager.v2.resolve
eventMessageName('registrationCompleted'); // player-manager.v2.registrationCompleted
const receive = (result: PlayerManagerEvents['registrationCompleted']) => result.players;
```

API_VERSIONはwire互換性のバージョンで、package versionとは独立しています。現在は2です。Node16 / NodeNext / Bundlerの型解決、ESM importに対応します。既存nodecg-race-layoutsのCommonJS＋Node16環境に合わせてCommonJS出力も提供します。

Public Registration APIはbeginRegistration/getRegistration、resolveRegistration、assignRegistrationAccount、approveRegistrationConflict、selectRegistrationMergeSurvivor、setRegistrationPlayerDeletion、completeRegistration、cancelRegistrationとregistrationCompleted/registrationCancelledイベントです。旧searchUsers/getUserは本体の内部契約にのみ存在します。これらの内部操作、本体srcやこのpackageの内部ファイルには依存しないでください。exportする入口はpackageルートだけです。

## 単独ビルド

このディレクトリだけを別の場所へコピーしても、`pnpm install`（prepareを含む）または`pnpm build`でビルドできます。rootのdomainやtsconfigには依存しません。表示名解決の実装もこのpackageが所有します。

### Git prepareの許可（pnpm 12）

Git依存のビルドはconsumer側のallowBuildsによる明示許可が必要です。単なるpackage名だけでは許可されません。repository URL形式で指定すると、同repositoryの任意のtag・commitを許可でき、参照先のtagやSHAを更新してもキーを書き換える必要はありません。

```yaml
allowBuilds:
  '@nanahuse/player-manager-protocol@git+https://github.com/Nanahuse/player-manager.git': true
```

`github:`依存がtarballとして取得される場合も、このrepository URL形式のキーにマッチします。初回installがERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWEDを返す場合は、エラーに表示されるキーも利用できます。
