# Phase 4：Lambda・SQS統合の実装

2026-11-01にAWS向けAPI・Workerと成果物作成を実装した。ここでいうruntimeは、このリポジトリがAPI/Worker LambdaとSQSの起動接続をまとめて呼ぶ設定名。独立したAWSサービスや費用監視機能ではない。ローカル・公式Lambdaコンテナでの検証に続き、利用者がdevへapplyし、Frontendも配布済み。公開HTTP経路とCognitoフォームへの遷移を確認した。本人のAIモック監査がAWS上で完了し、DynamoDBのCOMPLETED・試行1回・対象コミットと照合した。実Secret・実AI等は未検証。最新の結果は [AWS dev検証記録](phase4-verification.md) を参照する。Phase 4全体の完了とは扱わない。[反映手順](../dev/aws-deployment.md)を参照する。

## APIとメッセージ

- `api/app/src/lambda.ts` は実DynamoDB・SQSクライアントを実行ロールの資格情報で生成する。設定不正は503。ローカルDB・認証バイパス・モックdispatcherを起動しない。
- CognitoのJWT・許可sub認可は [認証仕様](cognito-auth.md) を継続する。認可後に期限切れジョブを確認し、履歴・詳細・新規作成へ進む。
- 日次5回・全体同時1件のDynamoDBトランザクションでPENDINGを保存してから、`{version:1, jobId, ownerSub}` をSQS Standardへ送る。メッセージに鍵・JWT・リポジトリ本文を含めない。
- SQS SDKの送信はmaxAttempts=1。応答不明でも無条件に再送しない。送信失敗時はPENDINGだけを条件付きでDISPATCH_FAILEDにして枠を解放する。先にWorkerがRUNNINGにしたジョブを補償処理で上書きしない。受理済みの日次回数は返却しない。
- `/api/health` は `execution=sqs` を返す。Frontendは自動実行を案内し、AWS画面へComposeの実行コマンドを表示しない。ローカルは `execution=local` を返す。

## Worker・再配信・リース

`workers/security-audit/app/src/sqs-handler.ts` がイベントを検証し、既存の `createAuditRunner` を呼ぶ。純粋な監査処理へSQSイベントを渡さない。

| 条件 | 処理 |
|---|---|
| 送信元Queue ARN不一致、不正JSON、512バイト超、余分な属性、許可外sub、不存在ジョブ、モード不一致 | 対象レコードだけbatchItemFailuresへ返す。ジョブを実行しない |
| PENDING・許可所有者・設定と同じmode/aiMode | 条件付きclaim後に処理する |
| RUNNINGの重複・ストレージ障害・終端を確認できない | 再実行せず対象レコードを再配信対象にする |
| COMPLETED/FAILED | acknowledgeし、再実行しない |
| 通常の監査・AI失敗をFAILEDへ保存できた | acknowledge。保存できなければ再配信対象 |

本番設定のbatch sizeは1、Event Source Mappingの最大並列度は2、Visibility Timeoutは1,080秒、maxReceiveCountは2。部分失敗応答を有効にする。DLQのメッセージは自動再投入しない。

PENDINGの待機リースは15分。claimはジョブのPENDING→RUNNINGと、同一所有者・ジョブの有効ロックを210秒へ更新する操作を一つのトランザクションにする。実処理は最大170秒、Lambdaは180秒で、実際のLambda残り時間からも10秒を引いて処理時間を制限する。機械結果・AI開始マーカーの更新時も、有効な同一ロックをトランザクションで確認する。

期限切れは、次の認可済みAPIリクエストまたはSQS配信でFAILEDへ確定する。AI開始マーカーがあればAI_OUTCOME_UNKNOWN、なければJOB_TIMEOUT。RUNNINGをPENDINGへ戻さず、AIを自動で再発行しない。ジョブ不在・終端なのにロックだけ残る不整合は503として管理者調査を要求する。定期掃除や自動redriveは実装しない。

## Secret・費用予約

初期AWS設定は実GitHub/npm監査＋AIモック。`ai_mode=openai` は `openai_hard_limit_confirmed=true` とWorker用Secretを必要とする。Secretはdev専用のraw API key文字列。WorkerだけがAWSCURRENTを読み、5分間メモリにキャッシュする。取得失敗・不正形式はAI_NOT_CONFIGURED。モック時はSecret値を読まない。

AI開始マーカーを保存し、DynamoDBで次を原子的に予約してから実AIを呼ぶ。

- 全ユーザー共通の日次呼び出し数：UTCで5回まで。
- 全ユーザー共通の月次予約額：1回50,000 micro USD、合計10,000,000 micro USDまで。
- `USER#{sub}/AI_RESERVATION#{jobId}`：同一ジョブで一度だけ。
- RUNNING・AI開始マーカーと、同一ジョブの有効な全体ロックも確認する。

予約額は実請求額の精算ではない。失敗・応答不明・保存失敗でも返却しない。予約の通信結果が不確実な場合も有料処理を止める。予約・カウンター・ジョブにTTLを設定せず、再起動や履歴削除で費用枠をリセットしない。ローカルのファイル台帳とAWS台帳は別であり、専用Projectの外部支出制限も維持する。

APIのDynamoDB権限は本人のUSERキーとSYSTEM、WorkerはこれらとAI_BUDGETに限定する。APIにSecret読取権限は与えない。SDKのLocal endpoint指定はAWS設定で拒否する。Secret値をTerraform・成果物・ログへ入れない。

## ビルドと運用

`scripts/build-aws.mjs` は一時環境で単一ロックからnpm ciを行い、SDKも含むCommonJSの `lambda.js` とpackage.jsonをZIPへまとめる。API・Worker ZIP、npm Layer、認証設定済みFrontend、SHA-256マニフェストを `.local/artifacts/dev` へ生成する。環境の入力設定は `infra/terraform/environments/dev/terraform.tfvars` に集約し、ビルドスクリプトは設定ファイルを生成・更新しない。`enable_runtime` の分岐は維持する。ホストのnode_modulesや.envをコピーしない。

npm Layerはnpm 12.2.1。npm同梱undici 6.29.0の既知問題に対し、同じロックで固定した6.29.1をLayer内へ差し替える。バージョンと差し替えはマニフェストに記録する。Workspaceのnpm auditは元のnpm同梱依存も評価するため、その警告がすべて解消する変更ではない。moderateの依存指摘を含む全体監査はPhase 5で扱う。実行側では固定Registry・ファイル上限・子プロセス60秒上限・秘密情報を渡さない環境・スクリプト実行禁止を継続する。

Lambdaは `/opt/nodejs/node_modules/npm/bin/npm-cli.js` をNodeで起動する。npmをLambdaの実行環境から暗黙に探さない。Secret設定・Frontend配布スクリプトは既定で読取プレビュー、`--write` / `--publish` でだけ変更する。Frontendはマニフェストのハッシュを照合し、assetsを先、index.htmlを最後に配布する。旧assetsは削除しない。

実アカウントのLambda同時実行上限は10、未予約枠も10だった。既定の予約枠2×2を割り当てるには未予約枠100以上を残すAWS制約に合わないため、確認用dev Planは `lambda_reserved_concurrency=-1` とする。関数専用枠の保証・上限はなく、他関数とアカウント枠を共有する。SQS並列上限2とDynamoDB同時監査1件・AI予算は維持する。十分なQuotaを確保した環境では既定値2を使える。Quota増枠申請は行っていない。

[公式料金](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/)に従い、AWS Budgetsの監視・直接メール通知は無料の任意設定で、Lambda有効化の必須条件ではない。`budget_monthly_usd` と `budget_email` を指定した時だけ作成する。CloudWatch運用通知用SNSは別の `alarm_email` で指定し、予算通知だけでは作成しない。今回のPlanは両方未設定。通知は強制停止ではなく、反映遅延もある。

ApiFailed・AuditFailed・AiFailed・WorkerRecordFailedの構造化ログを出し、CloudWatch Logsメトリクスとアラームで監視する。SQS部分失敗や通常の監査FAILEDはLambda Errorsだけでは拾えないため、専用メトリクスを使う。JWT・Secret・レコード本文・SDKの生例外をログへ出さない。

## 検証記録と限界

- 単体167件：AWS設定拒否、SQS契約・重複・部分失敗、Secret取得・キャッシュ・安全なCLI操作などが成功。
- ComposeのDynamoDB Local統合26件：署名済みJWT→SQS送信代替→Worker→履歴、並行claim、PENDING限定補償、予約の原子性・上限、期限切れ・AI成否不明の再実行抑制が成功。SQS通信と実AIは代替実装。
- 認証ブラウザーテスト3件成功、旧bypass監査E2Eは通常構成で1件skip。型チェック・ESLintが成功。
- Terraform validateとモックテスト10件が成功。実AWSの読み取りに基づく有効化Plan（27件追加・CloudFront 1件更新・削除0件）を保存。AWS Budgets・SNSは未設定。その後、利用者がapplyし、追加のPlanは差分なしだった。
- AWS Lambda公式Node.js 24イメージ `sha256:8466f17dcfbec19afcfefff53964fac7bc3f7975fa132d5fd74dce53004827d0`（Node v24.22.2）で、生成ZIPのロード、API 401、SQS部分失敗応答、npm Layerとundici差し替えを確認。固定した公開axios依存への実npm auditで検出JSONが返り、インストール・npmスクリプトが実行されないことも確認した。
- 準備時のCLIプレビューは `would_publish`・`runtimeReady=false`・`would_update`・`hadCurrentVersion=false`。apply後は `runtimeReady=true` を確認し、Frontendを公開した。Secret値は更新していない。
- 実OAC経由の未認証GET/POSTとFunction URL直接アクセス拒否、実SQS接続Enabledを確認した。認証後の実ジョブとWorkerの完了も確認した。実Secret・実AI・AWS予算制御・DLQ移動は [AWS dev検証記録](phase4-verification.md) で確認範囲を管理する。

根拠：[SQS部分失敗](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)、[LambdaのNode.js Layer](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-layers.html)、[DynamoDBトランザクション](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)、[Secretの取得](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets-javascript.html)、[予約同時実行数](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)。
