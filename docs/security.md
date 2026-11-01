# セキュリティ要件

本書は認証・外部入力・秘密情報・費用制限の基準を定める。ローカル開発環境の変更によってこれらの要件を緩和しない。

Phase 1のlocalhost限定例外・入力検証・原子的な回数制限の実装境界は[確定仕様](spec/local-basic.md)を参照する。Phase 2の外部入力・秘密情報・実AI・永続費用台帳は[Worker仕様](spec/local-worker.md)に実装済みの境界を記録した。ローカルCognito認証は [Phase 3仕様](spec/cognito-auth.md) に実装済みの範囲と検証限界を記録した。AWS向けの接続・分散制御の実装は [AWS runtime仕様](spec/aws-runtime.md) を参照する。実AWSの反映・疎通は未実施。

## Cognito認証とユーザー認可

- Cognito User Poolの自己登録を禁止する。
- 管理者が作成した1ユーザーのみ利用する。
- パスワード認証とTOTP MFAを必須にする。
- Managed LoginとAuthorization Code Flow + PKCEを使用する。
- Googleなどの外部IdPは利用しない。
- devとprodでUser Poolを分ける。ローカルはdevを利用する。

HonoはAPIリクエストごとにJWTを検証する。

| 検証項目 | 要件 |
|---|---|
| 署名 | 正しい署名であること |
| Issuer | 対象User PoolのIssuerと一致 |
| 有効期限 | 有効期間内 |
| Token Use | 採用するトークン用途に一致 |
| Client ID | 対象App Clientと一致 |
| `sub` | 許可済みユーザーの `sub` と一致 |

ログイン済みでも許可 `sub` と一致しなければ拒否する。JWTを検証できない場合も拒否する。Phase 3ではaccess tokenを採用し、`token_use=access`・`client_id`を検証する。ID TokenはAPI認可に使用しない。

Frontendはトークンを可能な限りメモリに保持し、永続ストレージ保存を避ける。認証バイパスは初期実装時のlocalhost限定とし、Cognito導入後はローカルでも実認証を基本とする。回帰テスト用の明示bypassは開発ビルド・loopback・localエントリーポイントに限定し、通常のCognito設定と併用しない。AWS dev/prodに認証バイパスを入れない。

## CloudFront・Lambda・S3

- S3 Block Public AccessとS3 OACを有効にする。
- Function URLは `AWS_IAM` 認証とする。
- Lambda用CloudFront OACとリソースポリシーで、CloudFrontを経由しない直接アクセスを拒否する。
- APIは同一オリジンの `/api/*` で公開し、キャッシュを無効にする。
- CloudFrontからのオリジンアクセスを適切に制限する。
- LambdaのIAMロールは最小権限とする。

CloudFrontがFunction URLへSigV4署名するため、JWTは `X-Access-Token` などの専用ヘッダーで転送する。POSTは `x-amz-content-sha256` を設定する。Phase 3では `X-Access-Token` を採用し、FrontendがPOST本文のSHA-256を設定する。ローカルの契約は [Cognito仕様](spec/cognito-auth.md)、CloudFront/Lambda経由の実検証はPhase 4で管理する。

## 外部リポジトリ・子プロセス

公開リポジトリの内容も信頼しない。

- GitHub以外の任意URLを禁止し、`owner/repo` 形式を検証する。
- 取得ファイルサイズと取得時間を制限する。
- 対象のnpm設定を実行環境に適用しない。
- 監査対象のパッケージインストール、npmスクリプト、任意コード実行を禁止する。
- `npm audit fix` などの対象変更を行わない。
- 子プロセスにシェル展開を使わない。
- npm Registry接続先を固定する。
- コマンド出力サイズと実行時間を制限する。
- 一時ファイルを処理後に削除する。

ローカルの監査コマンド・エラー判定・サイズ・時間・接続先は[Worker確定仕様](spec/local-worker.md)を参照する。AWSランタイムの検証は後続Phase。

## OpenAI APIとアプリケーションの初期制限

| 項目 | 初期上限・方針 |
|---|---|
| 監査開始 | 5回/日 |
| 同時監査 | 1件 |
| AI呼び出し | 原則1回/ジョブ |
| モデル | サーバー側で固定 |
| 入力サイズ | 上限を設定（値は未確定） |
| 出力トークン | 上限を設定（値は未確定） |
| Worker実行時間 | 180秒 |
| OpenAI月額支出 | 専用Projectで$10を初期上限とする |

基本仕様書のOpenAI Project「Hard spend limit」要求を維持する。[公式Spend limits](https://developers.openai.com/api/docs/guides/spend-limits)で設定手順と強制停止を確認し、2026-11-01に利用者から専用Projectの月額$10強制停止を設定済みとの回答を得て実APIを検証した。管理画面・管理APIでの設定値確認や上限到達試験は行っていない。通知と強制停止を区別し、実AI起動時に確認フラグを要求する。

原文の前提どおり、外部の支出制限に反映遅延や超過の可能性があるものとして、アプリケーション側でも利用を制限する。DynamoDBの条件付き更新などで日次回数を管理し、同時リクエストで突破できないようにする。

OpenAI API失敗時に無制限に再試行しない。AI呼び出し後の成否が不確実な失敗は自動再実行を抑制する。[データ設計](plan/implementation-plan.md#data-model)の冪等性と合わせて実装する。

AWS Budgetsは必要に応じて設定する通知であり、Lambdaの利用やruntime有効化の必須条件にしない。アプリの費用制限・OpenAIの支出制限は独立して維持する。

## 秘密情報とIAM

- OpenAI APIキーはWorkerのみがアクセス可能にする。
- AWSではSecrets Managerに保存し、Terraform Stateへキー値を格納しない。
- dev/prodでOpenAI APIキーを分ける。
- ローカル実API用秘密情報はGit管理外の環境変数ファイルなどから注入する。
- API・WorkerのIAMロールは役割に必要な権限へ限定する。
- Codexが利用するAWS認証情報は開発用の最小権限へ限定する。

IAM変更・Secrets Manager更新などの確認要件は[開発ワークフロー](dev/workflow.md)を参照する。

## ログと監視

ログへアクセストークン、APIキー、認証ヘッダー、不要なリポジトリ内容を記録しない。CloudWatchでAPIエラー、Workerエラー・タイムアウト、SQS滞留、DLQ件数、ジョブ異常終了、OpenAI APIエラーを監視する。

リソースと運用上の確認は[インフラ・運用](infra/terraform.md)、攻撃・障害ケースの検証は[検証計画](testing.md)を参照する。
