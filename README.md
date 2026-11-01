# Repo Sentinel

公開GitHubリポジトリのnpm依存関係を監査する個人用PoCです。Phase 2の実監査・AIに加え、**Phase 3のReact・HonoのCognito認証**を実装しています。ローカル画面からdev User Poolへログインし、本人のsubで監査・履歴を扱います。SQS・LambdaのAWS統合は後続作業です。

## ローカル起動

Ubuntu、Docker Compose、fnmを使用します。

```bash
fnm use --install-if-missing
npm ci
npm run setup:local
# 既存の.envを保持し、下記のCognito設定と許可subを設定する
docker compose up -d --wait
```

起動前に `.env.example` を参考に、既存の `.env` へ `COGNITO_ISSUER`・`COGNITO_CLIENT_ID`・`COGNITO_LOGIN_URL`・`ALLOWED_USER_SUB` を設定します。Cognitoの識別子はdev Terraformの出力、subは初期ユーザー作成スクリプトの出力を使います。通常は `AUTH_MODE=cognito`・`LOCAL_AUTH_BYPASS=false`。既存のAPIキーは上書きしません。

<http://localhost:5173> の「ログイン」からManaged Loginへ進みます。初回は招待メールの仮パスワードを変更し、認証アプリのTOTP登録を完了します。ログイン後、`https://github.com/example/project` のようなURLから監査を開始してください。約4〜5秒でモック結果が保存され、画面が更新されます。URLの公開状態や実在性はこのPhaseでは確認しません。

`setup:local` は `.node-version` とホストUID/GIDをGit管理外の `.env` に反映します。公開ポートはloopback限定です。DynamoDB Localはインメモリのため、停止・再起動で履歴と回数カウンターが消えます。

## 実監査を直接実行

`.env` に `OPENAI_API_KEY` を設定し、専用OpenAI Projectの月額$10 Hard spend limitを有効にした後、`OPENAI_HARD_LIMIT_CONFIRMED=true` を設定します。鍵はWorkerだけへ渡します。

まずAIモックで確認します。

```bash
docker compose run --rm -e AUDIT_MODE=audit -e AI_MODE=mock worker \
  npm run audit:local -w workers/security-audit/app -- \
  --repository https://github.com/axios/axios
```

実AIで実行する場合は `-e AI_MODE=openai` に変更します。結果はCLIと画面の監査履歴から確認できます。lockfileVersion 2/3のルートnpmプロジェクトに対応し、workspaces・git/file/URL依存は未対応です。

日次5回・同時1件に加え、実AIは `.local/ai-usage/` に永続的な予算予約を保存します。この台帳は削除しないでください。詳しくは[ローカル開発](docs/dev/local-development.md)を参照してください。

## 検証

```bash
npm run typecheck
npm run lint
npm test
docker compose run --rm worker npm run test:integration
PLAYWRIGHT_BROWSERS_PATH=.playwright npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=.playwright npm run test:e2e
npm run build:clean
```

通常のブラウザーテストは起動済みCognito構成のComposeを使い、OIDC・API応答をモックして認証UIを検証します。実アカウントのパスワード・MFAやOpenAIを操作しません。従来のモック監査E2Eは明示的なローカルテスト認証設定だけで実行します。統合テストは専用テーブルを自動作成・削除します。`build:clean` はソースとマニフェストだけを一時ディレクトリへコピーし、独立した `npm ci` とビルドを実行して削除します。Lambdaの実行環境検証は後続Phaseです。

停止は `docker compose down`。詳細は[ローカル開発](docs/dev/local-development.md)、実装契約は[Cognito認証](docs/spec/cognito-auth.md)・[Worker仕様](docs/spec/local-worker.md)・[Phase 1仕様](docs/spec/local-basic.md)、全体計画は[実装計画](docs/plan/implementation-plan.md)を参照してください。
