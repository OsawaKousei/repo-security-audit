# Phase 4：AWS dev配布・検証記録

2026-11-01。利用者のTerraform apply完了と続行指示を受け、実AWSの配置確認、Frontend配布、HTTP・ブラウザー検証を行った。実装契約は [AWS runtime仕様](aws-runtime.md)、再現手順は [AWS配布](../dev/aws-deployment.md) を参照する。

## 環境と配布

| 項目 | 確認結果 |
|---|---|
| 対象 | `kupacllc` / `103492189525` / `ap-northeast-1` のdev |
| 公開URL | `https://repo-sentinel-dev.prj.kupac.co.jp` |
| Terraform | 利用者が27件追加・CloudFront 1件更新をapply。その後のPlanは差分なし |
| Lambda | API・WorkerともActive、LastUpdateStatus=Successful、Node.js 24 |
| コード | 配置済みAPI・WorkerのCodeSha256がクリーンビルドのZIPと一致 |
| npm Layer | `repo-sentinel-dev-npm:1` をWorkerへ配置 |
| 認証 | APIはCognito、許可subは本人用ユーザー |
| ネットワーク | 両LambdaのVpcIdはnull。VPC接続・NAT Gatewayは追加しない |
| SQS接続 | Enabled、batch 1、最大並列2、ReportBatchItemFailures |
| Queue | Visibility 1,080秒、maxReceiveCount 2、専用DLQ |
| AI | `AI_MODE=mock`。実OpenAI呼び出し・Secret値の設定は未実施 |
| Frontend | 検証済み5ファイルをdev専用S3へ配布。assetsを先、index.htmlを最後に更新 |
| CloudFront | Deployed、devドメインのみ。公開index.htmlのハッシュが成果物と一致 |

費用通知は未設定。Lambdaの予約枠は使わず、SQSの並列上限2とDynamoDBの同時監査1件制限を利用する。配布のためにIAM・Cognito・Secret値を追加変更していない。

## 公開経路の確認

| 検証 | 結果 |
|---|---|
| `/` と `/auth/callback` | HTTP 200、SPA shell、Cache-Control=no-cache |
| 指紋付きCSS・JS | HTTP 200、長期immutableキャッシュ |
| 未認証の `/api/health` | 401 UNAUTHORIZED、Cache-Control=no-store |
| 不正JWTでの `/api/health` | 401 UNAUTHORIZED |
| 未認証POST＋JSON本文SHA-256 | CloudFront/OAC経由でAPIへ到達し401 UNAUTHORIZED |
| 未署名のFunction URL直接アクセス | 403で拒否 |
| ブラウザーのログイン画面 | 配布済みReact・CSSの表示を確認 |
| 未知stateのCallback | 拒否され、code/queryをURLから消去 |
| 実Cognitoへの遷移 | dev HTTPS Callback、S256 PKCE、state、nonceを確認。Managed Loginのパスワード入力欄が表示された |

これらのAPI検証は未認証リクエストであり、正常な監査ジョブは作成していない。本人のパスワード・認証コード・実トークンは収集しない。

## 本人操作による監査

利用者へ、公開URLでのログインと `https://github.com/axios/axios` の監査1件を依頼し、結果を確認中。依頼前に既存の読取処理でルートのpackage.json/package-lock.jsonを取得し、対応形式であることを確認した。確認時SHAは `9d11464a75ee5c644c0308d742f58755c0482594`。対象のインストール・npmスクリプト実行・AI呼び出しは行っていない。

結果受領後に、本人所有のDynamoDBジョブ、SQS/Worker、試行回数、完了状態とレポート表示を照合する。現時点では認証後の監査フロー成功を完了扱いにしない。

## 証跡と残る範囲

Git管理外の `.local/phase4/` に、HTTP結果 `aws-http-verification.json`、ブラウザー結果 `aws-browser-verification.json`、画面 `aws-login.png`、apply後Plan `post-apply-plan.txt` を保存した。

実Secret取得、実AI、AWS上でのAI予算上限・成否不明時の制御、実DLQ移動は未検証。署名済みの許可外sub拒否は自動テストで確認しており、実Cognitoに2人目を作る試験は行っていない。Secret更新と実AI有効化は別の明示確認を伴う。Phase 4全体の完了はこれらの範囲と区別する。
