# ローカル開発環境

Phase 1のローカルモック構成を実装済み。動作契約は[確定仕様](../spec/local-basic.md)、検証実績は[検証記録](../spec/phase1-verification.md)を参照する。

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

ブラウザーで <http://localhost:5173> を開く。APIはloopbackの3000番ポート、Frontendは5173番ポートで公開する。コンテナ内の待受は `0.0.0.0`。認証を省略するPhase 1のため、外部公開用にポート・Proxy設定を変更しない。

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
| `worker` | `tools` profile | 同じモック処理本体の直接実行 |

API・CLIはテーブル `security-audit-jobs-local` を存在しなければ作成する。Localの起動待ちには上限付きの再試行を行う。DynamoDBは `-inMemory -sharedDb`。**DynamoDBコンテナの停止・再起動で全データを失う**。APIやFrontendのみの再起動では保持する。DynamoDBだけを再起動した場合は `docker compose restart api` でテーブルを再初期化する。現段階ではTTLを設定しない。

SQSエミュレーターは使わない。DynamoDBに保存された実行スロットを1秒ごとに確認し、待機ジョブをAPIプロセス内のモックWorkerへ渡す。API再起動時も待機ジョブを取得する。開始済みジョブは再実行せず、180秒の期限切れを検出すると失敗にする。

## 環境設定

Composeは以下を明示設定する。シェルのAWS認証情報や `.env` の秘密値はコンテナへ一括転送しない。

| 変数 | Phase 1の値・用途 |
|---|---|
| `APP_ENV` | `local` |
| `NODE_ENV` | `development` |
| `LOCAL_AUTH_BYPASS` | `true`。ローカルエントリーポイントだけが受け付ける |
| `AUDIT_MODE` | `mock` のみ。実監査モードは未実装 |
| `MOCK_OUTCOME` | `success`（既定）または `failure` |
| `DYNAMODB_ENDPOINT` | `http://dynamodb:8000` |
| `DYNAMODB_TABLE` | `security-audit-jobs-local` |

DynamoDB Local用のダミー認証情報はSDKクライアントで固定し、AWSの資格情報を探索しない。Cognito・GitHub・OpenAIのキーは不要。実認証・実API用の設定は後続Phaseで定義する。

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

所有者はPhase 1の固定 `local-user`。APIも同じモック処理を実行するため、競合・完了済みジョブは処理を重複させない。不存在のIDは非ゼロ終了する。成功時は保存された状態をJSON表示する。

## 統合・ブラウザー・ビルド検証

```bash
docker compose run --rm worker npm run test:integration
npx playwright install chromium
npm run test:e2e
npm run build
npm run build:clean
```

統合テストはUUIDを含む専用Localテーブルを作成・削除する。E2Eは起動済みComposeを使用し、ローカルユーザーの監査枠を1回消費する。ブラウザーのシステム依存が必要な場合はPlaywrightの案内に従う。

`build:clean` はホストの `node_modules`・既存 `dist`・秘密情報をコピーせず、一時ディレクトリで `npm ci` とビルドを実行する。出力は検証後に削除する。APIの `dist/lambda.js` は認証未実装のため拒否するスタブであり、AWSデプロイ成果物の完成を意味しない。npm監査用ランタイム・SQS・Lambdaの実統合は後続Phaseで検証する。

```bash
docker compose down
```

通常の停止でホストのソースと `node_modules` は削除されない。
