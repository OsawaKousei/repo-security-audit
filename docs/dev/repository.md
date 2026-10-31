# リポジトリ構成

## 現在の状態

2026-11-01にPhase 1のローカル基本実装を追加した。トップレベルの配置は維持している。

```text
repo-security-audit/
├── api/
│   ├── app/
│   └── Dockerfile
├── frontend/
│   ├── app/
│   └── Dockerfile
├── workers/security-audit/
│   ├── app/
│   └── Dockerfile
├── packages/
│   ├── core/
│   └── aws/
├── infra/
├── docker-compose.yaml
└── docs/
```

`docker-compose.yaml`、3アプリ・2共通パッケージのnpm workspaces、開発・検証スクリプトを実装済み。開発では公式イメージを利用し、既存の空Dockerfileは使用しない。実行手順は[ローカル開発](local-development.md)、契約は[確定仕様](../spec/local-basic.md)を参照する。

## 現行構成を維持する実装方針

ユーザーの明示的な指示により、現行のディレクトリ構成を正とする。原文の `apps/*` への集約や `compose.yaml` への改名は行わない。既存の `app/` を各アプリのworkspaceルートとし、その下へアプリケーションを実装する。

```text
repo-security-audit/
├── AGENT.md
├── frontend/
│   ├── app/
│   │   ├── src/
│   │   ├── package.json
│   │   └── vite.config.ts
│   └── Dockerfile
├── api/
│   ├── app/
│   │   ├── src/
│   │   │   ├── app.ts
│   │   │   ├── routes/
│   │   │   ├── middleware/
│   │   │   ├── local.ts
│   │   │   └── lambda.ts
│   │   └── package.json
│   └── Dockerfile
├── workers/
│   └── security-audit/
│       ├── app/
│       │   ├── src/
│       │   │   ├── audit.ts
│       │   │   ├── github.ts
│       │   │   ├── npm-audit.ts
│       │   │   ├── ai-report.ts
│       │   │   ├── local.ts
│       │   │   └── lambda.ts
│       │   └── package.json
│       └── Dockerfile
├── packages/
│   ├── core/
│   │   ├── src/types/
│   │   ├── src/schemas/
│   │   └── package.json
│   └── aws/
│       ├── src/dynamodb.ts
│       ├── src/sqs.ts
│       └── package.json
├── infra/terraform/
│   ├── bootstrap/
│   ├── modules/
│   │   ├── frontend/
│   │   ├── api/
│   │   ├── worker/
│   │   ├── database/
│   │   ├── queue/
│   │   └── auth/
│   └── environments/
│       ├── dev/
│       └── prod/
├── scripts/
├── docs/
├── node_modules/              # ホストに配置、Git管理外
├── .node-version
├── docker-compose.yaml
├── package.json
├── package-lock.json
└── README.md
```

このツリーは全Phaseの配置目標であり、全ファイルの作成済みを意味しない。Phase 1では `workers/security-audit/app/src/audit.ts`・`mock.ts`・`local.ts`、`packages/core/src/index.ts`、`packages/aws/src/dynamodb.ts`・`local-config.ts`、`tests/`、`scripts/` を実装した。実GitHub・npm監査・AI・SQS・Worker Lambda・Terraformのファイルは後続Phase。セットアップ入口は[ルートREADME](../../README.md)、仕様入口は[docs/README.md](../README.md)。

## Workspaceと配置ルール

ルート `package.json` の基本形：

```json
{
  "name": "repo-sentinel",
  "private": true,
  "workspaces": [
    "frontend/app",
    "api/app",
    "workers/security-audit/app",
    "packages/*"
  ]
}
```

- 各アプリ・共通パッケージは自身の `package.json` に必要な依存関係を宣言する。
- ロックファイルはルートの `package-lock.json` に統一する。
- ホストのルート `node_modules` を開発コンテナへ共有する。
- `packages/core` は環境非依存の型・スキーマを置き、AWS SDK実装を持たせない。
- `packages/aws` はAWS SDKを使う実装を置く。
- 共通パッケージは必要最小限とし、PoCに不要な抽象化を追加しない。

## 初期化時の注意

Compose定義は既存の `docker-compose.yaml` を使用し、別名のファイルを追加して二重管理しない。Dockerfileが必要になるかは開発イメージ・本番パッケージ方式に合わせて判断する。空の既存Dockerfileがあることを理由に独自イメージを必須としない。

アプリごとのディレクトリに分かれていても、Composeのbind mountはリポジトリルート全体を維持する。共有 `node_modules` と `packages/*` を同時に参照するため、アプリの `app/` だけをmountする構成にはしない。Dockerfileで共通パッケージを含むイメージをビルドする場合も、ビルドコンテキストはリポジトリルートを基準にする。

`node_modules` と秘密情報を含む環境変数ファイルをGit管理から除外する設定は、環境初期化時に追加する。`docs/plan/` の実装計画はGit管理対象とする。
