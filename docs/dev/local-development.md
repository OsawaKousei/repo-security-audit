# ローカル開発環境

本書は[実装計画](../plan/implementation-plan.md#local-development)を補足する開発ガイドであり、実装済み仕様ではない。コマンド・設定は[リポジトリ構成](repository.md)に従った環境の実装後に利用する。現時点ではnpmスクリプト・Composeサービスは未実装。

## ホストとコンテナの責務

UbuntuホストでVS CodeとCodex拡張機能を実行し、モノレポルートを単一ワークスペースとして開く。

| 処理 | 実行場所 |
|---|---|
| 編集、Codexの変更、Git操作 | ホスト |
| npm依存管理、TypeScript型チェック、ESLint、単体テスト | ホスト |
| Terraform検証・Plan・操作 | ホスト |
| Frontend・API開発サーバー | Composeコンテナ |
| Workerの監査処理 | 必要時にComposeコンテナで直接実行 |
| DynamoDB Local | Composeコンテナ |
| AWSサービス間の統合テスト | AWS dev |

コンテナごとにIDEやCodexを起動しない。VS Code Remote Containersへの個別接続は必須としない。コンテナ内の操作が必要ならホストから `docker compose exec` または `docker compose run` を使う。

## Node.jsと依存関係

- ホストのNode.jsはfnmで切り替え、ルート `.node-version` に定義する。
- 開発コンテナの公式Node.jsイメージも同一バージョンにする。可能な限りパッチバージョンまで一致させる。
- AWS Lambda対応LTSを選ぶ。変更要件の `node:24-bookworm-slim` は設定例であり、確定バージョンは[未確定事項](../decisions.md)を解決して固定する。
- npm workspacesを維持し、ルートに単一の `package-lock.json` を置く。
- 依存関係はホストでインストールし、ルート `node_modules` をbind mount経由で共有する。
- 通常構成では `node_modules` 用の名前付きVolumeやコンテナ別インストールを使わない。
- `node_modules` をGit管理対象から除外する。

依存関係の復元と追加：

```bash
npm ci
npm install <package> -w frontend/app
npm install <package> -w api/app
npm install <package> -w workers/security-audit/app
```

`npm ci` には既存のルート `package.json` と整合した `package-lock.json` が必要。初期化フェーズでは先にworkspace定義とロックファイルを生成する。

## ネイティブ依存関係

ホストとコンテナのCPUアーキテクチャ・Node.jsを一致させる。ただしLinuxディストリビューションや共有ライブラリの差により、共有 `node_modules` のネイティブモジュールが動作しない場合がある。

互換性エラーを検出した場合は、開発イメージをホストの環境に近付けるか、例外としてコンテナ側の依存関係を分離する。通常の共有方針を変えるときは理由・手順を本書へ反映する。共有方式がすべてのネイティブモジュールの互換性を保証するとは扱わない。

AWS向け成果物では、ローカルの依存関係を流用せず、対象Lambdaランタイムに適合するクリーン環境で再インストールする。

## Composeサービス

| サービス | 内容 | 起動方式 |
|---|---|---|
| `frontend` | React + Vite | 通常起動 |
| `api` | Hono開発サーバー | 通常起動 |
| `worker` | Worker処理本体の直接実行 | `tools` profile、必要時のみ |
| `dynamodb` | DynamoDB Local | 通常起動 |

SQSエミュレーターは導入しない。キューはローカルでモックし、実SQS・Lambda連携はAWS devで検証する。認証はAWS devのCognito User Poolを利用する。

以下は変更要件書の基本構成を現行のディレクトリに合わせた例。最終実装ではNode.jsの固定タグ、環境変数、各アプリの開発サーバー・スクリプトを整える。

```yaml
services:
  frontend:
    image: node:24-bookworm-slim
    working_dir: /workspace
    user: "${LOCAL_UID:-1000}:${LOCAL_GID:-1000}"
    volumes:
      - ./:/workspace
    command: npm run dev -w frontend/app -- --host 0.0.0.0
    ports:
      - "127.0.0.1:5173:5173"
    init: true

  api:
    image: node:24-bookworm-slim
    working_dir: /workspace
    user: "${LOCAL_UID:-1000}:${LOCAL_GID:-1000}"
    volumes:
      - ./:/workspace
    command: npm run dev -w api/app
    environment:
      NODE_ENV: development
      DYNAMODB_ENDPOINT: http://dynamodb:8000
      AWS_REGION: ap-northeast-1
      AWS_ACCESS_KEY_ID: local
      AWS_SECRET_ACCESS_KEY: local
    ports:
      - "127.0.0.1:3000:3000"
    depends_on:
      - dynamodb
    init: true

  worker:
    image: node:24-bookworm-slim
    working_dir: /workspace
    user: "${LOCAL_UID:-1000}:${LOCAL_GID:-1000}"
    volumes:
      - ./:/workspace
    profiles: [tools]
    environment:
      NODE_ENV: development
      DYNAMODB_ENDPOINT: http://dynamodb:8000
      AWS_REGION: ap-northeast-1
      AWS_ACCESS_KEY_ID: local
      AWS_SECRET_ACCESS_KEY: local
    command: node --version
    init: true

  dynamodb:
    image: amazon/dynamodb-local:latest
    command:
      - "-jar"
      - "DynamoDBLocal.jar"
      - "-sharedDb"
      - "-inMemory"
```

Frontend・API・Workerにルート全体を `/workspace` としてmountする。APIはコンテナ内の `0.0.0.0:3000` で待ち受ける。ホスト公開ポートはloopbackに限定する。ホストのUID/GIDが1000以外なら `LOCAL_UID` / `LOCAL_GID` をホストに合わせ、ファイル所有権の問題を避ける。

例のAWS認証情報 `local` はDynamoDB Local用のダミー値。Workerの実API接続に必要な秘密情報はGit管理外の環境変数ファイルなどで注入し、実キーを設定例へ書かない。例にはCognito設定、秘密情報注入、テーブル作成処理は含めていない。

例のDynamoDB Localは `-inMemory` で動く。停止後も監査履歴が残る構成ではない。永続化・初期化方法は[未確定事項](../decisions.md)で決める。

## FrontendとAPIの通信

Reactは環境に依存しない相対パス `/api/...` を利用する。ViteのProxy設定例：

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://api:3000",
        changeOrigin: true,
      },
    },
  },
});
```

AWSではCloudFrontが同じ `/api/*` をHono Lambdaへ転送する。

FrontendはVite HMR、APIは `tsx watch` などを利用する。bind mountしたホストの変更が即時反映され、両方のホットリロードが動作することを必須とする。

## 日常コマンド

セットアップ後、ホストから実行する。

```bash
npm ci
docker compose up -d
docker compose logs -f frontend api
```

型チェックもホストで実行する。

```bash
npm run typecheck -w frontend/app
npm run typecheck -w api/app
npm run typecheck -w workers/security-audit/app
```

WorkerはSQSを介さず、Composeから直接実行する。

```bash
docker compose run --rm worker \
  npm run audit:local -w workers/security-audit/app -- <job-id>
```

`audit:local` から共通の `runAudit(jobId, ownerSub)` を呼ぶ。所有者の解決方法、AIモック切り替え、秘密情報の設定名は[未確定事項](../decisions.md)で定義する。

停止：

```bash
docker compose down
```

通常の停止でホストのソースと `node_modules` は削除されない。DynamoDB Localのインメモリデータとは扱いが異なる。

## 実認証・実APIの使い分け

Frontend開発・単体テストではAIを呼ばないモックモードを使う。Local Auditは実GitHub・npm Registry・OpenAI接続を検証できるモードとする。まずAIモックで監査を検証してから実AIを接続する。

Cognito導入後はローカルでも実認証を基本とし、dev User Poolにlocalhost用Callback URLを登録する。初期段階のみ許される認証例外とAWS操作の確認は[開発ワークフロー](workflow.md)を参照する。
