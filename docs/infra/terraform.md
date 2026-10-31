# インフラ・運用

## 管理方針

AWSリソースはTerraformで管理する。ローカル開発環境の変更に伴うAWS構成の変更は行わない。配置先は `infra/terraform`、ディレクトリは[リポジトリ構成](../dev/repository.md)に従う。

## 現在の準備状況

2026-11-01：利用者指定により、参照元と同じ `kupacllc`・東京リージョン・既存Stateバケットを使用する。devは `repo-sentinel-dev.prj.kupac.co.jp` を使い、既存DNSゾーンにA/AAAA Aliasを作成する。指定済みのus-east-1ワイルドカードACM証明書を参照し、TLSポリシーは `TLSv1.2_2021` とする。`repo-sentinel.prj.kupac.co.jp` は将来の本番環境向けに予約する。

dev向けのBackend・Provider・6領域のmodule・監視定義を [infra/terraform](../../infra/terraform/README.md) に作成した。指定アカウント・証明書・DNSゾーン・専用Stateキーを読み取り確認し、利用者の承認後に共有StateバケットのVersioningだけをEnabledへ変更した。その後、利用者がinitを実行し、固定devドメイン構成でvalidate・モックテスト・Planを確認した。現行Planは26件追加・変更／削除0件。AWS上のアプリ用リソース作成は未実施。

初期値 `enable_runtime=false` でCognitoと開発基盤を準備し、未完成のAPI/Worker Lambdaをデプロイしない。CognitoのCallback／Logoutには初回からdev用HTTPS URLとlocalhostを登録し、生成URLの転記は行わない。Phase 4の有効化にはZIP・npm Layer・許可sub・AWS予算設定が必要。具体的な切替条件・確認結果は上記READMEを参照する。

## 管理対象

| 領域 | リソース |
|---|---|
| Frontend | S3 Bucket、CloudFront Distribution、S3 OAC |
| API | API Lambda、Function URL、Lambda用OAC、Function URL Resource Policy、API用IAM Role |
| Worker | Worker Lambda、Worker用IAM Role、SQS Event Source Mapping、CloudWatch Log Group |
| Database | DynamoDB Table |
| Queue | SQS Queue、DLQ、Redrive Policy |
| Authentication | Cognito User Pool、App Client、Domain、MFA設定 |
| Security | Secrets Manager Secret、IAM Policies、AWS Budgets |

CloudFrontは `/` をS3、`/api/*` をFunction URLへルーティングする。S3の公開アクセスを禁止し、両オリジンにOACを設定する。Function URLは `AWS_IAM` 認証とし、直接アクセスを拒否する。

APIキャッシュを無効化する。JWT専用ヘッダーとPOSTの `x-amz-content-sha256` を含むリクエスト転送を整える。詳細は[API仕様](../plan/implementation-plan.md#api)と[セキュリティ要件](../security.md)に従う。

SQS・Lambdaの初期数値と同時実行の整合は[Worker仕様](../plan/implementation-plan.md#worker)を正とする。

## 環境分離

dev/prodを論理的に分離する。

- Terraform State。
- Cognito User Pool。
- DynamoDB Table。
- SQS Queue。
- Lambda関数。
- OpenAI APIキー。

devは `repo-sentinel-dev.prj.kupac.co.jp`、prodは `repo-sentinel.prj.kupac.co.jp` を使用する。dev用Terraformは本番ドメインの入力を拒否する。URLを分けても認証・認可は引き続き必要。PoC初期はdevのみでもよい。prodはdevで一連の動作を確認してから作る。ローカル認証はdev User Poolを利用し、localhost Callback URLを登録する。

## Terraform State

S3 Backendを使用する。

- 今回は利用者の明示指示により、参照元と同じ既存State用S3 Bucketを使用する。新規bootstrapや既存バケットのimport・ポリシー変更は行わない。
- dev専用キーを `kupac/repo-sentinel/dev/terraform.tfstate` とし、参照元のキーを共有しない。
- S3 Versioningを有効にする。
- S3ネイティブロックを使用する。
- Stateの公開アクセスを禁止する。
- Stateアクセスを管理用IAMへ限定する。
- DynamoDBによるTerraform Stateロックは使わない。

TerraformはSecrets ManagerのSecretリソースを管理するが、OpenAI APIキー値をStateへ入れない。値の注入・更新手順は[未確定事項](../decisions.md)を解消して定義する。

Terraform・Providerバージョンとロック対応を確定し、検証・Planをホストで実行する。`apply` / `destroy` などの確認は[開発ワークフロー](../dev/workflow.md)に従う。

## ビルド・デプロイ

開発用DockerコンテナをそのままAWSへデプロイしない。

| 対象 | 成果物 |
|---|---|
| Frontend | Viteでビルドした静的ファイル |
| API | HonoのLambdaエントリーポイントを含むLambda向けパッケージ |
| Worker | SQSハンドラーと監査処理本体を含むLambda向けパッケージ |

本番向けビルドはクリーン環境で `npm ci` を行う。ホストの `node_modules` をコピー・流用せず、対象Lambdaランタイムに適合する依存関係・成果物を生成する。

具体的なビルドスクリプト、Lambdaへのnpm実行環境の同梱、デプロイ手段は[未確定事項](../decisions.md)で確定する。

## 監視・運用

CloudWatchの監視対象：

- API Lambdaのエラー。
- Worker Lambdaのエラーとタイムアウト。
- SQS滞留。
- DLQメッセージ数。
- ジョブの異常終了。
- OpenAI APIエラー。

AWS Budgetsを設定し、アプリケーションの利用制限と併用する。アラートだけに費用制限を依存させない。ログに秘密情報・認証情報・不要なリポジトリ内容を残さない。

障害時はジョブ状態、リース、SQS/DLQ、Workerログを照合する。AI呼び出し後の不確実な失敗は自動再実行を抑制する。DLQの再投入やリース切れジョブの復旧手順は未確定であり、単純な再投入を標準手順としない。

監視閾値、ログ保持期間、履歴保持・TTL、復旧手順は実装前に[未確定事項](../decisions.md)で確定する。
