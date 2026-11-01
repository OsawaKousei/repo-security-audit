# セルフホスト手順

自分のAWSアカウントへ、[READMEの構成](README.md)を導入する手順です。まず実GitHub/npm監査＋AIモックで起動します。以下のコマンドは同じシェルで、リポジトリルートから実行します。

## 1. クローンと前提準備

Ubuntu、Git、fnm、Docker Compose、AWS CLI v2、Terraform 1.10以上2未満、`zip`・`unzip`を用意します。Node.jsは`.node-version`に合わせます。現時点の実装ブランチは`feat/initial-dev`です。

```bash
git clone --branch feat/initial-dev https://github.com/OsawaKousei/repo-security-audit.git
cd repo-security-audit
fnm use --install-if-missing
npm ci
cp .env.example .env
npm run setup:local
export AWS_PROFILE=repo-sentinel
aws sts get-caller-identity
tf() { terraform -chdir=infra/terraform/environments/dev "$@"; }
```

`repo-sentinel`は自分で認証を設定したAWS profile名に置き換えます。AWSリソースを作成する権限に加え、次を事前に用意してください。

- 自分が管理するドメインと、委任済みのRoute 53パブリックHosted Zone。
- 公開ホスト名をカバーする、検証済みの[us-east-1のACM証明書](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)。
- 自分専用の[S3 State保存先](https://developer.hashicorp.com/terraform/language/backend/s3)。バケットは先に作り、公開を禁止し、暗号化・バージョニングを有効にします。Stateオブジェクトと`.tflock`へのアクセス権も必要です。

## 2. 自分の環境へ合わせる

**現行コードは元の環境を固定検証しているため、tfvarsの変更だけでは移植できません。** `project_name=repo-sentinel`、`environment=dev`、`aws_region=ap-northeast-1`は維持し、次の許可値を自分のアカウント・ホスト名へ変更します。検証自体は残してください。

| ファイル | 変更する固定検証 |
|---|---|
| [variables.tf](infra/terraform/environments/dev/variables.tf) | `public_domain`の許可条件を、自分のホスト名（例：`repo-sentinel-dev.example.com`）へ変更 |
| [build-aws.mjs](scripts/build-aws.mjs) | `origin`の正規表現で同じHTTPSホストを許可 |
| [create-dev-user.ts](scripts/create-dev-user.ts) | `accountId`を自分の12桁のAWSアカウントIDへ変更 |
| [deploy-dev-frontend.mjs](scripts/deploy-dev-frontend.mjs) | Account、S3バケット名、originを自分の配布先へ変更 |
| [put-dev-openai-secret.mjs](scripts/put-dev-openai-secret.mjs) | 実AIを使う場合、AccountとSecret ARN内のアカウントIDを変更 |

対応する`tests/unit/`と`infra/terraform/environments/dev/tests/`の固定値・期待値も揃えます。`verify-aws-artifacts.mjs`の架空ユーザー等はコンテナ内検証用で、実環境の資格情報へ置き換える必要はありません。

```bash
cp infra/terraform/environments/dev/backend.hcl.example infra/terraform/environments/dev/backend.hcl
cp infra/terraform/environments/dev/terraform.tfvars.example infra/terraform/environments/dev/terraform.tfvars
```

コピー後に編集します。設定例にある元の環境の値を、そのまま使用しないでください。

| 設定ファイル | 自分の値にする項目 |
|---|---|
| `backend.hcl` | `bucket`、他環境と重ならない`key`、保存先の`region`、`profile` |
| `terraform.tfvars` | `aws_profile`、`aws_account_id`、`public_domain`、`acm_certificate_arn`、`route53_zone_id` |

初回は`enable_runtime=false`、`allowed_user_sub=null`、`ai_mode="mock"`、`openai_hard_limit_confirmed=false`とします。成果物パスは設定例のまま使います。予約同時実行数を確保できないアカウントでは`lambda_reserved_concurrency=-1`を使います。予算・運用メール通知は任意です。

## 3. 基盤と本人ユーザーを作成

```bash
npm run typecheck
npm run lint
npm test
tf init -backend-config=backend.hcl
tf validate
tf test
tf plan -out=foundation.tfplan
tf apply foundation.tfplan
node scripts/create-dev-user.ts --profile "$AWS_PROFILE" --email owner@example.com
node scripts/create-dev-user.ts --profile "$AWS_PROFILE" --email owner@example.com --create
```

各`apply`の前にPlanのアカウント・ドメイン・作成対象を確認します。メールアドレスは自分のものに置き換えます。ユーザー作成は既定でプレビュー、`--create`で招待メールを送信します。返された`sub`を`terraform.tfvars`の`allowed_user_sub`に設定します。新規登録は無効、パスワード＋TOTP MFAは必須です。

## 4. ビルドして公開

```bash
mkdir -p .local
tf output -json > .local/terraform-outputs.json
node scripts/build-aws.mjs --config .local/terraform-outputs.json
node scripts/verify-aws-artifacts.mjs
```

`terraform.tfvars`の`enable_runtime=true`へ変更してから、次を実行します。

```bash
tf plan -out=runtime.tfplan
tf apply runtime.tfplan
node scripts/deploy-dev-frontend.mjs --profile "$AWS_PROFILE"
node scripts/deploy-dev-frontend.mjs --profile "$AWS_PROFILE" --publish
tf output -raw frontend_url
```

配布は既定でプレビュー、`--publish`で実行します。表示されたURLでログインし、招待メールの仮パスワード（3日有効）を変更してTOTPを登録します。公開リポジトリを1件監査し、完了・対象SHA・履歴・AIモックの表示を確認します。未認証の`/api/health`が401、Function URLへの未署名の直接アクセスが拒否されることも確認してください。

## 5. 実AIを使う場合

専用OpenAI Projectの鍵と支出制限を用意します。実装は月額$10の強制停止を確認済みであることを要求します。その条件を満たせない場合はAIモックを使用してください。`.env`に`OPENAI_API_KEY`と`OPENAI_HARD_LIMIT_CONFIRMED=true`を設定します。このフラグは自己申告であり、外部サービスの上限設定を変更・検証するものではありません。

```bash
node scripts/put-dev-openai-secret.mjs --profile "$AWS_PROFILE"
node --env-file=.env scripts/put-dev-openai-secret.mjs --profile "$AWS_PROFILE" --write
```

`terraform.tfvars`を`ai_mode="openai"`、`openai_hard_limit_confirmed=true`へ変更し、`tf plan -out=ai.tfplan`、内容確認後に`tf apply ai.tfplan`を実行します。鍵はtfvars・State・Git・コマンド引数へ書かず、Workerだけに渡します。最初の実AI監査後に、結果・ログ・利用量を確認します。

## ローカル開発と更新

ローカル画面を使う場合は、`.env`のCognito設定を`tf output`の`cognito_issuer`・`cognito_client_id`・`cognito_login_url`で埋め、`ALLOWED_USER_SUB`を本人の`sub`にします。`AUTH_MODE=cognito`・`LOCAL_AUTH_BYPASS=false`を維持します。

```bash
docker compose up -d --wait
# http://localhost:5173 でログイン（既定は全体モック）
docker compose run --rm -e AUDIT_MODE=audit -e AI_MODE=mock worker \
  npm run audit:local -w workers/security-audit/app -- \
  --repository https://github.com/axios/axios
docker compose down
```

ローカルの実監査は上のCLIで実行します。DynamoDB Localの停止・再起動で履歴と回数が消える一方、実AIの`.local/ai-usage/`台帳は削除しないでください。

更新時は検証・ビルド・新しいPlanの確認・apply・Frontend配布を繰り返します。成果物や設定を変更した後に古い保存Planを再使用しません。障害時はCloudWatch LogsとSQS/DLQを確認し、開始済みジョブやAI開始マーカーを手動で戻して再実行しないでください。AWSを停止する場合は実行中ジョブを確認して`enable_runtime=false`のPlanを確認・適用します。基盤・保存データの料金は残ります。

`.env`、tfvars、backend設定、State、Plan、`.local/`はGit管理外です。これらを共有せず、バックアップと利用料金の確認を行ってください。
