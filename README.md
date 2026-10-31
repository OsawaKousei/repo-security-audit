# Repo Sentinel

公開GitHubリポジトリのnpm依存関係を監査する個人用PoCです。現在は **Phase 2：Workerのローカル実装** まで対応しています。実GitHubから固定SHAの依存定義を取得し、npm auditと実OpenAIレポート生成をComposeから直接実行できます。Cognito・SQS・AWS統合は後続Phaseです。

## ローカル起動

Ubuntu、Docker Compose、fnmを使用します。

```bash
fnm use --install-if-missing
npm ci
npm run setup:local
docker compose up -d --wait
```

<http://localhost:5173> を開き、`https://github.com/example/project` のようなURLから監査を開始してください。約4〜5秒でモック結果が保存され、画面が更新されます。URLの公開状態や実在性はこのPhaseでは確認しません。

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
npx playwright install chromium
npm run test:e2e
npm run build:clean
```

ブラウザーテストは起動済みComposeを使用し、ローカルユーザーの監査枠を1回消費します。統合テストは専用テーブルを自動作成・削除します。`build:clean` はソースとマニフェストだけを一時ディレクトリへコピーし、独立した `npm ci` とビルドを実行して削除します。Lambdaの実行環境検証は後続Phaseです。

停止は `docker compose down`。詳細は[ローカル開発](docs/dev/local-development.md)、実装契約は[Worker仕様](docs/spec/local-worker.md)と[Phase 1仕様](docs/spec/local-basic.md)、全体計画は[実装計画](docs/plan/implementation-plan.md)を参照してください。
