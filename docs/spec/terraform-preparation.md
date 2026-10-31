# Terraform準備の検証記録

2026-11-01にdev向けTerraform定義を作成した。接続先・構成・AWS変更の記録は [Terraform README](../../infra/terraform/README.md) を正とし、本書には検証範囲だけを記載する。

## 初期準備時に確認済み

- `terraform fmt -check -recursive infra/terraform` が成功。
- HCLパーサーで12個の `.tf` ファイルを解析。7ディレクトリ内の変数・リソース参照、module引数と出力参照を静的に検査した。
- Backend設定・変数ファイルの構文と、専用Stateキー・S3ロック設定を確認した。
- `tests/unit/cloudfront.test.ts` でSPAのルート書換え・静的ファイルの保持・runtime無効時のAPI 503応答を検証した。
- `npm run lint`、`npm run typecheck`、`npm test` が成功。全86テストのうち6件が上記CloudFront Functionの検証。
- 承認された共有StateバケットのVersioning有効化後、15分待って再確認。`Enabled`、既存7件のkey・ETag・サイズ・更新日時は変更前と一致し、delete marker・S3ロックは0件だった。State本文は取得していない。

## dev専用ドメイン構成で確認済み

利用者の指示により、devは `repo-sentinel-dev.prj.kupac.co.jp`、本番は `repo-sentinel.prj.kupac.co.jp` に分ける。devの基盤は未apply。

- CloudFrontのAlias、既存証明書参照、Route 53のA/AAAA、Cognito Callback／Logout、Frontend出力で固定devドメインを使用する。
- `terraform fmt -check -recursive infra/terraform` と `terraform validate` が成功。
- `environments/dev/tests/dev-domain.tftest.hcl` のモックProviderによる4件のPlanテストが成功。固定dev URLと初回のCallback登録、本番ドメイン・生成CloudFrontドメイン・prod環境の入力拒否を検証した。実AWSへのテストapplyは行っていない。
- AWSの読み取りで既存証明書がISSUED・SANが `*.prj.kupac.co.jp`、dev用DNSレコードとCloudFront Aliasが未使用であることを確認した。
- 実AWSへのPlanは26件追加・変更0件・削除0件。PlanのJSONでDNS A/AAAA・CloudFront Alias・指定ACM参照・`TLSv1.2_2021`・CognitoのCallback／Logout／default redirectの一致を確認した。本番DNS・既存証明書の作成／更新・Lambda・IAM作成は含まれない。
- `cognito_frontend_domain` と2段階のURL登録を削除した。初回からCallbackを設定できるため、生成URLの転記・そのための再applyは不要。APIのSSM連携は追加していない。

## 未検証

AWSへのApply、CloudFrontの実配信、Cognitoの実ログインは行っていない。validate・Plan・モックテストの成功をAWSへの配置成功とは扱わない。

初期値は `enable_runtime=false`。AWS版の認証統合・Lambdaハンドラー・分散制御・成果物作成は後続工程であり、本記録により実装済みとはしない。
