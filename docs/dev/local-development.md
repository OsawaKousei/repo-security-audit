# ローカル開発環境

Phase 2に加え、Phase 3のローカルCognito認証を実装済み。認証の契約・検証範囲は [Cognito仕様](../spec/cognito-auth.md) を参照する。基本契約は[Phase 1仕様](../spec/local-basic.md)、実監査・AI・費用制限の追加契約は[Worker仕様](../spec/local-worker.md)、最新検証は[Phase 2検証記録](../spec/phase2-verification.md)を参照する。

## ホストとコンテナの責務

UbuntuホストでVS CodeとCodexを実行し、モノレポルートを開く。編集、Git、npm依存管理、型チェック、ESLint、単体テスト、Terraform検証はホストで行う。Frontend・API・DynamoDB LocalはComposeで起動し、WorkerはホストからCompose経由で直接実行する。コンテナ内のIDEやCodexは不要。

## 初期セットアップ

```bash
fnm use --install-if-missing
npm ci
npm run setup:local
docker compose up -d --wait
```

Node.jsは `.node-version` の **24.22.2** と `node:24.22.2-bookworm-slim` に統一する。`setup:local` は現在のNodeバージョンを検査し、`.env` の `NODE_VERSION`・`LOCAL_UID`・`LOCAL_GID` を更新する。他の設定は保持する。`.env.example` は設定例であり、UID/GIDはホストに合わせる。

ブラウザーで <http://localhost:5173> を開く。APIはloopbackの3000番ポート、Frontendは5173番ポートで公開する。コンテナ内の待受は `0.0.0.0`。ローカルでもdev User Poolで本人認証する。保存先はLocalのまま維持し、外部公開用にポート・Proxy設定を変更しない。127.0.0.1:5173で開いた場合は登録済みCallbackのlocalhost:5173へ正規化する。

## 依存関係とソース共有

npm workspacesとルートの単一 `package-lock.json` を使用する。各workspaceは自身の実行時依存を宣言し、共通の開発ツールはルートに置く。依存追加はホストで行う。

```bash
npm install <package> -w frontend/app
npm install <package> -w api/app
npm install <package> -w workers/security-audit/app
```

Frontend・API・Workerはリポジトリ全体を `/workspace` にbind mountし、ホストのルート `node_modules` と `packages/*` を共有する。依存用の名前付きVolumeやコンテナ内インストールは使わない。FrontendはVite HMR、APIは `tsx watch` で反映する。

ホストとコンテナはNode・CPUアーキテクチャを合わせる。ネイティブモジュールの共有ライブラリ差が問題になる場合は開発イメージを調整し、共有方式を変更するなら理由と手順を記録する。本番向けにはホスト依存を流用しない。

## サービスとデータ初期化

| サービス | 起動方式 | 内容 |
|---|---|---|
| `frontend` | 通常起動 | React + Vite。APIのhealthcheck成功後に起動 |
| `api` | 通常起動 | Hono、テーブル初期化、ローカルモックキューの定期処理 |
| `dynamodb` | 通常起動 | DynamoDB Local 3.3.2、イメージdigest固定、非公開ポート |
| `worker` | `tools` profile | モックまたは実GitHub/npm/AI監査の直接実行 |

API・CLIはテーブル `security-audit-jobs-local` を存在しなければ作成する。Localの起動待ちには上限付きの再試行を行う。DynamoDBは `-inMemory -sharedDb`。**DynamoDBコンテナの停止・再起動で全データを失う**。APIやFrontendのみの再起動では保持する。DynamoDBだけを再起動した場合は `docker compose restart api` でテーブルを再初期化する。現段階ではTTLを設定しない。

SQSエミュレーターは使わない。DynamoDBに保存された実行スロットを1秒ごとに確認し、待機ジョブをAPIプロセス内のモックWorkerへ渡す。API再起動時も待機ジョブを取得する。開始済みジョブは再実行せず、180秒の期限切れを検出すると失敗にする。実監査ジョブはdispatcherがclaimせず、CLIから実行する。

## 環境設定

Composeは以下を明示設定する。シェルのAWS認証情報や `.env` の秘密値はコンテナへ一括転送しない。

| 変数 | ローカルの値・用途 |
|---|---|
| `APP_ENV` | `local` |
| `NODE_ENV` | `development` |
| `AUTH_MODE` | 通常 `cognito`。回帰テスト時だけ明示 `local-bypass` |
| `LOCAL_AUTH_BYPASS` | 通常 `false`。`local-bypass` テスト時だけ `true` |
| `COGNITO_ISSUER` / `COGNITO_CLIENT_ID` / `COGNITO_LOGIN_URL` | dev Terraformの公開出力 |
| `ALLOWED_USER_SUB` | 管理者作成した本人ユーザーのUUID。メールアドレスは使用しない |
| `AUDIT_MODE` | `mock`（既定）または `audit`（実GitHub/npm） |
| `AI_MODE` | `mock`（既定）または `openai`。全体mockと実AIは組み合わせ不可 |
| `MOCK_OUTCOME` | `success`（既定）または `failure` |
| `DYNAMODB_ENDPOINT` | `http://dynamodb:8000` |
| `DYNAMODB_TABLE` | `security-audit-jobs-local` |

DynamoDB Local用のダミー認証情報はSDKクライアントで固定し、AWSの資格情報を探索しない。全体モックには外部キーは不要。実監査のGitHub認証は任意の `GITHUB_TOKEN`。実AIはWorkerだけに `OPENAI_API_KEY` と `OPENAI_HARD_LIMIT_CONFIRMED` を注入する。Frontend/APIはroot `.env` をread-onlyの `/dev/null` mountで隠し、キーを環境変数へ渡さない。Cognitoの公開識別子だけをAPI/Frontendへ渡す。

## Cognitoの設定と初回ログイン

既存 `.env` を維持したまま、以下を設定する。Issuer・Client ID・Login URLは `terraform -chdir=infra/terraform/environments/dev output` の該当値を使い、subは `node scripts/create-dev-user.ts --email <本人メール>` で確認する。これらは公開識別子で、APIキーやパスワードをVITE変数へ入れない。

```dotenv
AUTH_MODE=cognito
LOCAL_AUTH_BYPASS=false
COGNITO_ISSUER=https://cognito-idp.ap-northeast-1.amazonaws.com/<dev-pool-id>
COGNITO_CLIENT_ID=<dev-client-id>
COGNITO_LOGIN_URL=https://<dev-domain-prefix>.auth.ap-northeast-1.amazoncognito.com
ALLOWED_USER_SUB=<本人ユーザーのsub>
```

Composeを起動し、`http://localhost:5173` の「ログイン」から進む。初回の仮パスワードは3日有効。本パスワードへの変更と認証アプリのTOTP登録を完了し、監査画面へ戻ることを確認する。パスワードや認証コードを設定ファイル・ログへ保存しない。

トークンはメモリ保持のため、再読み込み後はログインボタンから再認証する。PKCE照合用の一時stateだけをsessionStorageに保存する。API 401・期限切れはログイン画面、403は許可外ユーザーの表示へ戻す。ログアウトはCognitoのセッションも終了する。

healthcheckは認証不要の `/healthz`。アプリの `/api/health` は認証・本人認可が必要で、トークンなしの401は正常。通常APIではID TokenやAuthorizationヘッダーでなく、検証対象のaccess tokenを `X-Access-Token` へ付ける。Frontendが自動で付けるため、手動でトークンをコピーしない。

失敗画面の確認：

```bash
MOCK_OUTCOME=failure docker compose up -d api
# 新しい監査を画面から開始し、FAILED / MOCK_FAILURE を確認する。
MOCK_OUTCOME=success docker compose up -d api
```

## 日常コマンド

```bash
docker compose logs -f frontend api
npm run typecheck
npm run lint
npm test
```

`npm run typecheck -w <workspace>` でも個別に検査できる。Reactは相対パス `/api/...` のみを使用し、Vite Proxyは `http://api:3000` へ転送する。CORSは開放しない。

Workerの直接実行：

```bash
docker compose run --rm worker \
  npm run audit:local -w workers/security-audit/app -- <job-id>
```

通常の所有者は `ALLOWED_USER_SUB`。APIもWorker CLIも同じCognito subを使い、従来の `local-user` データは自動移行しない。全体モックではAPIも同じ処理を実行するため、競合・完了済みジョブは処理を重複させない。実監査はCLIだけが実行する。CLIのモードは保存されたジョブと一致させる。不正設定・不存在・FAILED・未完了は非ゼロ終了。処理後の状態をJSON表示する。

既存IDは作成から180秒の期限内に実行する。実監査は次の作成・実行コマンドが使える。

## 実監査・AIの実行

まずAIモックで機械監査を検証する。

```bash
docker compose run --rm -e AUDIT_MODE=audit -e AI_MODE=mock worker \
  npm run audit:local -w workers/security-audit/app -- \
  --repository https://github.com/axios/axios
```

実AIを呼ぶ前に、Git管理外の `.env` へ以下を設定する。実キーを `.env.example` やドキュメントへ記載しない。

```dotenv
OPENAI_API_KEY=<専用Projectのキー>
OPENAI_HARD_LIMIT_CONFIRMED=true
```

`OPENAI_HARD_LIMIT_CONFIRMED` は、専用Projectで月額$10のHard spend limitを有効化した後にだけtrueへ設定する。[公式の設定手順](https://developers.openai.com/api/docs/guides/spend-limits)を参照し、通知だけのSpend alertと区別する。

```bash
docker compose run --rm -e AUDIT_MODE=audit -e AI_MODE=openai worker \
  npm run audit:local -w workers/security-audit/app -- \
  --repository https://github.com/axios/axios
```

このコマンドはジョブ作成の日次枠を消費する。出力されたjob IDを画面の `#/audits/<job-id>` で開くと、実際のSHA・npm結果・OpenAIレポートを確認できる。既存ジョブは末尾を `-- <job-id>` にする。

画面から実監査ジョブを作る場合：

```bash
AUDIT_MODE=audit AI_MODE=openai docker compose up -d api
# ブラウザーを再読み込みし、開始後のジョブIDをCLIへ渡す。
# 実行コマンドは詳細画面にも表示される。
AUDIT_MODE=mock AI_MODE=mock docker compose up -d api
```

API自身は実AIを呼ばず、キーも保持しない。既存のモック・実監査レポートは同じ履歴へ並び、各結果に種類を明示する。モードの変更は新規ジョブにだけ適用する。

`.local/ai-usage/` はWorkerが作成するホストの永続台帳。DynamoDBを停止してもAI予約回数は保持する。日次・月次の値、予約額、失敗後に返却しない理由、残留lockの扱いは[Worker仕様](../spec/local-worker.md)に一本化する。台帳を削除して制限をリセットしない。

## 統合・ブラウザー・ビルド検証

```bash
docker compose run --rm worker npm run test:integration
PLAYWRIGHT_BROWSERS_PATH=.playwright npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=.playwright npm run test:e2e
npm run build
npm run build:clean
```

統合テストはUUIDを含む専用Localテーブルを作成・削除する。通常のE2EはCognito構成のComposeを使用し、OIDC・API応答をブラウザー内でモックする。本人のパスワードや実Cognitoトークンは使用しない。従来のモック監査E2Eは、本人の実ログイン確認中でない専用の回帰テスト時間帯に、次の明示設定で実行する。
```bash
AUTH_MODE=local-bypass LOCAL_AUTH_BYPASS=true AUDIT_MODE=mock AI_MODE=mock docker compose up -d --wait api frontend
E2E_AUTH_MODE=local-bypass PLAYWRIGHT_BROWSERS_PATH=.playwright npm run test:e2e
AUTH_MODE=cognito LOCAL_AUTH_BYPASS=false docker compose up -d --wait api frontend
```

このモック監査E2Eは `local-user` の監査枠を1回消費する。bypassは開発ビルド・loopback・明示設定時だけに限定し、通常起動では使わない。ブラウザーのシステム依存が必要な場合はPlaywrightの案内に従う。

`build:clean` はホストの `node_modules`・既存 `dist`・秘密情報をコピーせず、一時ディレクトリで `npm ci` とビルドを実行する。出力は検証後に削除する。Lambda handlerはPhase 4で実DynamoDB/SQSへ接続する実装へ更新した。通常の `build` はAWS配布用ZIPではない。専用のクリーンビルド・検証は [AWS配布](aws-deployment.md) を参照する。npm監査用のComposeランタイムはPhase 2で確認済み。Lambdaのnpm配置・SQS処理は実装と公式コンテナでの検証まで進み、実AWS疎通は残る。

```bash
docker compose down
```

通常の停止でホストのソースと `node_modules` は削除されない。
