# Phase 1 検証記録

検証日：2026-11-01（JST）。対象契約は[ローカル基本仕様](local-basic.md)。実GitHub・npm監査・AI・認証・AWS統合を完了した記録ではない。

## 実行環境

- Ubuntuホスト、Node.js 24.22.2、npm 11.19.1。
- Docker Engine 29.9.2、Docker Compose v5.6.1。
- Frontend/API/Workerは `node:24.22.2-bookworm-slim`、ホストUID/GIDでルート全体をbind mount。
- DynamoDB Local 3.3.2（Composeにimage digestを固定）、インメモリ。
- ブラウザー検証はPlaywright Chromium。ホストのPlaywrightブラウザーを一時ディレクトリへ取得して実行。

## 自動検証

| 検証 | 結果・根拠 |
|---|---|
| ホスト `npm ci` | 成功。サンドボックス内ではesbuildの子プロセス検証がEPERMとなり、ホスト権限で再実行して成功 |
| `npm run typecheck` | 全5workspaceとテスト・設定ファイルの検査に成功 |
| `npm run lint` | Frontend・API・Worker・共通パッケージ・テストを検査して成功 |
| `npm test` | 単体31件成功。URL/状態スキーマ、ローカル設定の拒否、Host/Origin、ポーリング間隔・終端・離脱・再試行 |
| `docker compose run --rm worker npm run test:integration` | DynamoDB Localの専用テーブルで11件成功。下記ケースを確認 |
| `npm run test:e2e` | 実Composeに対するブラウザーテスト1件成功。開始・ポーリング・完了・レポート・再読み込み・履歴遷移 |
| `npm run build` | Frontendの静的成果物、API/Workerエントリーポイント、共通パッケージ型検査が成功 |
| `npm run build:clean` | ホストの依存・既存distをコピーしない一時ディレクトリで `npm ci` とビルドが成功 |

統合テスト `tests/integration.test.ts` の確認範囲：

1. 監査作成202 → PENDING保存 → Worker完了 → レポート取得。別所有者の履歴・詳細を公開しない。
2. 認可未設定時の拒否、不正URL/JSON/query/cursor/job ID、未知のAPI、本文サイズ制限。
3. 同時8要求で作成は1件、残り7件は409。拒否分は回数を消費せず、5件完了後の要求は429。
4. 履歴の降順・ページング・管理データ除外。
5. モック処理失敗時のFAILED保存・スロット解放。
6. dispatch通知失敗時の503とFAILED保存。
7. 同一ジョブのWorker同時6呼び出しで処理1回。完了後に再実行しない。
8. 期限切れRUNNINGのJOB_TIMEOUT保存と解放。
9. 350KiBを超える結果の拒否と小さい失敗レコード保存。
10. 起動前から保存されたPENDINGをdispatcherが再取得して完了。
11. PENDINGからの完了更新と別所有者による実行を拒否。

## 開発環境の実測

- ComposeのFrontend/API/DynamoDBが起動し、APIのhealthcheckが成功した。APIとFrontendのNodeは両方24.22.2。
- ホストでReactの見出しを一時変更し、ブラウザーの再読み込みなしで見出しが変化。入力欄の状態とwindow上の識別値を保持した。終了時にソースを復元。
- ホストでAPIのhealth応答を一時変更し、Viteの `/api` Proxy越しに変更を確認。終了時にソースを復元。
- 専用テーブルのPENDINGジョブに `docker compose run --rm worker npm run audit:local -w workers/security-audit/app -- <job-id>` を実行し、試行回数1のCOMPLETEDとモック結果を取得。
- `MOCK_OUTCOME=failure` でAPIを起動し、画面から新しい監査を開始。FAILED / MOCK_FAILUREの表示を確認し、成功モードへ復元。
- 共有node_modulesを再インストールした後もComposeと検証が動作した。通常の動作確認でコンテナ内の個別インストール・IDE接続は使用していない。

## 未確認事項・限界

- VS CodeとCodex拡張機能の画面上での編集操作はこのセッションから目視確認していない。Codexによるルート以下の編集とbind mount反映は確認した。
- 所有権は今回のホストUID/GIDで確認。すべてのLinuxディストリビューション・CPU・ネイティブ依存の互換性を保証しない。
- クリーンビルドはPhase 1コードの独立した依存復元とビルドの検証。Lambdaランタイムでのnpm実行・デプロイ成果物・実AWSの認証と連携は後続Phase。
- Localの履歴・日次カウンターはDynamoDBコンテナ停止で消失する。実リポジトリの公開状態・対象SHA・脆弱性・AIの事実整合性はまだ検証しない。
- PoC全体の完了条件は[検証計画](../testing.md)で別途管理する。
