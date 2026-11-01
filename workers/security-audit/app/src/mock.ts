import type { Audit, CompletedAudit } from '@repo-sentinel/core'

export function mockResult(audit: Extract<Audit, { status: 'RUNNING' }>): CompletedAudit {
  return {
    ...audit, status: 'COMPLETED', finishedAt: new Date().toISOString(),
    commitSha: '0'.repeat(40),
    summary: { critical: 0, high: 1, moderate: 1, low: 0, info: 0 },
    findings: [
      { package: 'mock-parser', title: 'モック：入力処理の問題', severity: 'high', range: '<2.0.0', fixAvailable: true, advisoryUrl: 'https://example.com/mock/parser' },
      { package: 'mock-template', title: 'モック：テンプレート処理の問題', severity: 'moderate', range: '<3.0.0', fixAvailable: false, advisoryUrl: 'https://example.com/mock/template' },
    ],
    report: {
      overallAssessment: 'これは動作確認用のモックレポートです。実際の安全性を評価した結果ではありません。',
      summary: 'サンプルとして high 1件、moderate 1件を表示しています。',
      priorities: ['サンプルの mock-parser を優先確認します。'],
      impacts: ['入力処理・テンプレート処理への影響を仮定したサンプルです。'],
      recommendations: ['実監査を導入した後、検出結果と依存関係の利用箇所を確認してください。'],
      limitations: ['GitHub、npm Registry、OpenAI APIには接続していません。', 'コミットSHA・パッケージ名・件数・説明は架空の固定データです。'],
    },
  }
}
