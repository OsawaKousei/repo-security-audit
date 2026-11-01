# dev初期ユーザー作成スクリプト

2026-11-01に `scripts/create-dev-user.ts` と `npm run cognito:user` を追加した。実行手順・初回ログインは [Terraform README](../../infra/terraform/README.md#初期ユーザーの準備) を参照する。

## 対象と動作

- 対象はアカウント `103492189525`、東京、`repo-sentinel-dev` User Poolだけ。Pool IDはこのリポジトリのdev Terraform出力から取得し、STS・Pool名・ARN・管理者作成限定・MFA必須・TOTP有効を確認する。
- メールアドレスを必須とし、既定は読み取りだけ。未作成なら `action=would_create`。`--create` 指定時だけ `AdminCreateUser` を呼び、AWSが仮パスワードを生成してメールで通知する。
- 同じメールの既存ユーザーは `AdminGetUser` で読み取り、`action=exists` とsub・status・MFA登録状態を返す。パスワード変更・MFA解除・メール再送・ユーザー削除はしない。
- 同じメールの同時作成で `UsernameExistsException` になった場合は、既存ユーザーを再読取する。作成APIを再送しない。
- 対象メールが見つからずPoolに別ユーザーがいる場合は、2人目の追加を拒否する。存在確認失敗のうち `UserNotFoundException` だけを未作成扱いにし、権限不足・通信失敗などでは作成しない。
- AWS CLIの自動再試行を無効にする。エラー出力はCLIのエラーコードに絞り、生のstderr・引数入り例外を出さない。
- パスワード・TOTP秘密値を入力、表示、ファイル保存、Terraformへの受け渡しに使わない。メールを自動でverifiedにはせず、認証設定やTerraform変数も書き換えない。

## 検証済みと制約

`tests/unit/dev-user.test.ts` の9ケースで、読取既定・一度の作成・既存ユーザーとMFAの保持・権限不足・別ユーザー・別アカウント／prod Pool・同時作成・不正メールを検証した。既存を含む全95テスト、型チェック、ESLintが成功。

実AWSでは `bootstrap-preview@example.invalid` を使った作成フラグなしの読み取りモードが成功し、`would_create` を確認した。実ユーザー作成・招待配送・初回ログイン・TOTP登録は未実施。作成APIの呼出し内容と再実行の挙動はテストの代替CLIで検証したもので、実メール配送の成功を示さない。

別メールでの同時実行を排他制御する仕組みは持たないため、初期作成は1人の管理者が順番に実行する。アプリの本人限定はAPIの許可sub認可で別途実装する。招待期限切れ・配送失敗・MFA紛失は個別の管理操作で対応し、このスクリプトで自動復旧しない。
