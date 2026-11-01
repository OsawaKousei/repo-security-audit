# dev初期ユーザー作成スクリプト

2026-11-01に `scripts/create-dev-user.ts` を追加した。Node.js 24で直接実行し、npm依存関係やtsxは必要としない。実行手順・初回ログインは [Terraform README](../../infra/terraform/README.md#初期ユーザーの準備) を参照する。

## 対象と動作

- 対象はアカウント `103492189525`、東京、`repo-sentinel-dev` User Poolだけ。Pool IDはこのリポジトリのdev Terraform出力から取得し、STS・Pool名・ARN・管理者作成限定・MFA必須・TOTP有効を確認する。
- メールアドレスを必須とし、既定は読み取りだけ。未作成なら `action=would_create`。`--create` 指定時だけ `AdminCreateUser` を呼び、AWSが仮パスワードを生成してメールで通知する。
- 同じメールの既存ユーザーは `AdminGetUser` で読み取り、`action=exists` とsub・status・MFA設定一覧から得た状態を返す。`mfaConfigured` は `UserMFASettingList` に `SOFTWARE_TOKEN_MFA` が含まれるかであり、TOTP秘密値の関連付け・検証済み状態を直接取得するものではない。パスワード変更・MFA解除・メール再送・ユーザー削除はしない。
- 同じメールの同時作成で `UsernameExistsException` になった場合は、既存ユーザーを再読取する。作成APIを再送しない。
- 対象メールが見つからずPoolに別ユーザーがいる場合は、2人目の追加を拒否する。存在確認失敗のうち `UserNotFoundException` だけを未作成扱いにし、権限不足・通信失敗などでは作成しない。
- AWS CLIの自動再試行を無効にする。エラー出力はCLIのエラーコードに絞り、生のstderr・引数入り例外を出さない。
- パスワード・TOTP秘密値を入力、表示、ファイル保存、Terraformへの受け渡しに使わない。メールを自動でverifiedにはせず、認証設定やTerraform変数も書き換えない。

## 検証済みと制約

`tests/unit/dev-user.test.ts` の9ケースで、読取既定・一度の作成・既存ユーザーとMFAの保持・権限不足・別ユーザー・別アカウント／prod Pool・同時作成・不正メールを検証した。既存を含む全95テスト、型チェック、ESLintが成功。

スクリプト追加時は実AWSで `bootstrap-preview@example.invalid` を使った作成フラグなしの読み取りモードが成功し、`would_create` を確認した。作成APIの呼出し内容と再実行の挙動はテストの代替CLIで検証した。その後、利用者がスクリプトで本人ユーザーを作成し、初回ログイン・QR登録・6桁コード入力・監査画面への復帰を確認した。読み取り専用で `exists`・同じsub・`CONFIRMED` も確認済み。MFA設定一覧との差異を含めた最新の認証検証は [Cognito仕様](cognito-auth.md) に記録する。

別メールでの同時実行を排他制御する仕組みは持たないため、初期作成は1人の管理者が順番に実行する。アプリの本人限定はAPIの許可sub認可で実装済み。招待期限切れ・配送失敗・MFA紛失は個別の管理操作で対応し、このスクリプトで自動復旧しない。
