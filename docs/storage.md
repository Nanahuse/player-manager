# データの保存

## ローカル保存

初期状態ではバンドル内の `data/player-directory.json` に保存します。保存先を変えるには、NodeCGルートに `cfg/player-manager.json` を作成してNodeCGを再起動します。

```json
{
  "directoryFile": "data/players.json"
}
```

`directoryFile` は省略できます。相対パスの基準はNodeCGの作業ディレクトリです。選択した保存先の設定は保存するJSONのファイル名に `.storage.json` を付けたファイルに保持されます。データと保存先設定をバックアップ対象に含めてください。

## Google Sheetsを設定する

認証にはサーバーの[Application Default Credentials（ADC）](https://docs.cloud.google.com/docs/authentication/application-default-credentials)を使用します。サービスアカウントのJSON鍵を使う場合は、次の手順で設定します。

1. Google CloudのプロジェクトでGoogle Sheets APIを有効にし、サービスアカウントを作成します。
2. JSON鍵をリポジトリ外に保存します。NodeCGを起動する環境で、環境変数 `GOOGLE_APPLICATION_CREDENTIALS` に鍵のファイルパスを設定します。PowerShellでは次のように指定します。

   ```powershell
   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\Private\google\service-account.json"
   ```

3. 対象スプレッドシートを、鍵の `client_email` に「編集者」として共有します。
4. 環境変数を設定した同じ環境からNodeCGを起動します。
5. 「Player Directory」の「保存先」にシートのURLまたはIDを入力し、「接続・再試行」を押します。

保存には専用タブ「PlayerDirectory」を使います。タブがないか空なら、現在のデータを書き込みます。有効なデータがすでにある場合はシートから読み込み、内容の異なるローカルデータを `.before-sheet-*.bak` に退避します。同名タブに別形式のデータがある場合は接続できません。

接続前に編集中の内容を保存してください。シート保存時もローカルに控えを残します。ローカルへ戻す場合はURL・ID欄を空にし、「ローカル保存を使用」を押します。

## 接続・読み込みに問題がある場合

- 「シート未同期」と表示された変更はローカルに保存されています。認証・共有権限・通信を確認し、同じシートへ「接続・再試行」してください。再起動だけでは未同期の変更は送信されません。
- シート側にも変更がある場合は自動で上書きしません。ローカルJSONとシートをそれぞれ退避し、比較してから調整してください。シートの内容を採用する場合は、先にローカルJSONを別途バックアップします。その後、URL・ID欄を空にしてローカル保存へ切り替え、同じシートへ接続し直します。
- 「Directoryを復旧」と表示された場合はNodeCGのログで原因を確認し、保存ファイルや設定を修正して「再読み込み」します。「空のDirectoryを初期化」は既存ファイルと保存先設定をバックアップした上で、空のローカルデータを作る操作です。データを復元する操作ではありません。

ファイルを直接修正する場合はNodeCGを停止してください。同じシートに複数のNodeCGサーバーから同時に書き込むことは避け、複数の操作画面を使う場合は同じサーバーへ接続してください。
