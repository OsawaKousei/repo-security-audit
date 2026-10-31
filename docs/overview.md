# プロジェクト概要

## 目的

Repo Sentinel（基本仕様書名：GitHub Security Audit PoC）は、公開GitHubリポジトリのnpm依存関係を機械的に監査し、OpenAI APIで人間が理解しやすいセキュリティレポートを生成するWebアプリケーションである。

監査からAIレポート生成までの一連の動作と、AWS上での安全な非同期処理を検証する。将来のSaaS化は想定するが、初期PoCは管理者が作成した1ユーザーによる個人利用に限定する。

## 初期PoCの範囲

- ユーザー操作で監査を開始する。
- 公開GitHubリポジトリのデフォルトブランチ最新コミットを対象とする。
- ルートの `package.json` と `package-lock.json` を取得する。
- `npm audit` で依存関係を監査し、結果を正規化する。
- AIは監査結果の分析とレポート生成のみを行う。
- APIとWorkerを分離し、AWSではSQSで非同期実行する。
- DynamoDBに状態・履歴・結果を保存し、画面からポーリングする。
- Cognito認証、利用ユーザー制限、実行回数・費用制限を実装する。
- アプリケーションロジックをローカルとAWSで共通化する。
- AWSインフラはTerraformで管理する。

## 初期PoCで実装しないもの

- npm以外のエコシステム、複数種類の機械監査。
- GitHub App・GitHub OAuth・プライベートリポジトリへのアクセス。
- モノレポ内の個別ワークスペース指定。
- 外部リポジトリの任意コード実行。
- AIによる監査ロジックの動的生成、インターネット検索、追加ツール利用、コード修正。
- 定期実行、Slack・メール通知、その他の外部連携。
- 複数ユーザー管理、課金・契約管理、SBOM生成・保存。

## 採用技術

| 分野 | 技術 |
|---|---|
| 言語・共通契約 | TypeScript、Zod |
| モノレポ・依存管理 | npm workspaces、単一 `package-lock.json` |
| フロントエンド | React + Vite、CSR |
| API | Hono |
| Node.js | AWS Lambda対応LTS。ホストと開発コンテナで同一バージョン |
| 静的配信 | CloudFront + S3 |
| API公開・実行 | Lambda Function URL + CloudFront OAC、Lambda |
| 非同期処理 | SQS Standard、Worker Lambda |
| データベース | DynamoDB、ローカルはDynamoDB Local |
| 認証 | Cognito User Pool、パスワード + TOTP MFA |
| 監査 | npm audit |
| AI | OpenAI Responses API、Structured Outputs |
| 秘密情報 | Secrets Manager |
| ログ・監視 | CloudWatch、AWS Budgets |
| IaC | Terraform |
| 開発環境 | UbuntuホストのVS Code + Codex、Docker Compose |

アプリケーションロジックはTypeScriptで統一し、Python、Go、ECS、Step Functionsは導入しない。Node.jsの確定バージョンは[未確定事項](decisions.md)で扱う。

## 設計原則

1. 小さく実装し、PoCに不要な抽象化やサービスを導入しない。
2. ビジネスロジックをLambda・SQS・Dockerの実行環境から分離する。
3. 外部リポジトリはデータとして読み、信頼できないコードを実行しない。
4. 認証・IAM最小権限・秘密情報管理・費用制限を初期から設計する。段階導入時の例外は[開発ワークフロー](dev/workflow.md)に限定する。
5. npm workspacesと単一ロックファイルで依存関係を一元管理する。
6. ホストの単一ワークスペースから編集・検証・実行操作を行う。
7. インフラを宣言的に管理し、手動設定への依存を最小化する。
8. ローカルではアプリロジック、AWS devではAWS固有の連携を検証する。

## 将来の検討候補

GitHub App連携、npm以外への対応、複数の機械監査、AIによる監査プロファイル生成・セキュリティニュース調査、EventBridge定期実行、監査結果の差分検出、Slack・メール通知、マルチテナント、Stripe月額課金、監査結果のS3保存、コード・CI/CD・IaCの横断監査を候補とする。いずれも現段階では実装しない。
