# Repo Sentinel

公開GitHubリポジトリのnpm依存関係を監査する個人用PoCです。現在は **Phase 1：ローカルの基本実装** に対応し、監査開始からモックレポート表示まで動作します。GitHub・npm Registry・OpenAIへの実接続とCognito認証は後続Phaseです。

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

停止は `docker compose down`。詳細は[ローカル開発](docs/dev/local-development.md)、実装契約は[Phase 1仕様](docs/spec/local-basic.md)、全体計画は[実装計画](docs/plan/implementation-plan.md)を参照してください。
