# Phase 1：ローカルの基本実装

Phase 3で変更した認証・所有者・Lambda認可の契約は [Cognito仕様](cognito-auth.md) を参照する。以下のPhase 1/2時点の記録を優先しない。

対象はlocalhostでのFrontend → Hono API → DynamoDB Local → Mock Worker → レポート表示。2026-11-01に実装・検証。確認根拠は[検証記録](phase1-verification.md)。本書の契約はPhase 1に限定する。実認証・GitHub取得・npm audit・実AI・AWSキューは未実装。

Phase 2による追加・変更は[Worker仕様](local-worker.md)を優先する。本書はPhase 1実装時点の基本契約を記録する。

## 共有契約と画面

`packages/core/src/index.ts` のZodスキーマをFrontend・API・Worker・保存処理で共有する。画面は `#/`（開始）、`#/audits`（履歴）、`#/audits/:id`（詳細）。履歴の次ページは `#/audits?cursor=...`。

開始画面にはURL入力と実行中ジョブ、履歴には監査日時・リポジトリ・状態・検出件数・詳細リンクを表示する。結果には状態・日時・モックSHA・5段階の件数・検出情報・モックAIレポート・失敗コードを表示する。機械監査サンプルとAI説明サンプルを分け、架空のデータであることを明示する。

処理中の詳細・表示中の履歴は2.5秒間隔で取得し、完了・失敗で停止する。画面離脱時はタイマーと通信を中止する。通信タイムアウトは10秒。ネットワーク・5xxは連続3回失敗で停止し、手動再取得を表示する。4xxは即停止する。停止時は最後の取得内容とエラーを表示する。

## API

ローカルの所有者は固定 `local-user`。`Cache-Control: no-store` を付ける。JSON本文上限は4,096バイト。

| Method / Path | 契約 |
|---|---|
| `GET /api/health` | `200 {status:"ok",service:"repo-sentinel-api",mode:"mock"}` |
| `POST /api/audits` | `{repositoryUrl}` を受け、`202 {jobId,status:"PENDING"}` |
| `GET /api/audits` | `{items: Audit[], nextCursor?: string}` |
| `GET /api/audits/:id` | `200 Audit`。所有者のデータだけ取得 |

URLは `https://github.com/{owner}/{repository}`。前後空白を除去し、末尾 `/` と `.git` を正規化して `owner/repo` を保存する。任意ホスト、HTTP、認証情報、クエリー、fragment、追加パス、エンコードされたパス、空・`.`・`..` のリポジトリ名は拒否する。**Phase 1はURL形式だけを確認し、公開状態・実在・ファイルを取得しない**。

履歴はULIDの降順。`limit` は既定20、1〜50。`cursor` は最後に返したジョブIDのJSON文字列をbase64url化した継続値。主キーのユーザー部分は常にサーバーが設定し、cursorから取得しない。不正なクエリーとcursorは400。

全エラーは `{error:{code,message}}`。内部例外の内容を返さない。

| HTTP | code / ケース |
|---|---|
| 400 | `INVALID_INPUT`、`INVALID_CURSOR` |
| 401 | `UNAUTHORIZED`（認証なし、許可されないHost/Origin） |
| 404 | `NOT_FOUND`（不存在、別所有者、未知のAPI） |
| 409 | `AUDIT_IN_PROGRESS` |
| 413 | `BODY_TOO_LARGE` |
| 429 | `DAILY_LIMIT` |
| 503 | `DISPATCH_FAILED` |
| 500 | `INTERNAL_ERROR` |

## 状態別の公開型

共通属性は `jobId`（ULID）、`repository`、`mode:"mock"`、`createdAt`（UTC ISO日時）、`attemptCount`。

| status | 追加属性 |
|---|---|
| `PENDING` | なし。作成時の `attemptCount` は0 |
| `RUNNING` | `startedAt`。claim成功時だけ試行回数を1増加 |
| `COMPLETED` | `startedAt`, `finishedAt`, `commitSha`, `summary`, `findings`, `report` |
| `FAILED` | `finishedAt`, `errorCode`, 任意の `startedAt` |

未定義属性はスキーマで拒否する。`summary` は `critical/high/moderate/low/info` の非負整数。`findings` は `package/title/severity/range/fixAvailable/advisoryUrl`。`report` は文字列の `overallAssessment/summary` と文字列配列の `priorities/impacts/recommendations/limitations`。実npm結果の正規化・AI出力の事実照合はPhase 2。

## 保存と原子性

テーブルの初期化と設定は[ローカル開発](../dev/local-development.md)を参照する。AWS SDKは `packages/aws` に置く。

| データ | PK | SK |
|---|---|---|
| 監査 | `USER#{ownerSub}` | `AUDIT#{ULID}` |
| 日次回数 | `USER#{ownerSub}` | `USAGE#{YYYY-MM-DD}`（UTC） |
| 全体実行スロット | `SYSTEM` | `ACTIVE_AUDIT` |

監査の公開データはアイテムの `audit` 属性に保存する。PK/SK・日次回数・スロットはAPIへ公開しない。作成時は日次カウンター増加（上限5）・単一スロット取得・PENDING保存を1トランザクションで行う。拒否された要求は回数を消費せず、保存後に失敗した監査は消費したままとする。上限と実行中の両方に該当すると日次上限を優先する。

スロットには `ownerSub/jobId/leaseUntil` を保存する。リースは作成から180秒、Phase 1では延長しない。期限を過ぎても別ジョブが上書きせず、先行ジョブを `JOB_TIMEOUT` に確定させてから解放する。claimは `PENDING → RUNNING` の条件付き更新。完了はRUNNINGからだけ、失敗はPENDING/RUNNINGから遷移する。状態保存と所有者・ジョブ一致条件付きスロット削除をトランザクションで行う。

DynamoDBの400KB上限に余裕を残し、JSONで350KiB超の結果は保存前に拒否する。Workerは小さい `RESULT_TOO_LARGE` 失敗レコードを保存する。TTL・永続保持期限は未設定。

## Mock Workerと復旧

`createMockRunner(store)` が生成する `runAudit(jobId, ownerSub)` はHTTP・SQS・Lambdaに依存しない。APIのモックキューとCLIが同じ処理を呼ぶ。ローカルキューは実行スロットを1秒ごとに確認する。API再起動でPENDINGを再取得し、RUNNINGは再実行せず期限切れを失敗にする。

claim後3.5秒待機し、固定の検出2件（high 1、moderate 1）、ゼロ40桁のSHA、モックレポートを保存する。実外部API・有料処理は呼ばない。`MOCK_OUTCOME=failure` は `MOCK_FAILURE`。その他の処理例外は `WORKER_FAILED`。dispatch通知の失敗は `DISPATCH_FAILED` を保存し、APIは503を返す。通常のローカルキューではDynamoDB保存自体が通知となる。

同じジョブの重複呼び出しはclaimを通った1回だけ実行し、終端状態を書き換えない。保存先障害で失敗状態も保存できなかった場合はリースを保持し、DB復旧後に期限切れ処理を行う。実SQSの部分失敗・再試行方針はPhase 4で確定する。

## ローカル認証例外の境界

`local.ts` とCLIは `APP_ENV=local`・明示的認証省略・mock指定を要求し、production・Lambda環境変数・非ローカルDynamoDB・`-local` 以外のテーブルを拒否する。SDKはLocal用ダミー資格情報を固定する。

ローカルHTTPはHostをlocalhost・127.0.0.1・Compose内 `api` に限定する。ブラウザーOriginはlocalhost/127.0.0.1の5173/3000番だけを許し、cross-site要求を拒否する。Forwardedヘッダーは信頼せず、CORSは開放しない。Composeの公開先はloopbackに限定する。

アプリ定義は認可コールバック未指定時に拒否する。Lambdaエントリーポイントは503 `AUTH_NOT_CONFIGURED` を返すスタブで、ローカル認証省略を組み込まない。Cognito導入とAWS認可はPhase 3以降。ローカル構成を外部公開することは対応範囲に含めない。
