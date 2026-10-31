# Phase 2 検証記録

検証日：2026-11-01（JST）。対象は[ローカルWorker仕様](local-worker.md)。環境はPhase 1と同じUbuntu・Node.js 24.22.2・Docker Compose、DynamoDB Local 3.3.2。実SQS・Cognito・AWS Lambda・Secrets Managerは使用していない。

## 実外部APIの確認

まず `AUDIT_MODE=audit / AI_MODE=mock`、次に `AI_MODE=openai` をCompose Workerから直接実行した。

| 項目 | 記録 |
|---|---|
| 対象 | 公開リポジトリ `axios/axios` |
| 対象コミット | `9d11464a75ee5c644c0308d742f58755c0482594` |
| AIモックのjob ID | `01M69J7FF3BQRD0D9HVTQS7AXZ` |
| 実OpenAIのjob ID | `01M69J8TM92ZAS452ZSS5J07TD` |
| 実AIモデル | `gpt-5.6-luna`、Responses API、厳格JSON Schema |
| 機械監査の結果 | critical 0 / high 2 / moderate 5 / low 2 / info 0（パッケージ単位） |
| 実行結果 | 両方COMPLETED、attemptCount 1、DynamoDBへ結果保存 |
| 実AIの記録 | 呼び出し前のaiAttemptedAt/aiModelと永続予算予約を確認 |

対象の最新状態や脆弱性件数が常に同じになることを意味しない。実監査では対象SHAを保存し、npm Registryの監査情報は実行時点のものを使用する。

専用Projectの月額$10 Hard spend limitについて利用者へ確認し、設定済みとの回答を受けてから実APIを呼んだ。`.env` の鍵を表示・書き換えず、確認フラグを追加した。管理画面・管理APIで設定値を独立検証した記録ではない。

ブラウザーで実OpenAIジョブの詳細を開き、対象SHA、実npm監査、OpenAI、機械監査の検出結果、AIレポートを表示できた。追加の有料呼び出しは行っていない。

実APIの予算予約は1回・$0.05。これは実請求額ではない。既定Localテーブルの同日ジョブ作成枠は、前Phaseの動作確認を含め5回使用済み。既存レポートは閲覧できるが、新規作成は次のUTC日付まで上限に従う。検証後にカウンターや予算台帳をリセットしていない。

## 自動検証

| コマンド | 結果 |
|---|---|
| `npm run typecheck` | 5workspaceとテスト・設定ファイルを検査して成功 |
| `npm run lint` | 成功 |
| `npm test` | 単体80件成功 |
| `docker compose run --rm -e AUDIT_MODE=mock -e AI_MODE=mock worker npm run test:integration` | DynamoDB Localの専用テーブルで18件成功。外部AIはモック |
| `npm run test:e2e` | 起動済みComposeで1件成功。既存の開始・ポーリング・結果・履歴を回帰確認 |
| `npm run build:clean` | 独立した一時ディレクトリのnpm ciとビルドが成功 |

単体の追加確認：

- GitHubのcommit/tree/blob固定、private・symlink・欠損・サイズ・HTTPエラーの拒否。
- 保存済み不正リポジトリの再検証と、Content-Lengthがなくても応答サイズを制限すること。
- 非対応lock/workspace/git/file/URL依存・別Registry・不整合lockの拒否。
- スクリプト/configの除外、shellなしのnpm audit、子プロセスへの秘密値非継承。
- 脆弱性ありの非ゼロ終了を成功として解析し、timeout・出力超過・起動失敗・不正JSONでも一時ファイルを削除すること。
- 間接advisoryの解決、件数整合、検出なし、npmの修正候補対象名の保持。
- AIの不正な根拠index・識別子/数値/URLの追加・判定不整合、拒否・不完全出力・成否不明の拒否。HTTP再試行をしないこと。
- 日次・月次予約の境界、同一ジョブ重複予約、同時書込・台帳破損・残留lockでの安全な停止。

統合の追加確認：

- 実監査モード＋AIモックで機械根拠を保存し、AIを呼ばない。
- APIのmock dispatcherが実監査の待機ジョブをclaimしない。
- 同時WorkerでAI呼び出しは一回、呼び出し前に保存・予算予約が行われる。
- AI成否不明・予算不足でFAILEDになっても機械根拠を保持し、再実行しない。
- 機械監査失敗ではAI・レポート生成を行わない。
- APIが稼働していない想定でも、CLIが期限切れの実監査をJOB_TIMEOUTに確定し、AI記録と根拠を保持する。

## 秘密情報の境界

ComposeでFrontend/APIの環境にOpenAIキーがなく、root `.env` の内容がread-onlyの `/dev/null` mountで隠れていることを、値を出力せず検査した。鍵はWorkerの環境だけに注入する。npm子プロセスは環境を許可リストで構築する。

## 制約・残作業

- 認証はlocalhost限定の初期例外を継続し、CognitoはPhase 3で導入する。AWS向け認証バイパスは追加していない。
- 実AIは今回の公開リポジトリ一件で確認。全リポジトリ・全出力の意味的正確性を保証するものではない。入力・対応lock形式の制約はWorker仕様に従う。
- 専用ProjectのHard spend limitは利用者の設定済み回答が根拠。実際に$10へ到達させる試験や課金額の照合はしていない。台帳は実請求ではなく保守的予約額。
- DynamoDB Localの履歴と作成回数は停止で消えるが、ホストのAI台帳は保持する。実監査結果の閲覧用データはLocalの停止まで確認できる。
- ローカル台帳は単一ホスト用。AWS用の予算・リース・Secrets Manager・SQS再試行・Lambda内npm実行は後続Phase。
- VS Code/拡張機能の画面操作は引き続き未確認。開発環境とPoC全体の完了は[検証計画](../testing.md)で別管理する。
