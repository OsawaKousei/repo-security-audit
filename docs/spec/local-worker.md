# Phase 2：Workerのローカル実装

Phase 3で変更した認証・所有者・Lambda認可の契約は [Cognito仕様](cognito-auth.md) を参照する。以下のPhase 1/2時点の記録を優先しない。

2026-11-01に実装・検証。実行・環境設定は[ローカル開発](../dev/local-development.md)、確認結果は[Phase 2検証記録](phase2-verification.md)を参照する。本書は[Phase 1仕様](local-basic.md)に対する追加・変更契約。Cognito、実SQS、Worker Lambda、AWSデプロイは後続Phase。

## 実行モードとジョブ

`AUDIT_MODE=mock` は従来の全体モック、`AUDIT_MODE=audit` は実GitHub・npm監査。`AI_MODE=mock` は機械監査に基づく固定説明、`AI_MODE=openai` は実Responses API。全体モックと実AIの組み合わせは拒否する。

保存データ・公開型に `mode: mock|audit` と任意の `aiMode: mock|openai` を追加した。従来の `aiMode` 欠損ジョブはmockとして扱う。APIがジョブ作成時にサーバー設定を保存し、クライアントによるモード・モデル選択は受け付けない。Workerは自身の設定と保存済みジョブのモードが一致する場合だけ実行する。

`createAuditRunner(store, options)` の処理本体 `runAudit(jobId, ownerSub)` はLambda・SQS・HTTPイベントに依存しない。CLIは既存IDの実行と `--repository <GitHub URL>` による作成・直接実行を提供する。所有者はPhase 1と同じ固定 `local-user`。作成には既存の日次5回・全体同時1件のトランザクションを使う。

APIのdispatcherは実監査を自動実行しない。実監査の期限切れだけを検出する。待機ジョブはCLIから実行する。CLIのみでも期限切れのPENDING/RUNNINGをFAILEDへ確定できる。既存のRUNNINGや終端ジョブを再実行しない。

## GitHubスナップショット

1. 共有URLスキーマで保存済み `owner/repo` も再検証する。
2. `https://api.github.com/repos/{owner}/{repo}` で公開状態とデフォルトブランチを取得する。privateは拒否。
3. デフォルトブランチのコミットSHAとツリーSHAを確定する。
4. そのルートツリーにある `package.json` と `package-lock.json` のblob SHAを取得する。
5. 確定ツリーのblob SHAで両ファイルを取得する。別時点のブランチを参照しない。

取得先は組み立てたGitHub APIの固定ホストだけ。リダイレクトと応答内のdownload URLは追跡しない。通常ファイルmodeだけを認め、symlink・submodule・ディレクトリを拒否する。GitHub tokenは任意で、公開リポジトリのAPI制限に対する認証にだけ使用する。privateを監査可能にはしない。

Git treeとblobの識別子をAPI呼び出しに使用する。APIエラー本文や認証ヘッダーをログ・結果へ保存しない。

## 外部ファイルとnpmの隔離

lockfileVersion 2/3のルートnpmプロジェクトに対応する。workspaces、リンク依存、git/URL/file/workspace依存、npm Registry以外のresolved URLは未対応として拒否する。マニフェストとlockのルート依存関係が一致することを確認する。

作成した一時ディレクトリへ両ファイルを置く。npmへ渡すマニフェストからscripts・config・overrides等を除外し、監査に必要なname/version/依存定義だけを残す。対象の `.npmrc` は取得しない。

```bash
npm audit --json --package-lock-only --ignore-scripts \
  --registry=https://registry.npmjs.org \
  --fetch-retries=0 --fetch-timeout=20000 --no-fund --workspaces=false
```

`execFile` を `shell:false` で起動し、入力からコマンド文字列を生成しない。子プロセスの環境はPATH・一時HOME・空のユーザー/global npm設定・一時cacheに限定し、API鍵・GitHub token・ホストnpm設定・NODE_OPTIONSを継承しない。依存インストール・監査対象コード・npmスクリプト・audit fixは実行しない。一時ディレクトリは成功・失敗の双方で削除する。

[公式npm audit仕様](https://docs.npmjs.com/cli/v11/commands/npm-audit/)に従い、脆弱性がある場合の非ゼロ終了を処理失敗と同一視しない。有効な監査JSONを検証し、タイムアウト・子プロセス起動失敗・出力超過・不正JSON・Registryエラーを失敗として扱う。npm内部のBulk/Quick Auditは固定npm Registryに接続する。

## 正規化と保存

npm auditの `auditReportVersion:2` を検証する。`findings` は脆弱性を持つパッケージ単位であり、アドバイザリ単位ではない。`critical/high/moderate/low/info` の件数を正規化結果から再計算し、npmのmetadata件数と照合する。参照URLはHTTPSのgithub.com・npmjs.com・www.npmjs.comを保存し、それ以外は不正出力として扱う。間接的な脆弱性は `via` の参照をたどってアドバイザリを保存し、循環・欠損参照だけで根拠が得られない場合は拒否する。

既存属性に次を追加した。

| 属性 | 意味 |
|---|---|
| `fixPackage` / `fixVersion` | npmの修正提案が対象とするパッケージとバージョン。値がなければnull |
| `fixIsSemVerMajor` | npmが示す破壊的変更候補 |
| `advisories` | 根拠となるtitle/url/severity/rangeの一覧 |
| `viaPackages` | 間接的な脆弱性の参照先 |

npmの修正候補が親依存やダウングレードを指す場合も、その対象名・値を保持する。検出パッケージ自体の修正済みバージョンと断定しない。

機械監査完了後に `RUNNING.machine={commitSha,summary,findings}` を条件付き保存する。AI前に `aiAttemptedAt` と `aiModel` をRUNNING・未記録条件で保存する。記録・予算予約に失敗した場合はAIを呼ばない。

成功時は従来どおりCOMPLETEDへ平坦化した機械結果とreportを保存する。AI失敗時はFAILEDにも `machine` とAI記録を残し、画面で機械監査の根拠を確認できる。機械監査自体が失敗した場合はAIを呼ばず、根拠のないレポートを生成しない。

## AI契約と事実の照合

Responses APIをHTTPSで一度だけ呼ぶ。モデルはサーバー側の `gpt-5.6-luna` に固定し、reasoning effortはnone。toolsを渡さず、`store:false`。失敗・429・タイムアウト・応答読取失敗を自動再試行しない。

入力はrepository・commitSha・監査日時・正規化したfindings・summaryに限定する。任意ソースコードやAPI鍵を渡さない。外部文字列は命令ではなくデータとして扱うよう固定プロンプトで指定する。

共有型から生成した厳格JSON Schemaを `text.format` へ渡す。[公式Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)に従い、schema適合とは別に拒否・不完全応答・事実整合を検証する。

AIの内部出力は総合判定、説明、優先度のfinding index、影響・推奨のfinding indexと説明、限界の配列。以下を検証して公開用の6項目レポートへ変換する。

- 総合判定は機械検出の有無と一致する。
- すべての参照indexが実在し、優先順位の参照は重複しない。
- 検出ありなら優先・影響・推奨を持ち、検出なしなら空にする。
- 自由説明にはASCII数字、CVE/GHSA識別子、URLを認めない。新しいバージョン・件数・識別子の生成を抑制する。
- 件数・パッケージ参照・修正提案はサーバーが機械監査結果から差し込む。AIによる新たな検出結果の追加は認めない。

自然言語の意味すべてを機械的に証明する仕組みではない。想定影響は仮説として表示し、コード全体の安全性や悪用可能性を確定しない。

## 上限と終了条件

値は `workers/security-audit/app/src/limits.ts` に固定する。

| 処理 | 上限 |
|---|---|
| GitHub要求 | 各10秒、メタデータ256KiB |
| package.json / package-lock.json | 256KiB / 2MiB |
| lock内パッケージ数 / 正規化findings | 20,000 / 200 |
| npm audit | 60秒、stdout/stderrそれぞれ2MiB、超過時強制終了 |
| AI入力 / 要求全体 / 応答 | 32,000 / 64,000 / 131,072バイト |
| AI呼び出し / 出力 | 60秒 / 2,048トークン |
| 機械結果保存 / 最終結果保存 | JSONで250KiB / 350KiB |
| ジョブ | 既存の作成から180秒リース、処理本体は最大170秒かつリース5秒前まで |

GitHubはメタデータ・コミット・ツリー・並列blob取得の順。通常の上限配分はGitHub約40秒＋npm60秒＋AI60秒で、保存の余裕を残す。既存IDを手動実行するまでの待ち時間もリースを消費する。

AI開始後の成否が不明な場合も、同じジョブを再実行しない。期限切れはJOB_TIMEOUTへ確定する。別ジョブを開始する場合も日次・月次制限を使う。実SQS再配信・Lambdaタイムアウト・分散リース延長はPhase 4で検証する。

## 費用台帳と秘密情報

専用Projectの月額$10 Hard spend limit設定済みとの利用者回答を確認してから実APIを検証した。管理画面や管理APIによる設定値の独立検証、上限到達試験は行っていない。通知と強制停止は[公式Spend limits](https://developers.openai.com/api/docs/guides/spend-limits)のとおり区別し、`OPENAI_HARD_LIMIT_CONFIRMED=true` を実AIの起動条件にする。

アプリ側はGit管理外の `.local/ai-usage/budget.json` に呼び出し前の予約を永続化する。UTC日次5回、月次$10、1ジョブにつき$0.05を保守的に予約し、失敗しても返却しない。同じowner/job IDを再予約しない。DynamoDB Localを再起動しても台帳は残る。

[固定モデルの公表料金](https://developers.openai.com/api/docs/models/gpt-5.6-luna)は2026-11-01確認時に入力$0.20・出力$1.20/百万トークン。入力64KB全体を保守的に数え、cache書込割増を考慮しても予約額に余裕を持たせる。予約額は実請求額ではない。モデルや料金・上限変更時は再評価する。

排他的なlockファイルを取得し、検証済み台帳を一時ファイルへ書いてfsync、rename、ディレクトリfsyncの順で保存する。破損・ロック競合・残留lock・保存失敗では呼び出しを止める。クラッシュ後の残留lockは動作中Workerがないことを確認してから調査し、予算台帳自体を削除して制限をリセットしない。複数ホストやAWSでこのローカル台帳を共有することは未対応。

Composeは `.env` のOpenAIキーと任意のGitHub tokenをWorkerにだけ環境変数として渡す。Frontend/APIはキーを注入せず、root `.env` を `/dev/null` のread-only mountで隠す。セットアップ時は `.env` を所有者だけが読み書きできる権限にする。CLIの失敗ログはエラーコードだけにし、鍵・ヘッダー・上流の生エラー本文を出力しない。
