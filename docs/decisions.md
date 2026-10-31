# 未確定事項・実装前の判断

本書は原文で未定義、例示のみ、または実装に追加の判断が必要な点を記録する。新しい確定要件を追加するものではない。決定したら担当文書へ反映し、本書にも決定内容・理由を残す。

## 今回の統合で確定した扱い

| 項目 | 統合方針 | 根拠 |
|---|---|---|
| Workerローカル実行 | ホストからCompose経由で処理本体を直接呼ぶ | 変更要件 §2・§5。基本仕様のホスト直接コマンドを置き換える |
| 依存管理 | ホストのルート `node_modules` をbind mountで共有 | 変更要件 §3・§4 |
| IDE | UbuntuホストのVS Code + Codex、単一ワークスペース | 変更要件 §1・§7 |
| リポジトリ構成 | 既存の `frontend/`、`api/`、`workers/security-audit/`、`packages/`、`infra/` と `docker-compose.yaml` を維持。各アプリの既存 `app/` をworkspaceルートとする | ユーザーの明示的な指示により現行構成を正とする。原文の `apps/*` 配置例より優先 |
| 本番ビルド | クリーン環境で `npm ci`、Lambda対応成果物 | 変更要件 §8 |
| AWS構成・セキュリティ | 明示的な変更以外は基本仕様を維持 | 変更要件 §8・§11・§12 |

## 開発環境・ビルド

| ID | 決めること | 担当文書・判断時点 |
|---|---|---|
| DEV-01 | Node.jsの具体的なLTS・パッチ、fnmと公式イメージの整合。例の `node:24-bookworm-slim` をそのまま確定値にしない | [ローカル開発](development/local-development.md)、Phase 1 |
| DEV-02 | workspaceの `dev` / `typecheck` / lint / test / build / `audit:local` スクリプトと環境設定。原文の名前以外は未定義 | [リポジトリ構成](development/repository.md)・[ローカル開発](development/local-development.md)、各機能実装前 |
| DEV-03 | DynamoDB Localのテーブル作成・初期化、インメモリ利用か永続化か | [ローカル開発](development/local-development.md)、Phase 1 |
| DEV-04 | Local Mock / Local Audit、AIモックの切り替え方法、Cognito・秘密情報の環境変数名と安全な注入 | [ローカル開発](development/local-development.md)、Phase 1–3 |
| DEV-05 | Lambda向けビルド・パッケージ方式、npm audit実行に必要なnpm・子プロセス環境、ネイティブ依存の適合 | [インフラ・運用](infrastructure/terraform.md)、AWSデプロイ前 |

## API・画面・保存契約

| ID | 決めること | 担当文書・判断時点 |
|---|---|---|
| API-01 | 履歴のクエリー、並び順、件数、ページング、レスポンス形式 | [API](specifications/api.md)、Phase 1 |
| API-02 | 状態ごとの応答型、`commitSha`、`findings` 公開範囲、AIの想定影響の配置。例示JSONは画面要件を網羅していない | [API](specifications/api.md)・[データ設計](specifications/data-model.md)、共有Zod定義前 |
| API-03 | エラーレスポンス、HTTPステータス、`errorCode` 一覧 | [API](specifications/api.md)、Phase 1以降 |
| API-04 | ジョブ保存とSQS送信の部分失敗の扱い、回数消費・補償方針 | [API](specifications/api.md)・[データ設計](specifications/data-model.md)、Phase 1・4 |
| API-05 | JWT専用ヘッダー名、採用するトークン種別・claim、POSTのSHA-256生成とCloudFront転送ポリシー | [API](specifications/api.md)・[セキュリティ](security.md)、Phase 3–4 |
| UI-01 | 各画面URL、ポーリング通信失敗時の再試行・停止条件 | [フロントエンド](specifications/frontend.md)、Phase 1 |
| DATA-01 | 日次回数のキー・属性、日付境界、失敗時の回数扱い、原子的な更新方式 | [データ設計](specifications/data-model.md)、実API接続前 |
| DATA-02 | 全体実行ロック、リース期間・更新・解放、期限切れ復旧、再試行可能な遷移、`attemptCount` 増加条件 | [データ設計](specifications/data-model.md)、Phase 2・4 |
| DATA-03 | SQSメッセージ形式、`ownerSub` の解決と検証、`audit:local <job-id>` からの所有者解決 | [Worker](specifications/worker.md)・[データ設計](specifications/data-model.md)、Phase 2・4 |
| DATA-04 | 履歴の保持期間、`expiresAt` とTTLを使うか、サイズ超過時の安全な失敗保存 | [データ設計](specifications/data-model.md)、保存処理実装前 |

## 監査・AI・費用・運用

| ID | 決めること | 担当文書・判断時点 |
|---|---|---|
| AUDIT-01 | ファイルサイズ・取得時間・npm時間・出力サイズ・AI入力・出力トークンの具体的上限と、全体180秒以内の配分 | [Worker](specifications/worker.md)・[AI](specifications/ai-report.md)・[セキュリティ](security.md)、実接続前 |
| AUDIT-02 | 対象ファイル欠損、非対応lockfile形式、GitHub API認証・制限、固定npm Registryの具体的設定 | [Worker](specifications/worker.md)、Phase 2 |
| AUDIT-03 | 正規化スキーマ、深刻度の全種類（例にない `info` 等）とサマリー整合 | [Worker](specifications/worker.md)・[データ設計](specifications/data-model.md)、Phase 2 |
| AI-01 | 固定モデル、プロンプト、JSON Schema、配列要素型、6つの必須内容の表現、事実整合性検証、拒否・不完全出力の扱い | [AI](specifications/ai-report.md)、Phase 2 |
| AI-02 | AI呼び出し前後の記録、成否不確実時の自動再実行抑制、許容する再試行条件 | [AI](specifications/ai-report.md)・[データ設計](specifications/data-model.md)、実AI接続前 |
| COST-01 | 原文が求めるOpenAI Projectの$10/月の強制支出制限が利用可能か、設定方法、強制停止手段と通知の違い。未検証の機能を利用可能と断定しない。利用できなければ要件の実現方法を明示的に判断する | [セキュリティ](security.md)、実AI接続前 |
| OPS-01 | `maxReceiveCount` を2か3に確定、失敗種別ごとのSQSメッセージ処理、Event Source Mapping並列度とReserved Concurrencyの整合 | [Worker](specifications/worker.md)、Phase 4 |
| OPS-02 | Terraform・Providerバージョン、S3ネイティブロック設定、Stateに秘密値を入れないSecret注入手順 | [インフラ・運用](infrastructure/terraform.md)、Phase 3–4 |
| OPS-03 | CloudWatch閾値、ログ保持、DLQ調査・再投入、異常ジョブ復旧手順 | [インフラ・運用](infrastructure/terraform.md)、Phase 4–5 |

原文の再構成に外部サービスの最新仕様の検証は含めていない。実装時にNode.js/Lambda対応、CloudFront OAC、Cognito、OpenAI支出制限、Terraformなどの提供状況を確認し、原文の要求との整合を判断する。
