# リポジトリ構成

## 現在の状態

2026-11-01時点では次の雛形が存在する。

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

Dockerfileと `docker-compose.yaml` は空であり、アプリケーション、npm workspaces、開発スクリプトは未実装。今回の文書整理では雛形の移動や実装は行わない。

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

このツリーは既存の配置を維持した実装目標であり、全ファイルの作成済みを意味しない。`src/` や `infra/terraform/` などの詳細は今後作成する。ルートREADMEは将来のセットアップ入口とし、現在の仕様入口は [docs/README.md](../README.md) とする。

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

`node_modules` と秘密情報を含む環境変数ファイルをGit管理から除外する設定は、環境初期化時に追加する。現在の `.gitignore` は `docs/plan/` の除外のみである。
