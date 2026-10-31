# 開発ワークフロー

## 日常の開発

1. [ドキュメント一覧](../README.md)から変更対象の仕様と未確定事項を読む。
2. ホストで実装・依存関係更新・型チェック・ESLint・単体テストを行う。
3. [ローカル開発環境](local-development.md)のComposeで動作確認する。
4. AWS固有の変更はAWS devへ反映し、統合テストする。
5. 検証結果と未確認事項を記録し、必要に応じてprodへ反映する。

変更内容に応じた検証環境は[検証計画](../testing.md)に従う。初期構築後もローカル環境を維持し、AWS全体をローカルで複製しない。

## Phase 1：ローカルの基本実装

目的：Frontend・API・DynamoDBの基本フローを確認する。

2026-11-01：Phase 1の実装とローカル動作検証を実施済み。[確定仕様](../spec/local-basic.md)と[検証記録](../spec/phase1-verification.md)に契約・実績・未確認事項を記録した。VS Codeの目視操作と後続PhaseのAWS検証は別管理とする。

- [現行のディレクトリ構成](repository.md)を維持し、npm workspacesと単一ロックファイルを初期化する。
- `.node-version`、依存関係共有、Compose、ホストUID/GIDを整える。
- React + Vite、Hono、DynamoDB Localを実装・起動する。
- ジョブモデル、監査作成API、Mock Workerを実装する。
- ポーリングと結果表示を実装する。

この段階では認証と実AI処理を実装しない。認証バイパスはlocalhost限定の初期実装だけに許し、AWS dev/prodでは許さない。

完了条件：監査開始からモックジョブの完了、レポート表示まで動作する。ホスト・Composeの役割分担とホットリロードも[開発環境の受け入れ条件](../testing.md)を満たす。

## Phase 2：Workerのローカル実装

目的：実際の機械監査とAI分析を確認する。

2026-11-01：Phase 2を実装し、AIモックの実監査、実OpenAIレポート生成、ブラウザー表示を確認した。契約・範囲は[Worker仕様](../spec/local-worker.md)、結果・確認の限界は[Phase 2検証記録](../spec/phase2-verification.md)を参照する。

- GitHub API連携、対象SHA・対象ファイル取得。
- `npm audit`、結果正規化。
- OpenAI Responses API、Structured Outputs検証。
- DynamoDBへの保存、タイムアウト・エラー処理。

まずAIをモックして機械監査を検証する。その後、[外部入力・秘密情報・費用制限](../security.md)を実装したうえで実OpenAI APIを接続する。

完了条件：ホストからCompose経由でWorkerを直接実行し、実公開リポジトリのレポートを生成できる。

## Phase 3：TerraformとCognito

目的：AWS devと認証基盤を準備する。

2026-11-01：dev向けTerraform定義を作成し、利用者のinit後、固定devドメイン構成でvalidate・テスト・Planまで確認した。共有StateのVersioning有効化だけを承認後に実施済み。Cognitoやアプリ用AWSリソースは未作成で、Phase 3全体は未完了。[準備状況と次の手順](../../infra/terraform/README.md)を参照する。

- Terraform Stateの設定とdev環境定義。今回は既存共有S3を利用するためbootstrapは作成しない。
- Cognito User Pool、Managed Login、初期ユーザー、TOTP MFA。
- Reactの認証統合、HonoのJWT検証・許可 `sub` の認可。
- ローカルReactをdev User Poolにつなぎ、localhost Callback URLを登録。

完了条件：許可された本人だけがローカルAPIを利用でき、未認証・未許可アクセスが拒否される。以降はローカルでも実認証を基本とする。

## Phase 4：AWS統合テスト

目的：実AWSサービス間の連携を確認する。

- API・Worker Lambdaのデプロイ、DynamoDBの構築。
- SQS・DLQ・Event Source Mapping。
- CloudFront + S3、Function URL OAC。
- Secrets Manager連携。
- Worker冪等性とOpenAI使用量制限の検証。

完了条件：CloudFrontの画面からAWS Lambdaの監査・レポート生成まで完了する。成果物はクリーン環境でビルドする。

## Phase 5：最終検証・本番化

[検証計画](../testing.md)のセキュリティ・障害・重複・費用制限のケースを完了する。必要に応じてprodを作成する。prodはdevで一連の動作を確認してから作る。

PoC全体の完了は[PoC完了条件](../testing.md)で判定し、個別Phaseの完了と混同しない。

## Codexの操作と権限

Codexはホストからソース作成・変更、npm依存更新、型チェック・ESLint・単体テスト、Compose起動停止・ログ確認、Worker実行、Git操作、Terraform検証・Plan作成を行う。コンテナ内部へCodexをインストールしない。

Dockerデーモンへのアクセスは実質的に高いホスト権限を与え得るため、許可範囲を認識して運用する。AWS認証情報は開発用の最小権限に限定する。

次の操作は該当操作への明示的な確認を伴う。

- `terraform apply` / `terraform destroy`
- 本番環境へのデプロイ
- AWS IAM権限変更
- Secrets Manager更新
- 本番データ削除

事前に変更内容、Planや成果物、検証結果を確認できる状態にする。検証・Planの作成と、実リソースの変更を区別する。

## 仕様の保守

未実装の機能要件は[実装計画](../plan/implementation-plan.md)、共通要件・手順は[一覧の担当文書](../README.md)を更新し、[未確定事項](../decisions.md)を整合させる。同じ詳細を複数箇所へ複製しない。実装・検証が完了した範囲は [docs/spec/](../spec/README.md) に実際の動作・契約・制約・確認根拠を記録し、関係する計画文書にも反映済み範囲を明記する。機能追加・技術選定変更は明示的に管理し、設定例がそのまま動くと記載しない。
