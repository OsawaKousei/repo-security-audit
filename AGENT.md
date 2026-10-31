# Repo Sentinel 開発ガイド

公開GitHubリポジトリのnpm依存関係を監査し、AIレポートを作成する個人用PoC。TypeScript・npm workspacesを使用する。

## 仕様の参照

- 最初に[ドキュメント一覧](docs/README.md)と[実装計画](docs/plan/implementation-plan.md)を読む。
- 作業対象に応じて[構成](docs/architecture.md)、[開発環境](docs/dev/local-development.md)、[API](docs/plan/implementation-plan.md#api)、[Worker](docs/plan/implementation-plan.md#worker)を参照する。
- 認証・外部入力・費用に関わる変更では[セキュリティ要件](docs/security.md)を読む。
- 未実装の要件は `docs/plan/implementation-plan.md`、実装・検証済みの確定仕様は `docs/spec/` に記載する。計画を実装済みとして扱わない。
- ユーザーの明示的な変更指示を優先し、[未確定事項](docs/decisions.md)の決定時は計画と関係するガイドを更新する。実装・検証後は確定仕様も記録する。

## 実装の原則

- 小さく実装し、PoCの[対象範囲](docs/overview.md)を守る。
- Lambda/SQSの入出力とビジネスロジックを分離する。
- 共通の型・Zodスキーマは `packages/core`、AWS SDK実装は `packages/aws` に置く。
- 外部リポジトリはデータとして扱う。対象の依存関係インストール、npmスクリプト、任意コード実行は禁止する。
- AIは監査結果の説明に限定する。機械監査の事実とAIの推論を区別する。
- 秘密情報や認証トークンをコード・ログ・Terraform Stateに残さない。

## 作業と検証

- Ubuntuホストの単一ワークスペースで編集・依存関係管理・型チェック・テストを行う。
- アプリの実行はDocker Composeを使う。Workerもホストから `docker compose run` で実行する。
- ホストのルート `node_modules` をbind mountで共有し、Node.jsは `.node-version` とコンテナで統一する。
- 依存関係はnpm workspacesとルートの単一 `package-lock.json` で管理する。
- 現行のディレクトリ構成を正とする。各アプリの既存 `app/` をworkspaceルートにし、`docker-compose.yaml` を維持する。
- 実装前に[リポジトリ構成](docs/dev/repository.md)を確認する。文書内のコマンドは実装後の目標であり、利用可能か確認してから実行する。
- 変更に応じて[検証項目](docs/testing.md)を選び、実行結果と未検証事項を報告する。
- Terraformの検証・Planはホストで行う。`apply` / `destroy`、本番デプロイ、IAM権限変更、Secrets Manager更新、本番データ削除は、該当操作への明示的な確認を伴う。
- 本番成果物はクリーン環境の `npm ci` で作成し、ホストの `node_modules` を流用しない。
