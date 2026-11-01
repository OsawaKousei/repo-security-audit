# devへのAWS配布

Lambda・SQSの実装契約と検証限界は [AWS runtime仕様](../spec/aws-runtime.md) を参照する。以下はリポジトリルートで実行する。`fnm use` でNode.js 24.22.2、AWS profileはkupacllc、リージョンはap-northeast-1。実リソースを変更する操作は [AGENT.md](../../AGENT.md) と[開発ワークフロー](workflow.md#codexの操作と権限)の明示確認を伴う。

## 成果物の作成と検証

```bash
mkdir -p .local/phase4
terraform -chdir=infra/terraform/environments/dev output -json > .local/phase4/terraform-outputs.json
node scripts/build-aws.mjs --config .local/phase4/terraform-outputs.json
node scripts/verify-aws-artifacts.mjs
# Registry接続を伴うnpm auditの検証も行う場合（依存インストール・実AIなし）
node scripts/verify-aws-artifacts.mjs --audit
```

`zip`・`unzip`・Dockerが必要。verifyはLambda公式イメージを使い、通常はネットワークなし。再現する場合は `--image public.ecr.aws/lambda/nodejs@sha256:8466f17dcfbec19afcfefff53964fac7bc3f7975fa132d5fd74dce53004827d0` を指定する。ビルド出力先は既定で `.local/artifacts/dev`。再ビルド後はZIPのハッシュが変わり得るため、古い保存Planを使わず再planする。

環境ごとの入力設定は `infra/terraform/environments/dev/terraform.tfvars` に集約する。Terraformが自動で読み込むため、追加の `-var-file` は使わない。ビルドスクリプトは成果物だけを生成し、設定を更新しない。独自の `--out` を使う場合は、このファイルの3つの成果物パスも合わせて更新する。

新規環境では同じディレクトリの `terraform.tfvars.example` を `terraform.tfvars` へコピーする。初期基盤は `enable_runtime=false`、成果物と本人subを準備後に同じファイルで `true` にする。Lambda ZIP・npm Layerのパス、許可sub、AIモード、同時実行数、任意の通知もこのファイルで管理する。State接続は `backend.hcl`、API鍵はSecrets Managerで別管理とし、秘密値をtfvarsへ入れない。

現在のアカウントQuotaは10で予約枠2×2を使えないため、devでは `lambda_reserved_concurrency=-1` を指定する。Quota確認は `aws lambda get-account-settings --profile kupacllc --region ap-northeast-1`。既定値2を使う場合は、他関数の予約分とAWSが要求する未予約100を満たすQuotaを事前に確保する。

## 今回の確認用Plan

現在の `terraform.tfvars` は、有効化用の追加2ファイルにあった設定値を統合済み。`enable_runtime=true`、AIモック、予約枠なしで、AWS Budgets・SNS通知は未設定。従来のdev.tfplanはPhase 3基盤用なので、この配布には使用しない。

```bash
terraform -chdir=infra/terraform/environments/dev validate
terraform -chdir=infra/terraform/environments/dev test
terraform -chdir=infra/terraform/environments/dev plan \
  -out="$PWD/.local/phase4/runtime.tfplan"
```

Plan本文は `.local/phase4/runtime-plan.txt`。確認用PlanはLambda・実行ロール・SQS起動接続・npm Layer・OAC・監視を追加し、CloudFrontのAPI経路を更新する。27件追加・1件更新・削除0件を確認済み。State基盤や本番ドメインを変更しない。

**明示確認後**に実行する：

```bash
terraform -chdir=infra/terraform/environments/dev apply "$PWD/.local/phase4/runtime.tfplan"
node scripts/deploy-dev-frontend.mjs
node scripts/deploy-dev-frontend.mjs --publish
```

無料のAWS Budgets直接メールは `budget_monthly_usd` と `budget_email`、CloudWatchの運用通知用SNSは別の `alarm_email` で任意に設定する。予算通知だけではSNSを作成しない。SNSを別途設定した場合は、送られる確認メールから購読を確認する。Frontendスクリプトは既定でプレビュー。実際の配布には `--publish` が必要で、runtime有効化済み・dev専用のアカウント/バケット/オリジン・ファイルハッシュを確認する。assetsを先に、index.htmlを最後に配布し、旧assetsは削除しない。SPA shellはCloudFrontでキャッシュ無効、指紋付きassetsは長期キャッシュ。

以後のPlanも `terraform.tfvars` を自動で読み込む。ビルドや設定を変更した場合はPlanを作り直し、その保存Planをレビューしてからapplyする。

## AIモックでAWS疎通

1. `https://repo-sentinel-dev.prj.kupac.co.jp` に本人アカウントでログインする。
2. 実監査を作成し、PENDING→RUNNING→COMPLETED、機械監査とAIモックの表示、履歴・詳細を確認する。DynamoDBの日次5回枠を消費する。
3. 未認証APIの401、許可外subの403、Function URLへの未署名の直接アクセス拒否、CloudFront経由のGET/POSTを確認する。
4. API/Workerのログ、SQS/DLQ、アラームを確認する。Poison message・DLQ移動などの障害試験は専用テストジョブで行い、実運用ジョブを手動でRUNNINGへ戻さない。

## 実AIを有効にする場合

dev専用Projectの鍵と月額$10強制停止を確認する。まず鍵を読まないプレビュー：

```bash
node scripts/put-dev-openai-secret.mjs
```

**Secret更新の明示確認後**、既存 `.env` をNodeが読み込む方法で値を注入する。鍵をコマンド引数へ書かない。

```bash
node --env-file=.env scripts/put-dev-openai-secret.mjs --write
```

`OPENAI_API_KEY` と `OPENAI_HARD_LIMIT_CONFIRMED=true` が必要。スクリプトはアカウント・dev Secret ARN/名前を検証し、権限600の一時ファイルをAWS CLIへ渡して削除する。既定では書き込まず、既存Secretも `--write` で明示した時だけ更新する。スクリプトはProjectの実設定を検証するものではない。

`terraform.tfvars` の `ai_mode` を `openai`、`openai_hard_limit_confirmed` を `true` へ更新し、API/Workerを同じモードへ更新する。別Planとしてレビュー・applyしてから1件の実AI監査を確認する。鍵の値をtfvarsやStateに入れない。実AIを有効にしてもDynamoDBの予約・開始マーカーを削除しない。

## 障害・ロールバック

Lambdaの実行状態・DynamoDBのjobId/状態/リース/AI開始マーカー・Queue/DLQを照合する。RUNNINGやAI開始済みを再実行しない。期限切れは次のAPIアクセスまたはSQS配信で失敗確定する。不整合やDLQは原因を調査してから個別に処理する。

停止するときはruntimeを無効化するPlanをレビューする。PENDINGを残したまま無効化すると消費が止まるため、先に状態を確認する。Frontendだけ戻す場合も、旧マニフェストとそのファイルを揃えて配布する。予算台帳やDynamoDBテーブルを削除して復旧しない。
