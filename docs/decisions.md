# 未確定事項・実装前の判断

本書は[実装計画](plan/implementation-plan.md)と[分野別の担当文書](README.md)で未定義、例示のみ、または実装に追加の判断が必要な点を記録する。実装済みの確定仕様を示すものではない。未確定事項の詳細は本書に集約し、決定したら担当文書へ反映して本書にも決定内容・理由を残す。実装・検証後は `docs/spec/` に確定仕様を記載する。

## 今回の統合で確定した扱い

| 項目 | 統合方針 | 根拠 |
|---|---|---|
| Workerローカル実行 | ホストからCompose経由で処理本体を直接呼ぶ | 変更要件 §2・§5。基本仕様のホスト直接コマンドを置き換える |
| 依存管理 | ホストのルート `node_modules` をbind mountで共有 | 変更要件 §3・§4 |
| IDE | UbuntuホストのVS Code + Codex、単一ワークスペース | 変更要件 §1・§7 |
| リポジトリ構成 | 既存の `frontend/`、`api/`、`workers/security-audit/`、`packages/`、`infra/` と `docker-compose.yaml` を維持。各アプリの既存 `app/` をworkspaceルートとする | ユーザーの明示的な指示により現行構成を正とする。原文の `apps/*` 配置例より優先 |
| 本番ビルド | クリーン環境で `npm ci`、Lambda対応成果物 | 変更要件 §8 |
| AWS構成・セキュリティ | 明示的な変更以外は基本仕様を維持 | 変更要件 §8・§11・§12 |

## Phase 1で確定した範囲（2026-11-01）

以下は実装・検証済みの判断。詳細契約は[ローカル基本仕様](spec/local-basic.md)、設定・手順は[ローカル開発](dev/local-development.md)に一本化する。後続表の同一IDは、ここに示す残課題だけを未確定として扱う。

| ID | 決定した範囲 | 残る判断 |
|---|---|---|
| DEV-01 | Node.js 24.22.2、ホストと公式bookworm-slimイメージを一致 | AWSランタイムでの実動作はデプロイ前 |
| DEV-02 | 3アプリ・2共通パッケージ、ルート開発ツール、単一ロック、検証・ビルド・CLIスクリプト | 実監査・AWSパッケージ追加時に拡張 |
| DEV-03 | SDKで起動時作成、DynamoDB Local 3.3.2をdigest固定、インメモリ | AWSテーブル・保持設定 |
| DEV-04 | 明示的local/mock設定、固定ローカル所有者、成功・失敗モック | Local Audit・Cognito・秘密情報設定はPhase 2–3 |
| API-01 | ULID降順、既定20/最大50、cursorと応答エンベロープ | なし（機能拡張時に再検討） |
| API-02 | 状態別Zod型、公開結果・保存メタデータ分離、info、impactsを含むレポート | 実npm正規化・AI照合はPhase 2 |
| API-03 | LocalのHTTPステータス、エラーエンベロープ・コード | 認証・SQS固有コードはPhase 3–4 |
| API-04 | Localは保存されたスロットで通知、通知失敗時はFAILED、保存後の回数は戻さない | 実SQSの部分失敗・補償はPhase 4 |
| UI-01 | hashによる3画面、2.5秒間隔、3回通信失敗で停止・手動再取得 | なし（機能拡張時に再検討） |
| DATA-01 | UTC日次5回、ジョブ・カウンター・全体スロットを単一トランザクション | 実AI接続時にも上限を再検証 |
| DATA-02 | Localの180秒リース、claimで試行回数増加、条件付き完了・解放、期限切れ失敗 | 実監査での延長・AI不確実性・SQS再試行 |
| DATA-03 | Local CLIは固定所有者、APIと同じ処理本体 | 実SQSメッセージ・所有者検証はPhase 4 |
| DATA-04 | LocalはTTLなし・メモリ寿命、350KiBで結果拒否し小さい失敗記録 | AWS保持期限・TTLはデプロイ前 |

## Phase 2で確定した範囲（2026-11-01）

この表は同一IDのPhase 1残課題を更新する。詳細は[Worker確定仕様](spec/local-worker.md)、実行方法は[ローカル開発](dev/local-development.md)、根拠は[Phase 2検証記録](spec/phase2-verification.md)を参照する。

| ID | 決定した範囲 | 残る判断 |
|---|---|---|
| DEV-04 | AUDIT_MODEとAI_MODEを分離、CLIで作成・実行、鍵はWorkerだけに注入 | Cognito設定はPhase 3 |
| API-02 / AUDIT-03 | 正規化は脆弱性を持つパッケージ単位、間接advisory解決、infoを含む件数照合、npm修正対象名を保持 | 機能拡張時に再検討 |
| DATA-02 | Localの固定180秒リースに対し全体170秒以内、期限切れ失敗。AI前の条件付き記録と自動再試行禁止 | AWS分散実行・SQSの再配信はPhase 4 |
| DATA-03 | CLIは固定所有者で保存されたmode/aiModeと一致検証。URLによる作成・直接実行を追加 | SQSの所有者解決はPhase 4 |
| DATA-04 | 機械結果をAI前に保存、AI失敗時も根拠を保持。250KiB/350KiBの保存上限 | AWS TTL・保持期間 |
| AUDIT-01 | GitHub/npm/AIと全体の時間・サイズ・出力上限を固定 | Lambdaランタイムでの再検証 |
| AUDIT-02 | GitHubの公開meta・commit/tree/blobでSHA固定、lock 2/3、workspace/git/file/URL依存拒否、npm Registry固定 | 追加のlock形式対応は範囲外 |
| AI-01 | gpt-5.6-luna、固定プロンプト、厳格Structured OutputsとZod、根拠index照合、数値等の自由生成を抑制 | 自然言語全体の意味は機械的に保証しない |
| AI-02 | 呼び出し前の保存・永続予約、同一ジョブ再予約禁止。timeout/不正出力/成否不明でも自動再試行しない | AWS用の共有予算管理・実行復旧はPhase 4 |
| COST-01 | 公式のProject Hard spend limit手順を確認。利用者が専用Projectの月額$10強制停止設定済みと回答。アプリにも永続日次・月次制限 | 管理画面・管理APIでの設定値や実上限到達は独立検証していない。環境追加時に確認 |

## Terraform準備で確認した扱い（2026-11-01）

利用者指定でAWS profileは `kupacllc`、リージョンは `ap-northeast-1`、Stateは参照元と同じ既存バケットとする。devの公開URLは `repo-sentinel-dev.prj.kupac.co.jp`、本番用は `repo-sentinel.prj.kupac.co.jp`。指定済みus-east-1のワイルドカード証明書を利用し、bootstrap・証明書再発行は行わない。dev用Terraformは本番ドメインを拒否する。固定URLを初回からCognitoへ登録し、手動のURL転記やSSM追加は不要とする。

OPS-02の初期選択はTerraform `>= 1.10.0, < 2.0.0`、AWS Provider 6.69.1、S3 native lock。Stateキーをアプリ・環境専用に分ける。共有StateのVersioningは利用者承認後に有効化し、15分待機後も既存Stateが不変であることを確認した。利用者のinit後、固定devドメイン構成でvalidate・初回Plan（26件追加）を確認した。その後、利用者のapplyで21件作成・Origin Request Policyエラーを確認し、AWS管理のAllViewerExceptHostHeader参照へ修正した。再apply用Planは4件追加・変更／削除0件、モック6ケースが成功。再applyは未実施。本人ユーザーは読取既定・明示作成のCLIスクリプトで準備し、既存ユーザーのパスワード・MFA・招待は変更しない。具体的な設定と実施記録は [Terraform README](../infra/terraform/README.md) に一本化する。

DEV-05の初期構成はNode.js 24 x86_64のZIPとnpm Layerの組合せ。現在のローカルWorkerをAWSへ直接デプロイせず、AWS認証・SQS・分散費用管理・npm Layer対応を完了するまで `enable_runtime=false` とする。OPS-01の初期redriveはmaxReceiveCount 2、batch 1、Worker/ESM並列度2。アプリの同時監査上限1は別のDynamoDBロックで守る。OPS-03はログ14日、Queue/DLQ/Lambdaの基本アラームを定義し、アプリ固有の失敗指標はPhase 4で追加する。AWS予算の金額・メールは初回運用前に設定し、Projectタグのコスト配分有効化を確認する。

## 開発環境・ビルド

| ID | 決めること | 担当文書・判断時点 |
|---|---|---|
| DEV-01 | Node.jsの具体的なLTS・パッチ、fnmと公式イメージの整合。例の `node:24-bookworm-slim` をそのまま確定値にしない | [ローカル開発](dev/local-development.md)、Phase 1 |
| DEV-02 | workspaceの `dev` / `typecheck` / lint / test / build / `audit:local` スクリプトと環境設定。原文の名前以外は未定義 | [リポジトリ構成](dev/repository.md)・[ローカル開発](dev/local-development.md)、各機能実装前 |
| DEV-03 | DynamoDB Localのテーブル作成・初期化、インメモリ利用か永続化か | [ローカル開発](dev/local-development.md)、Phase 1 |
| DEV-04 | Local Mock / Local Audit、AIモックの切り替え方法、Cognito・秘密情報の環境変数名と安全な注入 | [ローカル開発](dev/local-development.md)、Phase 1–3 |
| DEV-05 | Lambda向けビルド・パッケージ方式、npm audit実行に必要なnpm・子プロセス環境、ネイティブ依存の適合 | [インフラ・運用](infra/terraform.md)、AWSデプロイ前 |

## API・画面・保存契約

| ID | 決めること | 担当文書・判断時点 |
|---|---|---|
| API-01 | 履歴のクエリー、並び順、件数、ページング、レスポンス形式 | [API](plan/implementation-plan.md#api)、Phase 1 |
| API-02 | 状態ごとの応答型、`commitSha`、`findings` 公開範囲、AIの想定影響の配置。例示JSONは画面要件を網羅していない | [API](plan/implementation-plan.md#api)・[データ設計](plan/implementation-plan.md#data-model)、共有Zod定義前 |
| API-03 | エラーレスポンス、HTTPステータス、`errorCode` 一覧 | [API](plan/implementation-plan.md#api)、Phase 1以降 |
| API-04 | ジョブ保存とSQS送信の部分失敗の扱い、回数消費・補償方針 | [API](plan/implementation-plan.md#api)・[データ設計](plan/implementation-plan.md#data-model)、Phase 1・4 |
| API-05 | JWT専用ヘッダー名、採用するトークン種別・claim、POSTのSHA-256生成とCloudFront転送ポリシー | [API](plan/implementation-plan.md#api)・[セキュリティ](security.md)、Phase 3–4 |
| UI-01 | 各画面URL、ポーリング通信失敗時の再試行・停止条件 | [フロントエンド](plan/implementation-plan.md#frontend)、Phase 1 |
| DATA-01 | 日次回数のキー・属性、日付境界、失敗時の回数扱い、原子的な更新方式 | [データ設計](plan/implementation-plan.md#data-model)、実API接続前 |
| DATA-02 | 全体実行ロック、リース期間・更新・解放、期限切れ復旧、再試行可能な遷移、`attemptCount` 増加条件 | [データ設計](plan/implementation-plan.md#data-model)、Phase 2・4 |
| DATA-03 | SQSメッセージ形式、`ownerSub` の解決と検証、`audit:local <job-id>` からの所有者解決 | [Worker](plan/implementation-plan.md#worker)・[データ設計](plan/implementation-plan.md#data-model)、Phase 2・4 |
| DATA-04 | 履歴の保持期間、`expiresAt` とTTLを使うか、サイズ超過時の安全な失敗保存 | [データ設計](plan/implementation-plan.md#data-model)、保存処理実装前 |

## 監査・AI・費用・運用

| ID | 決めること | 担当文書・判断時点 |
|---|---|---|
| AUDIT-01 | ファイルサイズ・取得時間・npm時間・出力サイズ・AI入力・出力トークンの具体的上限と、全体180秒以内の配分 | [Worker](plan/implementation-plan.md#worker)・[AI](plan/implementation-plan.md#ai-report)・[セキュリティ](security.md)、実接続前 |
| AUDIT-02 | 対象ファイル欠損、非対応lockfile形式、GitHub API認証・制限、固定npm Registryの具体的設定 | [Worker](plan/implementation-plan.md#worker)、Phase 2 |
| AUDIT-03 | 正規化スキーマ、深刻度の全種類（例にない `info` 等）とサマリー整合 | [Worker](plan/implementation-plan.md#worker)・[データ設計](plan/implementation-plan.md#data-model)、Phase 2 |
| AI-01 | 固定モデル、プロンプト、JSON Schema、配列要素型、6つの必須内容の表現、事実整合性検証、拒否・不完全出力の扱い | [AI](plan/implementation-plan.md#ai-report)、Phase 2 |
| AI-02 | AI呼び出し前後の記録、成否不確実時の自動再実行抑制、許容する再試行条件 | [AI](plan/implementation-plan.md#ai-report)・[データ設計](plan/implementation-plan.md#data-model)、実AI接続前 |
| COST-01 | 原文が求めるOpenAI Projectの$10/月の強制支出制限が利用可能か、設定方法、強制停止手段と通知の違い。未検証の機能を利用可能と断定しない。利用できなければ要件の実現方法を明示的に判断する | [セキュリティ](security.md)、実AI接続前 |
| OPS-01 | `maxReceiveCount` を2か3に確定、失敗種別ごとのSQSメッセージ処理、Event Source Mapping並列度とReserved Concurrencyの整合 | [Worker](plan/implementation-plan.md#worker)、Phase 4 |
| OPS-02 | Terraform・Providerバージョン、S3ネイティブロック設定、Stateに秘密値を入れないSecret注入手順 | [インフラ・運用](infra/terraform.md)、Phase 3–4 |
| OPS-03 | CloudWatch閾値、ログ保持、DLQ調査・再投入、異常ジョブ復旧手順 | [インフラ・運用](infra/terraform.md)、Phase 4–5 |

原文の再構成に外部サービスの最新仕様の検証は含めていない。実装時にNode.js/Lambda対応、CloudFront OAC、Cognito、OpenAI支出制限、Terraformなどの提供状況を確認し、原文の要求との整合を判断する。
