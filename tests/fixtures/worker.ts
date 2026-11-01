import type { MachineResult } from '@repo-sentinel/core'

export const manifest = { name: 'audit-fixture', version: '1.0.0', dependencies: { 'demo-lib': '1.0.0' }, scripts: { preinstall: 'do-not-run' }, config: { registry: 'https://evil.example' } }
export const lockfile = {
  name: 'audit-fixture', version: '1.0.0', lockfileVersion: 3,
  packages: {
    '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
    'node_modules/demo-lib': { version: '1.0.0', resolved: 'https://registry.npmjs.org/demo-lib/-/demo-lib-1.0.0.tgz' },
  },
}
export const auditOutput = {
  auditReportVersion: 2,
  vulnerabilities: { 'demo-lib': {
    name: 'demo-lib', severity: 'high', range: '<2.0.0',
    via: [{ source: 1, title: 'Demo advisory', url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz', severity: 'high', range: '<2.0.0' }],
    fixAvailable: { name: 'parent-lib', version: '3.0.0', isSemVerMajor: true },
  } },
  metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 0, info: 0, total: 1 } },
}
export const machine: MachineResult = {
  commitSha: 'a'.repeat(40), summary: { critical: 0, high: 1, moderate: 0, low: 0, info: 0 },
  findings: [{ package: 'demo-lib', title: 'Demo advisory', severity: 'high', range: '<2.0.0', fixAvailable: true, advisoryUrl: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz', fixPackage: 'parent-lib', fixVersion: '3.0.0' }],
}
export const aiOutput = {
  overallAssessment: 'review_required', summary: '依存関係の利用箇所を確認する必要があります。', priorities: [0],
  impacts: [{ findingIndex: 0, explanation: '利用方法によって可用性に影響する可能性があります。' }],
  recommendations: [{ findingIndex: 0, explanation: '修正候補と利用箇所を確認してください。' }],
  limitations: ['ソースコード全体の安全性を評価するものではありません。'],
}
