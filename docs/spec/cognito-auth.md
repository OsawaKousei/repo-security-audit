# Phase 3：React・HonoのCognito認証

2026-11-01にローカルのReact・Honoをdev User Poolへ接続する認証を実装した。AWSへのアプリ配布・Lambda/SQS統合は含まない。起動手順は [ローカル開発](../dev/local-development.md) を参照する。

## ブラウザー

`frontend/app/src/auth.ts` はoidc-client-ts 3.5.0のOidcClientを利用する。Managed LoginへAuthorization Code Flow＋S256 PKCEで遷移し、ランダムなstateとnonceを使用する。Callbackは現在のオリジンの `/auth/callback`。ローカルの127.0.0.1:5173は登録済みのlocalhost:5173へ正規化する。

sessionStorageにはclient別prefixで、認可応答の照合に必要なstate・nonce・code verifierだけを一時保存する。有効期間は10分。Callbackでは照合状態を一度で消費し、再利用・未知state・期限切れを拒否する。ID Tokenのnonceをライブラリで照合し、issuer・audience・期限も確認する。ID TokenはAPI認可に使わない。

アクセストークンとrefresh tokenはメモリ内だけに保持し、localStorage・sessionStorage・URLへ保存しない。Callbackのcode・エラーqueryを直ちに履歴から除去する。OIDCライブラリのログは無効。ページ再読み込みでメモリ内認証は失われるため、ログインボタンから再認証する。自動silent renew・iframe・自動refreshは行わない。

期限切れ・API 401ではトークンを破棄してログイン画面へ戻る。API 403では監査画面をアンマウントし、許可外ユーザー向けの表示とログアウト操作を出す。ログアウトはローカルトークン・未完了stateを消去し、refresh tokenの失効を試みてCognitoの `/logout` へ遷移する。失効要求の通信失敗時もローカル認証は破棄する。既発行access tokenの即時失効をオフラインJWT検証で保証するものではない。

## API

`api/app/src/auth.ts` はaws-jwt-verify 5.2.1を利用する。固定設定のUser PoolのJWKSで署名を検証し、issuer・期限・`token_use=access`・`client_id`を検証する。subはUUID形式と許可subの一致を確認する。未知鍵は設定済みJWKSからの取得を試み、取得失敗を含めて拒否する。

JWTは共有定数の `X-Access-Token` だけから受け取る。Authorization、所有者ヘッダー、本文のownerSubは認証に使わない。未認証・不正JWTは401、正しい署名でも許可sub以外は403。エラー応答・ログへJWT・claim・ライブラリの生エラーを出さない。`createApp` の認可コールバックは非同期に対応し、未指定時は拒否する。

FrontendはAPIを相対パスで呼び、アクセストークンを専用ヘッダーへ付ける。POSTのJSON本文そのものをSHA-256でハッシュし、`X-Amz-Content-Sha256` へ設定する。401/403を自動再試行しない。LambdaのCognito認可factoryは実装済みだが、既定handlerはAWS storage/queue未設定として503を返し、Phase 4までデプロイしない。

## ローカル実行と所有者

通常は `AUTH_MODE=cognito`、`LOCAL_AUTH_BYPASS=false`。API・Workerは `ALLOWED_USER_SUB` を使用し、従来の `local-user` 履歴を自動移行しない。ローカルCLIは管理者の直接操作としてこの設定subで保存・実行する。保存先は引き続きDynamoDB Local、キューはローカルdispatcherで、AWSデータ操作は許可しない。永続AI予算台帳を変更・リセットせず、所有者変更後も全予約を日次・月次集計に含める。

回帰テスト専用に `AUTH_MODE=local-bypass` と `LOCAL_AUTH_BYPASS=true` の両方を明示できる。APIのHost・Origin・Sec-Fetch-Site検査、APP_ENV=local、非production、非Lambda、Local DBの制限を維持する。Frontendも開発ビルド・loopback以外でこの設定を拒否する。Cognito設定とbypass=trueの併用は起動エラー。AWS向けLambdaエントリーポイントはローカル認証コードをimportしない。

Composeの稼働確認は認証情報を持たない `/healthz` に分ける。アプリ用 `/api/health` はCognito認証と本人認可を必要とし、実行モードを返す。API・Frontendには公開Cognito識別子だけを渡し、OpenAIキーはWorkerだけに渡す。

## 検証

- 単体テスト132件が成功。RSA署名、改ざん、期限、issuer/client/token_use、許可外sub、JWKS障害、state/nonce/PKCE、Callback再利用、メモリ保持、失効・logout、API本文ハッシュを含む。
- ComposeのDynamoDB Localに対する統合テスト19件が成功。署名済みテストJWTでの本人所有ジョブ作成・Worker・履歴と、不正JWT／他subの拒否を含む。
- ブラウザー認証テスト3件が成功。OIDC・API応答はブラウザー内のモックで、Callback→監査画面→logout、未知state拒否、403時の画面破棄を確認した。従来のモック監査E2Eは明示bypass構成専用として通常実行ではskipする。
- 実Cognitoのログインフォームへ遷移し、認可コード方式・S256・state・nonce付きで受理されることを確認。利用者から、本人用アカウントでログインして監査画面へ戻れたと回答を得た。読み取り専用CLIでもユーザーの `CONFIRMED` を確認した。パスワード・認証コード・実トークンは収集していない。
- 利用者から、初回にQRコードを登録して6桁コードを入力したと回答を得た。さらにアプリからログアウト後、QRコードの再登録なしで6桁コードを要求され、監査画面へ戻れたとの回答を得た。初回登録・ログアウト・再ログインでのTOTP要求を本人操作で確認済み。User Poolも `MfaConfiguration=ON`・Software Token有効を読み取り確認した。
- 初回ログイン後の `admin-get-user` は `UserMFASettingList=null`・`PreferredMfaSetting=null` を返した。この一覧と実操作の差異の理由は未特定。上のTOTP動作確認とは別の観測として残し、MFA未登録とは断定しない。ユーザーのMFA設定を変更して一覧を埋める操作は行っていない。
- 型チェック・ESLint・ホスト依存を使わないクリーンビルドが成功。AWSアプリ配布は後続Phase。

根拠：[CognitoのJWT検証](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html)、[aws-jwt-verify](https://github.com/awslabs/aws-jwt-verify)、[Cognitoの認可エンドポイント](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html)、[oidc-client-ts](https://github.com/authts/oidc-client-ts)。MFAの読み取り範囲は [AdminGetUser](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminGetUser.html)、TOTPの検証は [VerifySoftwareToken](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_VerifySoftwareToken.html) を参照する。
