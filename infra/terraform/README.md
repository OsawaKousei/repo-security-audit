# Terraformの準備状況

2026-11-01に、参照構成 `ref/apt-repo/infra/apt-repo` に合わせてdev向けTerraform定義を作成した。当初はinit前で停止し、その後、利用者がinit・旧構成のPlanを実行した。現在は利用者の指示でdev専用ドメイン `repo-sentinel-dev.prj.kupac.co.jp` に設定し、validate・モックテスト・Planまで確認済み。**applyは未実行。アプリケーション用リソースは未作成。**

| 項目 | 採用した設定 |
|---|---|
| 配置 | `environments/dev`。prodは別Stateで後続対応 |
| AWS profile / region | `kupacllc` / `ap-northeast-1` |
| 想定アカウント | `103492189525`。Providerのallowed_account_idsで制限 |
| Stateバケット | `terraform-state-bucket-103492189525-ap-northeast-1-an`。参照元の実設定から確認 |
| 新規Stateキー | `kupac/repo-sentinel/dev/terraform.tfstate` |
| Stateロック | S3 native lock。DynamoDBによるStateロックは使用しない |
| dev公開ホスト | `repo-sentinel-dev.prj.kupac.co.jp`。`frontend_url` 出力も同じURL |
| Route 53 | 既存公開 `kupac.co.jp.` ゾーン `Z06893261CC94H6AKTJGK` にdev用A/AAAA Aliasを作成 |
| 証明書 | 指定済みus-east-1 ACM証明書 `7b6cdfdb-5b63-4572-936c-f7362c471713` を参照。作成・import・検証CNAME変更は行わない |
| 本番URL | `repo-sentinel.prj.kupac.co.jp` を予約。将来の別環境で設定 |
| Terraform | `>= 1.10.0, < 2.0.0`。ローカルの1.17.0でfmtを確認 |
| AWS Provider | 参照元のlockファイルと同じ6.69.1に固定 |

`backend.hcl` と `terraform.tfvars` はexampleから作成済みでGit管理外。設定例には接続先識別子だけを記載し、AWS資格情報・OpenAIキー・パスワードを置かない。既存Stateバケットの所有権やポリシーは本プロジェクトへ取り込まない。

## AWSの読み取り確認結果（2026-11-01）

SSO復旧後、指定profileで以下を確認した。dev専用ドメインへの変更時に、証明書のISSUED・SANとdev用DNSレコード・CloudFront Aliasの未使用を再確認した。認証情報・State本文はログへ出力していない。

| 対象 | 結果 |
|---|---|
| STS Account | `103492189525` と一致 |
| ACM | 指定ARNが `ISSUED`、SANは `*.prj.kupac.co.jp` |
| 公開ゾーン | `kupac.co.jp.` / `Z06893261CC94H6AKTJGK` |
| DNS | 初期確認時に `prj.kupac.co.jp.` の委譲なし。dev変更時に `repo-sentinel-dev.prj.kupac.co.jp.` の既存レコードなし |
| CloudFront Alias | devホストを使用する既存Distributionなし |
| Stateキー | `kupac/repo-sentinel/dev/` 配下にオブジェクトなし |
| S3 Block Public Access | 4項目ともtrue |
| S3 default encryption | AES256 |
| S3 Versioning | 事前は未設定。承認後にEnabledへ変更し、APIで確認済み |

## 実施したAWS変更

利用者の「では実装してください」を受け、指定アカウントをSTSで再確認し、S3ロックファイルが存在しないことを確認してから、既存共有バケットのVersioningだけを有効化した。

| 項目 | 記録 |
|---|---|
| 変更前 / 変更後 | 未設定 → `Enabled` |
| Enabled確認日時 | 2026-11-01 03:41:24 JST（2026-10-31 18:41:24 UTC） |
| State書込再開の最短目安 | 2026-11-01 03:56:25 JST。確認時刻から15分待機 |
| 直前のS3ロック | 0件 |
| 直前のState | 7件、151,982バイト |
| 15分経過後の再確認 | 2026-11-01 03:56:41 JST。`Enabled`、既存7件のkey・ETag・サイズ・更新日時が変更前と一致 |
| 再確認時の世代・ロック | null version 7件、delete marker 0件、S3ロック0件 |

State本文、既存のStateオブジェクト、IAM、Bucket Policy、Lifecycle、DNS、証明書を変更していない。バケットは本アプリのTerraform Stateへimportしない。15分の待機とメタデータ再確認は完了した。自分以外のCIやDynamoDB方式のロックまで停止を確認したものではなく、既存全プロジェクトのTerraform実行試験は行っていない。

## 作成したTerraform構成

| 配置 | 定義 |
|---|---|
| `environments/dev` | Backend、Provider、module接続、出力、監視、任意のAWS予算通知 |
| `modules/auth` | Cognito User Pool、公開App Client、Managed Login v2、既定branding |
| `modules/frontend` | 非公開S3、S3 OAC、CloudFrontのdev専用Alias、既存ACM参照、Route 53 A/AAAA |
| `modules/database` | PK/SKのDynamoDB PAY_PER_REQUEST、暗号化、PITR、削除保護 |
| `modules/queue` | 暗号化SQS StandardとDLQ、Visibility 1,080秒、maxReceiveCount 2 |
| `modules/api` | 条件付きAPI Lambda、Function URL AWS_IAM、限定IAM、ログ |
| `modules/worker` | 条件付きWorker Lambda、限定IAM、ログ、SQS Event Source Mapping |

初期設定は `enable_runtime=false`。この状態で将来applyするとCognito・Frontend・Database・Queue・値未設定のSecretコンテナ等を作成するが、Lambda・runtime用IAM・SQS消費は作成しない。`/api` と `/api/*` はCloudFront Functionで503を返す。Frontendの静的ファイルはTerraformから自動アップロードしないため、初期S3は空になる。

`enable_runtime=true` はPhase 4の準備後に使う。API/Workerの読み取り可能なZIP、npm Layer ARN、許可Cognito sub、AWS予算額とメールの設定を必須とする。APIはNode.js 24 / timeout 15秒 / concurrency 2、WorkerはNode.js 24 / timeout 180秒 / concurrency 2、SQS mappingはbatch 1 / maximum concurrency 2。アプリ側の同時監査1件・日次回数・冪等性は別途実装・検証する。

CognitoはESSENTIALS、自己登録禁止、TOTP MFA必須、OAuth Code Flow、client secretなし、外部IdPなし。初回から `https://repo-sentinel-dev.prj.kupac.co.jp/auth/callback` と `http://localhost:5173/auth/callback` を登録する。Logoutも同じ2オリジンを登録し、default redirectはdevのHTTPS URLとする。PKCE・JWT検証・許可sub認可は後続のアプリ実装で完成させる。

初期ユーザーの作成とパスワード設定は管理操作で行い、パスワードをTerraformへ渡さない。ユーザー作成後のsubを `allowed_user_sub` に設定する。OpenAIキーは `aws_secretsmanager_secret` の空コンテナだけを定義し、値は明示確認を伴う別のSecrets Manager操作で注入する。`aws_secretsmanager_secret_version` やキー値のTerraform変数は作成しない。

API経路はキャッシュ無効、JWTヘッダー `X-Access-Token` と `X-Amz-Content-Sha256` を転送し、CloudFront OACのSigV4認証と分ける。Lambdaのリソースポリシーは当該Distributionだけに `InvokeFunctionUrl` と、Function URL経由の `InvokeFunction` を許可する。Workerだけが対象Secretを読み取れる。

CloudWatchはDLQ件数1以上・Queue最古600秒以上を定義し、runtime有効時はLambda ErrorsとWorker Duration 170秒以上も監視する。`budget_monthly_usd` と `budget_email` を両方設定するとAWS予算の80%/100%実績通知とSNSメール購読を作成する。購読確認、Projectタグのコスト配分タグ有効化はapply後の管理作業。未設定時のCloudWatch Alarmは通知先なしであり、AWS予算も作成しない。AWS予算は通知であり、実行の強制停止ではない。

## Versioning有効化の影響評価（2026-11-01）

以下は有効化前に実施した評価。設定・オブジェクトと世代のメタデータだけを読み取り、State本文は取得していない。有効化の実績は前節に記録する。当該評価時点ではTerraform initは未実行だった。

- 現行Stateは7件、合計151,982バイト（約148KiB）、全件STANDARD。すべてnull versionで、過去世代とdelete markerは0件。
- 対象は `kupac/apt-registry`、`prelis/apt-repo`、`prelis/ms-store`、`prelis/web-frontend`、`webpage/kupacllc-homepage`、`webpage/prelis-lp`、`webpage/web2md-lp` のState。
- バケットのLifecycle、レプリケーション、S3イベント通知、アクセスログ転送、Bucket Policy、タグは未設定。リージョンはap-northeast-1。

評価は「既存サービスへの直接影響は小さいが、全プロジェクトのState保存・削除運用に変更がある」。[AWSのVersioning仕様](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html)では有効化はバケット全体に適用され、今回のアプリのprefixだけを対象にはできない。

| 観点 | 評価 |
|---|---|
| 既存データ・サービス | 既存Stateの内容・key・権限・null versionはそのまま。設定変更だけで管理対象の配信基盤やLambda等を変更・再作成する操作は発生しない |
| Terraform通常操作 | version IDを指定しない取得は最新Stateを返すため、既存Backendのbucket/keyや通常のGet/Put権限は変更不要と考える。既存全プロジェクトのCI実行試験は未実施 |
| 有効化直後 | AWSは初回有効化後15分のPUT/DELETE待機を推奨。共有する全プロジェクトのTerraform実行と他のState書込を止め、伝播完了後に再開する。ロック作成を行うplanも対象 |
| 容量・費用 | 上書きごとにState全体を保存し、差分保存ではない。現在と同じサイズで全7件を各1,000回上書きした例では約145MiBの追加容量。更新頻度・保持期間は未確認のため実請求額は算定しない |
| 削除・ロック | 通常のDELETEはdelete markerになり、過去世代は残る。最新が削除扱いになるため通常のロック解除後に古い世代がそのまま現行ロックになるわけではない。完全消去はversion IDを指定する別操作 |
| 復旧・保持 | 誤上書き・誤削除からのState復旧が可能になる。有効化以前の消失した履歴は復元されない。State内の機微情報も過去世代として残る |
| Lifecycle | 現状は自動削除ルールがなく、有効化だけで既存Stateが期限削除されることはない。後で過去世代の保持期間を合意する。現行StateにExpirationを設定しない |
| 戻し方 | 一度有効化すると未設定状態には戻せず、Suspendedにできるだけ。既存の過去世代はそれだけでは消えない |

根拠：[Versioningの保存・初回伝播・既存オブジェクト](https://docs.aws.amazon.com/AmazonS3/latest/userguide/versioning-workflows.html)、[バージョン付きオブジェクトの削除](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html)、[Terraform S3 Backend](https://developer.hashicorp.com/terraform/language/backend/s3)。

推奨は、全State利用者のTerraform実行停止を調整したうえでVersioningを有効化し、少なくとも15分待ってから再開すること。現状の容量では保存費用の増分は小さいと見込む。Lifecycleによる過去世代の削除は、共有プロジェクトの保持要件を決めた後の別変更とする。

共有バケットを所有する別のIaC構成、各CIの個別IAM制約、外部の清掃スクリプト・自動実行スケジュールは未確認。有効化により既存IaCとの設定差分が発生するか、通常DELETEで完全消去することを前提にした運用がないかは、管理元で確認する。この評価の後に利用者が承認し、Versioningのみ有効化した。

## 検証と現在の境界

dev専用ドメイン構成で `terraform fmt -check -recursive infra/terraform`、`terraform validate`、モックProviderによる `terraform test` の4ケースが成功。固定dev URLと初回からのCallback登録、本番ドメイン・CloudFront標準ドメイン・prod環境の指定拒否を検証した。

実AWSに対するPlanを再生成し、**26件追加・変更0件・削除0件**を確認した。PlanのJSONでもdev用A/AAAA・CloudFront Alias・指定証明書・TLSポリシー・CognitoのCallback／Logout／default redirectの整合を確認した。既存Stateバケット・本番DNS・証明書の作成や更新は含まれない。アプリケーション・CloudFront Functionsのコードは今回変更していない。

`.terraform` と `.terraform.lock.hcl` は利用者のinitで生成済み。AWS Providerは6.69.1で固定している。AWSへのapply・実配信・実Cognitoログインは未検証。初期準備時のHCL静的検査、npmの型チェック・ESLint・全86テストの記録は [検証記録](../../docs/spec/terraform-preparation.md) を参照する。

## ドメインと認証URLの管理

`public_domain` は `<project_name>-dev.prj.kupac.co.jp` のみを許可する。CloudFrontのAlias、Route 53、Cognito Callback／Logout、Frontend出力に同じ入力値を使う。`repo-sentinel.prj.kupac.co.jp` は将来のprod向けに予約し、devの入力では拒否する。DNSは `allow_overwrite=false` として既存レコードの上書きを避ける。

指定済みの `*.prj.kupac.co.jp` 証明書でdevホストをカバーし、CloudFrontは `sni-only`・`TLSv1.2_2021` を使用する。ACMの新規発行や検証レコード変更は行わない。証明書ARNを参照するだけなので、未使用だったus-east-1 Providerは不要。

固定URLを初回からCognitoへ渡せるため、生成されたCloudFront URLの手動転記やCallback登録のための再applyは不要。`cognito_frontend_domain` 変数と2段階登録手順は削除した。APIは従来のCognito環境変数方式を維持し、SSMによる認証設定取得は追加していない。

## 次の手順

**本番URLやCloudFront標準URLを前提とした古いPlanを適用しない。** `environments/dev/dev.tfplan` は固定devドメイン構成で再生成済み。設定変更時は必ずPlanを作り直す。

```bash
terraform -chdir=infra/terraform/environments/dev validate
terraform -chdir=infra/terraform/environments/dev test
terraform -chdir=infra/terraform/environments/dev plan -out=dev.tfplan
```

Planで26件追加・変更／削除0件とdev用URLを確認し、明示承認後にapplyする。ここでは実行していない。

```bash
terraform -chdir=infra/terraform/environments/dev apply dev.tfplan
terraform -chdir=infra/terraform/environments/dev output frontend_url
terraform -chdir=infra/terraform/environments/dev output cognito_callback_urls
```

prodは別Terraformルート・別State・別リソースで構築する。既存devのURLやStateを本番へ流用しない。

Phase 3でCognitoを構築し、初期ユーザー・TOTP・Frontend/Honoの実認証を統合する。Phase 4のruntime有効化前には以下を完了する。

- Cognito access tokenの署名・issuer・期限・client_id・token_use・許可sub検証、およびPOST本文ハッシュの生成。
- SQSハンドラーとownerSub検証、DynamoDBでの分散ロック・リース・永続AI予算管理、成否不明時の再試行抑制。
- クリーン環境でZIPとnpm Layerを作成し、Layerの `/opt/nodejs/node_modules/npm/bin/npm-cli.js` を `NPM_CLI_PATH` で実行できるようWorkerを対応させる。現在のローカルnpm呼出しをそのままLambdaへ転用しない。
- Secrets Managerへの専用devキー注入、AWS/OpenAIの利用制限、ログの秘密値非出力。
- AWS予算額・通知先・コスト配分タグ、SNS購読の確認、ジョブ失敗・OpenAI失敗のアプリケーション指標を追加。

構成と権限境界は[インフラ・運用](../../docs/infra/terraform.md)に従う。[S3 Backendの公式仕様](https://developer.hashicorp.com/terraform/language/backend/s3)に従い、専用Stateキーと `.tflock` に必要な権限を確認する。既存のAPT Stateには触れない。
