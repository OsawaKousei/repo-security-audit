import { describe, expect, it } from 'vitest'
import { normalizeAudit, validateProject } from '../../workers/security-audit/app/src/npm-audit.js'
import { auditOutput, lockfile, manifest } from '../fixtures/worker.js'

const clone = <T>(value: T): T => structuredClone(value)
describe('untrusted project validation', () => {
  it('strips target scripts and config from the manifest used by npm', () => {
    const files = validateProject(JSON.stringify(manifest), JSON.stringify(lockfile))
    expect(JSON.parse(files.packageJson)).toEqual({ name: manifest.name, version: manifest.version, dependencies: manifest.dependencies })
  })
  it.each(['https://evil.example/package.tgz', 'git+ssh://git@github.com/a/b', 'file:../../.env', 'workspace:*', 'github:a/b', '$(touch /tmp/injection)'])('rejects dependency spec %s', (spec) => {
    expect(() => validateProject(JSON.stringify({ ...manifest, dependencies: { 'demo-lib': spec } }), JSON.stringify(lockfile))).toThrow()
  })
  it('rejects foreign registries even in lockfile entries', () => {
    const lock = clone(lockfile); lock.packages['node_modules/demo-lib'].resolved = 'https://registry.npmjs.org.evil.example/demo.tgz'
    expect(() => validateProject(JSON.stringify(manifest), JSON.stringify(lock))).toThrow()
  })
  it('rejects missing or unsupported locks, workspaces, and inconsistent dependencies', () => {
    for (const [pkg, lock] of [
      [manifest, {}], [manifest, { ...lockfile, lockfileVersion: 1 }],
      [{ ...manifest, workspaces: ['packages/*'] }, lockfile],
      [{ ...manifest, dependencies: { 'demo-lib': '2.0.0' } }, lockfile],
    ]) expect(() => validateProject(JSON.stringify(pkg), JSON.stringify(lock))).toThrow()
  })
})
describe('npm audit normalization', () => {
  it('preserves evidence and the actual package targeted by an npm fix suggestion', () => {
    const result = normalizeAudit(auditOutput)
    expect(result.summary.high).toBe(1)
    expect(result.findings[0]).toMatchObject({ package: 'demo-lib', fixPackage: 'parent-lib', fixVersion: '3.0.0', fixIsSemVerMajor: true })
  })
  it('rejects audit errors, invalid JSON shape, and inconsistent counts', () => {
    for (const output of [{ error: { code: 'REGISTRY_DOWN' } }, {}, { ...auditOutput, error: {} }, { ...auditOutput, metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 } } }]) {
      expect(() => normalizeAudit(output)).toThrow()
    }
  })
  it('handles zero vulnerabilities without inventing findings', () => {
    const result = normalizeAudit({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 } } })
    expect(result.findings).toEqual([])
  })
  it('resolves indirect advisories and counts vulnerable packages once', () => {
    const original = auditOutput.vulnerabilities['demo-lib']
    const output = { ...auditOutput, vulnerabilities: { ...auditOutput.vulnerabilities, parent: { ...original, name: 'parent', via: ['demo-lib'] } }, metadata: { vulnerabilities: { ...auditOutput.metadata.vulnerabilities, high: 2, total: 2 } } }
    expect(normalizeAudit(output).findings[1].viaPackages).toEqual(['demo-lib'])
  })
})
