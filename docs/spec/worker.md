# Worker・機械監査仕様

## 処理本体とエントリーポイント

配置先は `workers/security-audit/app`。処理本体をLambdaに依存しない関数として実装する。

```typescript
async function runAudit(
  jobId: string,
  ownerSub: string
): Promise<void>
```

LambdaハンドラーはSQSイベントを処理本体へ変換し、ローカルエントリーポイントも同じ関数を呼ぶ。AWS固有のイベントを処理本体へ持ち込まない。

処理順序：

1. ジョブ取得。
2. 実行権限・所有者・状態の確認。
3. 実行ロック取得と条件付き状態更新。
4. GitHubから監査対象ファイル取得。
5. `npm audit` 実行。
6. 監査結果の正規化。
7. OpenAI API呼び出しと出力検証。
8. レポート保存。
9. ジョブ完了処理。

各処理に明示的なタイムアウトを設定する。状態・ロック・リースは[データ設計](data-model.md)、AIは[AIレポート仕様](ai-report.md)に従う。

## GitHubリポジトリの指定

入力形式：

```text
https://github.com/{owner}/{repository}
```

- 公開リポジトリのみ対象とする。
- GitHub APIでデフォルトブランチと最新コミットSHAを取得する。
- 取得したSHAのルート `package.json` と `package-lock.json` のみを監査する。
- ファイル取得時に同じSHAを使い、対象コミットを結果へ保存する。
- モノレポ内の個別ワークスペース、任意ブランチ・コミット指定には対応しない。
- GitHub以外の任意URLをバックエンドで取得しない。

`owner/repo` を検証し、各ファイルサイズと取得時間に上限を設定する。具体値、欠損・非対応lockfileの扱い、GitHub API認証方法は[未確定事項](../decisions.md)で確定する。

## npm audit

対象の2ファイルを一時ディレクトリに配置し、次を実行する。

```bash
npm audit --json --package-lock-only
```

監査対象リポジトリの依存パッケージはインストールしない。対象に対する `npm install`、`npm audit fix`、`npm run`、npmスクリプト、任意コード実行は禁止する。この制約は開発用workspace自身への依存追加とは区別する。

実行上の制約：

- 監査対象のnpm設定ファイルを実行環境へ適用しない。
- npm Registry接続先を固定する。
- 子プロセス実行にシェル展開を使わない。
- 実行時間・コマンド出力サイズに上限を設ける。
- 処理後は一時ファイルを削除する。
- 外部リポジトリの内容を信頼しない。

## 終了コードとエラー判定

脆弱性があると `npm audit` は正常なJSONを生成しても非ゼロ終了になる。終了コードだけで失敗と判定せず、JSON出力を解析する。

JSON生成・解析失敗、タイムアウト、npm Registry通信失敗などは監査エラーとする。監査成功で脆弱性が検出された場合は `COMPLETED` にできる。機械監査失敗時に根拠のないAIレポートを作らない。

## 正規化して保存する情報

- 依存パッケージ名。
- 検出された脆弱性。
- 深刻度。
- 影響を受けるバージョン。
- 修正可能性。
- アドバイザリ参照URL。
- 深刻度別の検出件数。

必要な情報へ正規化し、保存サイズを制限する。サマリー例の `critical` / `high` / `moderate` / `low` 以外の深刻度が出現する場合の扱いは、正式スキーマで決める。

## SQS・Lambda初期設定

| 項目 | 設定 |
|---|---|
| Queue Type | Standard |
| Batch Size | 1 |
| Worker Timeout | 180秒 |
| Visibility Timeout | 1,080秒 |
| DLQ | 有効 |
| `maxReceiveCount` | 2〜3（実装時に確定） |
| 同時監査ジョブ数 | 1件 |
| Worker Reserved Concurrency | 初期値2 |

Visibility TimeoutはWorker Timeoutの6倍を基準とする。Event Source Mappingの最大並列度を設定する場合はLambda設定と整合させる。

LambdaのReserved Concurrencyとは別に、アプリケーション側ジョブロックで有料AI処理を最大1件へ制限する。重複配信やリース切れを理由にAIを無制限に再試行しない。

SQSメッセージはジョブIDを送る要件がある一方、処理本体は `ownerSub` も必要とする。メッセージの完全なスキーマと所有者の解決方式は未確定。失敗の種類ごとのメッセージ再試行・削除・DLQ移動条件も定義する。

## ローカル実行

SQSを経由せず、ホストから次を実行する。

```bash
docker compose run --rm worker \
  npm run audit:local -w workers/security-audit/app -- <job-id>
```

実GitHub・npm Registry・OpenAIへ接続するLocal Auditと、AIを呼ばないモックモードを用意する。Frontend開発と単体テストはモックを使う。DynamoDBはDynamoDB Localを使う。CLIと秘密情報注入の前提は[ローカル開発](../development/local-development.md)を参照する。
