# 実装済みの確定仕様

このディレクトリには、実装・検証が完了して確定した仕様を記載する。未実装の要件・提案・実装手順は [実装計画](../plan/implementation-plan.md)、設計上の未確定事項は [decisions.md](../decisions.md) で管理する。

## 現在の状態

| 文書 | 範囲 |
|---|---|
| [ローカル基本仕様](local-basic.md) | Phase 1の画面・API・データ・Mock Worker・設定境界 |
| [Phase 1検証記録](phase1-verification.md) | 実行した検証、結果、未確認事項 |
| [ローカルWorker仕様](local-worker.md) | Phase 2のGitHub・npm・AI・予算・状態契約 |
| [Phase 2検証記録](phase2-verification.md) | 実API・自動テスト・画面確認の結果 |
| [Terraform準備の検証記録](terraform-preparation.md) | dev基盤の部分適用・CloudFront修正・再apply前の検証 |
| [dev初期ユーザー作成](dev-user-bootstrap.md) | 読み取り既定のCLI・作成条件・再実行時の保持・検証範囲 |
| [Cognito認証](cognito-auth.md) | ReactのPKCE、HonoのJWT・本人認可、ローカル所有者、検証結果 |
| [AWS runtime](aws-runtime.md) | Lambda/SQS・分散予算・Secret・成果物の契約 |
| [Phase 4 AWS検証記録](phase4-verification.md) | dev配布・公開HTTP/認証経路・実サービスの検証結果と限界 |

Cognito認証はローカルへ実装し、本人の初回TOTP登録・ログアウト・再ログイン時のTOTP要求・監査画面への復帰を確認済み。Lambda・SQSをdevへ反映しFrontendも配布済み。公開HTTP経路を確認し、本人のAIモック監査もAWS上で完了。実Secret・実AI等の検証は残る。以前の5分野の計画は引き続き実装計画で管理する。

## 記載する内容

- 対象機能と、実装された実際の動作。
- 確定したAPI・データ・設定の契約。
- 実装上の制約と対応範囲。
- 関係する実装ファイルと、検証結果・テストなどの確認根拠。

機能の実装・検証後に用途別の文書を追加する。一部だけ実装済みの場合は対象範囲を明記し、未実装部分を確定仕様に含めない。仕様変更時は実装・検証結果と文書を整合させ、実装計画と関係するガイドも更新する。
