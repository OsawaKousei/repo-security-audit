# ドキュメント一覧

Repo Sentinelの実装・開発・検証のための仕様を用途別にまとめる。入口はルートの[AGENT.md](../AGENT.md)と本書とする。

## 読み方

| 目的 | 文書 |
|---|---|
| 目的・対象範囲・採用技術を把握する | [プロジェクト概要](overview.md) |
| AWSとローカルの全体構成を理解する | [アーキテクチャ](architecture.md) |
| コードの配置先と現在の雛形を確認する | [リポジトリ構成](development/repository.md) |
| ローカル環境・依存関係・Composeを扱う | [ローカル開発](development/local-development.md) |
| 実装順序・日常開発・変更時の確認を知る | [開発ワークフロー](development/workflow.md) |
| 画面・表示・ポーリングを実装する | [フロントエンド仕様](specifications/frontend.md) |
| エンドポイントと入出力を実装する | [API仕様](specifications/api.md) |
| DynamoDB・状態・冪等性を実装する | [データ設計](specifications/data-model.md) |
| GitHub取得・npm監査・SQS処理を実装する | [Worker仕様](specifications/worker.md) |
| AI入力・レポート・出力検証を実装する | [AIレポート仕様](specifications/ai-report.md) |
| 認証・外部入力・秘密情報・費用を扱う | [セキュリティ要件](security.md) |
| Terraform・AWS配信・環境分離・監視を扱う | [インフラ・運用](infrastructure/terraform.md) |
| テスト・受け入れ条件を確認する | [検証計画](testing.md) |
| 未定義の値や設計上の未確定点を確認する | [未確定事項](decisions.md) |

詳細要件は表の担当文書に置き、他の文書から参照する。同じ数値・契約を複数箇所で独立して管理しない。

## 原文と優先順位

基準となる原文は次の2文書。今回の整理では原文を変更しない。

1. [ローカル開発環境変更要件書 v1.0.0](plan/additional-spec.md)
2. [基本仕様書 v0.1.0](plan/spec.md)

競合時は変更要件書を優先する。明示的な変更以外の認証・API・監査・AI・AWS・セキュリティ要件は基本仕様書を引き継ぐ。以後、仕様を変更するときは該当する担当文書と必要な参照を同時に更新する。

ユーザーの明示的な指示により、リポジトリ構成は現行を正とする。原文の `apps/*` と `compose.yaml` の配置例は採用せず、[リポジトリ構成](development/repository.md)の配置とコマンドを優先する。

`docs/plan/` は現在の `.gitignore` で除外されている原文の保管場所である。分割文書はこのディレクトリの外に置き、原文なしでも要件を読めるようにする。原文へのリンクは当ワークスペース内の参照用であり、Gitから新規取得した環境では存在しない場合がある。

## 文書の状態

- 本文の要件は実装目標であり、実装完了を意味しない。
- 2026-11-01時点のコードは空のDockerfileとComposeファイルを中心とした雛形。npm設定、アプリ、Terraform、テストは未実装。
- コマンド・設定例は構築後の目標を示す。現時点で実行できる手順として扱わない。
- 未定義の数値や不完全な契約は[未確定事項](decisions.md)に集約する。例示値を暗黙に仕様へ昇格させない。

## 原文との対応表

| 原文 | 主な分割先 |
|---|---|
| 基本 §1 目的・範囲、§2 技術選定 | [概要](overview.md) |
| 基本 §3 システム構成 | [アーキテクチャ](architecture.md) |
| 基本 §4.1 認証、§8 セキュリティ | [セキュリティ](security.md) |
| 基本 §4.2 リポジトリ、§4.3 機械監査、§7 非同期 | [Worker](specifications/worker.md) |
| 基本 §4.4 AI | [AIレポート](specifications/ai-report.md) |
| 基本 §4.5 フロントエンド | [フロントエンド](specifications/frontend.md) |
| 基本 §5 API | [API](specifications/api.md) |
| 基本 §6 データ・冪等性 | [データ設計](specifications/data-model.md) |
| 基本 §9 ローカル、変更 §1–6・§9 | [ローカル開発](development/local-development.md) |
| 基本 §10 ディレクトリ、変更 §2–3 | [リポジトリ構成](development/repository.md) |
| 基本 §11 Terraform、変更 §8 デプロイ | [インフラ・運用](infrastructure/terraform.md) |
| 基本 §12 開発手順、§13 ライフサイクル、変更 §7 | [開発ワークフロー](development/workflow.md) |
| 基本 §14 完了条件、変更 §10 受け入れ条件 | [検証計画](testing.md) |
| 基本 §15 将来拡張、§16 原則、変更 §11 | [概要](overview.md) |
| 変更 §12 適用方針 | 本書の優先順位 |
