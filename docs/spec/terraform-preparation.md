# Terraform初期化前の検証記録

2026-11-01にdev向けTerraform定義を作成した。接続先・構成・AWS変更の記録は [Terraform README](../../infra/terraform/README.md) を正とし、本書には検証範囲だけを記載する。

## 確認済み

- `terraform fmt -check -recursive infra/terraform` が成功。
- HCLパーサーで12個の `.tf` ファイルを解析。7ディレクトリ内の変数・リソース参照、module引数と出力参照を静的に検査した。
- Backend設定・変数ファイルの構文と、専用Stateキー・S3ロック設定を確認した。
- `tests/unit/cloudfront.test.ts` でSPAのルート書換え・静的ファイルの保持・runtime無効時のAPI 503応答を検証した。
- `npm run lint`、`npm run typecheck`、`npm test` が成功。全86テストのうち6件が上記CloudFront Functionの検証。
- 承認された共有StateバケットのVersioning有効化後、15分待って再確認。`Enabled`、既存7件のkey・ETag・サイズ・更新日時は変更前と一致し、delete marker・S3ロックは0件だった。State本文は取得していない。

## 未検証

利用者の指定により `terraform init` の直前で停止している。Providerスキーマによる `terraform validate`、Plan、Apply、CloudFront実環境での動作確認は行っていない。静的検査の成功をAWSへの配置成功とは扱わない。

初期値は `enable_runtime=false`。AWS版の認証統合・Lambdaハンドラー・分散制御・成果物作成は後続工程であり、本記録により実装済みとはしない。
