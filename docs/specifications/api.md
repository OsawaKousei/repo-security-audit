# API仕様

APIはHonoで実装し、ベースパスを `/api` とする。配置先は `api/app`。ローカルサーバーとLambdaエントリーポイントを分け、同じアプリ定義を使用する。

## 共通契約

- 全APIにCognito JWT検証と許可ユーザー認可を適用する。
- 認証の検証項目は[セキュリティ要件](../security.md)に従う。
- 要求・応答はZodで定義し、`packages/core` を通じてFrontend・APIで共有する。
- 監査対象URLと `owner/repo` を検証し、任意URLのバックエンド取得を認めない。
- 対象ユーザーは検証済みJWTの `sub` を基準に扱う。

CloudFrontはFunction URLへSigV4署名するため、JWTは `X-Access-Token` などの専用ヘッダーで転送する。POSTは `x-amz-content-sha256` を設定する。専用ヘッダー名の確定、ボディハッシュの生成、CloudFront転送ポリシーの整合は実装前に[未確定事項](../decisions.md)を解消する。

## エンドポイント

| Method | Path | 用途 |
|---|---|---|
| POST | `/api/audits` | 監査ジョブ作成 |
| GET | `/api/audits` | 監査履歴取得 |
| GET | `/api/audits/:id` | 状態・結果取得 |

## 監査ジョブ作成

`POST /api/audits`

```json
{
  "repositoryUrl": "https://github.com/example/project"
}
```

処理順序：

1. JWTと許可ユーザーを検証する。
2. 入力URLを検証する。
3. 実行回数制限を検証する。同時リクエストで上限を突破できないようにする。
4. DynamoDBに `PENDING` ジョブを作る。
5. SQSへジョブIDを送る。ローカルはモックに置き換える。
6. `202 Accepted` を返す。

```json
{
  "jobId": "01EXAMPLE...",
  "status": "PENDING"
}
```

同時監査の実行ロックと回数制限の整合は[データ設計](data-model.md)に従う。ジョブ保存とキュー送信の片方だけが成功した場合の処理は未確定。

## 監査履歴取得

`GET /api/audits`

認可されたユーザーの監査履歴を返す。画面には監査日時、リポジトリ名、状態、検出件数、詳細への遷移情報が必要。DynamoDBのULIDを利用し時系列で取得する。

要求クエリー、並び順、ページサイズ、継続トークン、応答エンベロープは原文に定義されていない。Zod契約の確定前に[未確定事項](../decisions.md)で決める。

## ジョブ状態・結果取得

`GET /api/audits/:id`

基本仕様の完了時レスポンス例：

```json
{
  "jobId": "01EXAMPLE...",
  "repository": "example/project",
  "status": "COMPLETED",
  "createdAt": "2026-11-01T01:00:00Z",
  "finishedAt": "2026-11-01T01:00:35Z",
  "summary": {
    "critical": 0,
    "high": 2,
    "moderate": 3,
    "low": 1
  },
  "report": {
    "overallAssessment": "...",
    "summary": "...",
    "priorities": [],
    "recommendations": [],
    "limitations": []
  }
}
```

例は完全な確定スキーマではない。結果画面で必要な `commitSha`、想定影響の表現、`findings` の公開範囲、処理中・失敗時のフィールド有無を正式なZod契約で定義する。AIレポートの要件は[AIレポート仕様](ai-report.md)を参照する。

## エラー・制限

未認証、未許可ユーザー、不正入力、利用上限、対象ジョブなし、キュー送信失敗などを扱う。HTTPステータス、エラー応答形式、具体的なコードは未定義であり、実装時に契約として定義する。

日次上限・同時実行制限をFrontendの制御だけに依存させない。APIキャッシュはCloudFrontで無効化する。初期Phase 1以外の認証例外を作らない。
