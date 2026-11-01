# Phase 4：AWS dev配布・検証記録

2026-11-01。利用者のTerraform apply完了と続行指示を受け、実AWSの配置確認、Frontend配布、HTTP・ブラウザー検証を行った。実装契約は [AWS runtime仕様](aws-runtime.md)、再現手順は [AWS配布](../dev/aws-deployment.md) を参照する。

## 環境と配布

| 項目 | 確認結果 |
|---|---|
| 対象 | `kupacllc` / `103492189525` / `ap-northeast-1` のdev |
| 公開URL | `https://repo-sentinel-dev.prj.kupac.co.jp` |
| Terraform | 利用者が27件追加・CloudFront 1件更新をapply。その後のPlanは差分なし |
| Lambda | API・WorkerともActive、LastUpdateStatus=Successful、Node.js 24 |
| コード | 配置済みAPI・WorkerのCodeSha256がクリーンビルドのZIPと一致 |
| npm Layer | `repo-sentinel-dev-npm:1` をWorkerへ配置 |
| 認証 | APIはCognito、許可subは本人用ユーザー |
| ネットワーク | 両LambdaのVpcIdはnull。VPC接続・NAT Gatewayは追加しない |
| SQS接続 | Enabled、batch 1、最大並列2、ReportBatchItemFailures |
| Queue | Visibility 1,080秒、maxReceiveCount 2、専用DLQ |
| AI | 実AWSは `AI_MODE=mock`。実OpenAI呼び出しは未実施。Secret値は利用者承認後に登録済み |
| Frontend | 検証済み5ファイルをdev専用S3へ配布。assetsを先、index.htmlを最後に更新 |
| CloudFront | Deployed、devドメインのみ。公開index.htmlのハッシュが成果物と一致 |

費用通知は未設定。Lambdaの予約枠は使わず、SQSの並列上限2とDynamoDBの同時監査1件制限を利用する。配布のためにIAM・Cognito・Secret値を追加変更していない。

## 公開経路の確認

| 検証 | 結果 |
|---|---|
| `/` と `/auth/callback` | HTTP 200、SPA shell、Cache-Control=no-cache |
| 指紋付きCSS・JS | HTTP 200、長期immutableキャッシュ |
| 未認証の `/api/health` | 401 UNAUTHORIZED、Cache-Control=no-store |
| 不正JWTでの `/api/health` | 401 UNAUTHORIZED |
| 未認証POST＋JSON本文SHA-256 | CloudFront/OAC経由でAPIへ到達し401 UNAUTHORIZED |
| 未署名のFunction URL直接アクセス | 403で拒否 |
| ブラウザーのログイン画面 | 配布済みReact・CSSの表示を確認 |
| 未知stateのCallback | 拒否され、code/queryをURLから消去 |
| 実Cognitoへの遷移 | dev HTTPS Callback、S256 PKCE、state、nonceを確認。Managed Loginのパスワード入力欄が表示された |

これらのAPI検証は未認証リクエストであり、正常な監査ジョブは作成していない。本人のパスワード・認証コード・実トークンは収集しない。

## 本人操作による監査

利用者から、公開URLでログインして `https://github.com/axios/axios` の監査が完了し、レポートが表示されたと回答を得た。依頼前に既存の読取処理でルートのpackage.json/package-lock.jsonを取得し、対応形式であることを確認した。確認時SHAは `9d11464a75ee5c644c0308d742f58755c0482594`。対象のインストール・npmスクリプト実行・AI呼び出しは行っていない。

実AWSの本人所有パーティションで次の保存結果を読み取り、利用者の回答と照合した。

| 項目 | 結果 |
|---|---|
| jobId | `01M6B0Z5WSW6GHXNVCN9276X16` |
| 状態 / 試行回数 | COMPLETED / 1 |
| 対象 / コミット | axios/axios / `9d11464a75ee5c644c0308d742f58755c0482594` |
| 件数 | critical 0、high 2、moderate 5、low 2、info 0 |
| AI | mock、aiAttemptedAtなし |
| 完了日時 | 2026-11-01 16:42:52 JST |

Cognito→CloudFront→認可済みAPI→DynamoDB/SQS→実Worker→GitHub/npm→結果保存→レポート表示を、AIモック構成で確認できた。上の件数はこのジョブの実行時点の結果であり、将来の結果を保証しない。

完了済みジョブへの同一通知を実SQSへ2件送り、追加のWorker REPORT 2件とQueueのvisible/in-flight各0を確認した。ジョブはCOMPLETED・試行1回・同じ完了日時のままで、AI開始マーカーも増えなかった。終端ジョブの重複通知を実Workerが消費し、監査を再実行しないことを確認した。新規ジョブ・日次枠・実AIは使用していない。

## 証跡と残る範囲

Git管理外の `.local/phase4/` に、HTTP結果 `aws-http-verification.json`、ブラウザー結果 `aws-browser-verification.json`、画面 `aws-login.png`、保存結果 `aws-audit-metadata.json`、重複検証 `aws-duplicate-verification.json`、apply後Plan `post-apply-plan.txt` を保存した。

実Secret取得、実AI、AWS上でのAI予算上限・成否不明時の制御、実DLQ移動は未検証。署名済みの許可外sub拒否は自動テストで確認しており、実Cognitoに2人目を作る試験は行っていない。Secret更新と実AI有効化は別の明示確認を伴う。Phase 4全体の完了はこれらの範囲と区別する。

## 次の実AI切替の準備

実AWSは引き続きAIモック。`terraform.tfvars` は次の希望状態として `ai_mode=openai`・`openai_hard_limit_confirmed=true` を設定し、API/Workerの環境設定だけを更新するPlanを `infra/terraform/environments/dev/openai.tfplan` に保存した。本文は `.local/phase4/openai-plan.txt`。追加0・更新2・削除0で、IAM・VPC・コード・Layer・タイムアウト等の変更がないことをPlan JSONでも確認した。

利用者から切替の承認と「applyはこちらで行うので、planの検証まで」の指示を受け、`.env` の鍵を既存のdev専用Secret `repo-sentinel-dev/openai-api-key` へ登録した。登録前は値未設定、登録後はSecret値を取得せず `AWSCURRENT` を確認した。鍵をログ・Terraformへ渡さず、Plan JSONにも実際の鍵が含まれないことを値を表示せず照合した。

validate・Terraformモックテスト10件が成功。検査結果は `.local/phase4/openai-plan-verification.json`。古い `.local/phase4/openai.tfplan` は削除し、dev配下の保存Planを正本とする。applyは利用者が実行するため未実施。実AWSのAPI/Workerが `AI_MODE=mock`・`OPENAI_HARD_LIMIT_CONFIRMED=false` のままであることも読み取り確認した。
