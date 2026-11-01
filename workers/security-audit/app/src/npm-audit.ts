import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { AuditError, findingSchema, severitySchema, summarySchema } from '@repo-sentinel/core'
import { LIMITS } from './limits.js'

const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i
const safeSpec = /^(?:npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@)?[a-z0-9*<>=~^| .+_-]+$/i
const dependencyKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const
const object = z.record(z.string(), z.unknown())
export function validateProject(packageJson: string, packageLock: string) {
  try {
    if (Buffer.byteLength(packageJson) > LIMITS.packageBytes || Buffer.byteLength(packageLock) > LIMITS.lockBytes) throw new AuditError('FILE_TOO_LARGE', '対象ファイルがサイズ上限を超えました。', 413)
    const manifest = object.parse(JSON.parse(packageJson))
    const lock = object.parse(JSON.parse(packageLock))
    if (manifest.workspaces || ![2, 3].includes(Number(lock.lockfileVersion))) throw new AuditError('UNSUPPORTED_PROJECT', 'workspaceやlockfileVersion 1には対応していません。', 400)
    const packages = z.record(z.string(), object).parse(lock.packages)
    if (!packages[''] || Object.keys(packages).length > 20_000) throw new AuditError('INVALID_LOCKFILE', 'lockfileのルートや件数が不正です。', 400)
    if (packages[''].workspaces) throw new AuditError('UNSUPPORTED_PROJECT', 'workspace lockfileには対応していません。', 400)
    function dependencies(value: Record<string, unknown>) {
      for (const key of dependencyKeys) {
        if (value[key] === undefined) continue
        const deps = z.record(z.string(), z.string()).parse(value[key])
        for (const [name, spec] of Object.entries(deps)) {
          if (!packageName.test(name) || !safeSpec.test(spec)) throw new AuditError('UNSUPPORTED_PROJECT', 'git・URL・file依存などには対応していません。', 400)
        }
      }
    }
    dependencies(manifest)
    for (const [path, entry] of Object.entries(packages)) {
      if (path && !/^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/?)+$/i.test(path)) throw new AuditError('UNSUPPORTED_PROJECT', '非対応のlockfileパスです。', 400)
      if (entry.link) throw new AuditError('UNSUPPORTED_PROJECT', 'リンク依存には対応していません。', 400)
      dependencies(entry)
      if (entry.resolved !== undefined) {
        const url = new URL(z.string().parse(entry.resolved))
        if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password || url.search || url.hash) throw new AuditError('UNSUPPORTED_PROJECT', 'npm Registry以外の依存取得先は利用できません。', 400)
      }
    }
    for (const key of dependencyKeys) {
      if (JSON.stringify(manifest[key] ?? {}) !== JSON.stringify(packages[''][key] ?? {})) {
        // Key order does not affect dependency equivalence.
        const sorted = (v: unknown) => JSON.stringify(Object.entries(z.record(z.string(), z.string()).parse(v ?? {})).sort(([a], [b]) => a.localeCompare(b)))
        if (sorted(manifest[key]) !== sorted(packages[''][key])) throw new AuditError('INVALID_LOCKFILE', 'package.jsonとlockfileの依存関係が一致しません。', 400)
      }
    }
    // Copy only audit-relevant manifest fields; scripts/config/overrides are never applied.
    const sanitized = Object.fromEntries(['name', 'version', ...dependencyKeys].filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]]))
    return { packageJson: JSON.stringify(sanitized), packageLock: JSON.stringify(lock) }
  } catch (error) {
    if (error instanceof AuditError) throw error
    throw new AuditError('INVALID_LOCKFILE', 'package.jsonまたはlockfileの形式が不正です。', 400)
  }
}

const advisory = z.object({ source: z.number(), title: z.string().max(2000), url: z.url(), severity: severitySchema, range: z.string().max(2000) })
const vulnerability = z.object({
  name: z.string(), severity: severitySchema, range: z.string().max(2000),
  via: z.array(z.union([z.string(), advisory])),
  fixAvailable: z.union([z.boolean(), z.object({ name: z.string(), version: z.string(), isSemVerMajor: z.boolean() })]),
})
const npmReport = z.object({
  auditReportVersion: z.literal(2), vulnerabilities: z.record(z.string(), vulnerability),
  metadata: z.object({ vulnerabilities: summarySchema.extend({ total: z.number().int().nonnegative() }) }),
  error: z.never().optional(),
})
export function normalizeAudit(value: unknown) {
  try {
    const parsed = npmReport.parse(value)
    const entries = Object.entries(parsed.vulnerabilities).sort(([a], [b]) => a.localeCompare(b))
    if (entries.length > LIMITS.findings) throw new AuditError('RESULT_TOO_LARGE', '検出結果が件数上限を超えました。', 413)
    function advisories(name: string, seen = new Set<string>()): z.infer<typeof advisory>[] {
      if (seen.has(name)) return []
      seen.add(name)
      const item = parsed.vulnerabilities[name]
      if (!item) throw new Error('Unknown dependency in via')
      return item.via.flatMap((via) => typeof via === 'string' ? advisories(via, seen) : [via])
    }
    const findings = entries.map(([name, item]) => {
      if (name !== item.name || !packageName.test(name)) throw new Error('Invalid vulnerable package')
      const unique = [...new Map(advisories(name).map((a) => [a.source, a])).values()]
      if (!unique.length) throw new Error('Missing advisory evidence')
      for (const entry of unique) {
        const url = new URL(entry.url)
        if (url.protocol !== 'https:' || !['github.com', 'www.npmjs.com', 'npmjs.com'].includes(url.hostname) || url.username || url.password) throw new Error('Invalid advisory URL')
      }
      return findingSchema.parse({
        package: name, title: unique.map((a) => a.title).join(' / '), severity: item.severity,
        range: item.range, fixAvailable: item.fixAvailable !== false,
        fixVersion: typeof item.fixAvailable === 'object' ? item.fixAvailable.version : null,
        fixPackage: typeof item.fixAvailable === 'object' ? item.fixAvailable.name : null,
        fixIsSemVerMajor: typeof item.fixAvailable === 'object' && item.fixAvailable.isSemVerMajor,
        advisoryUrl: unique[0].url, advisories: unique.map(({ title, url, severity, range }) => ({ title, url, severity, range })),
        viaPackages: item.via.filter((via): via is string => typeof via === 'string'),
      })
    })
    const summary = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 }
    for (const finding of findings) summary[finding.severity] += 1
    const counts = parsed.metadata.vulnerabilities
    if (counts.total !== findings.length || Object.entries(summary).some(([key, count]) => counts[key as keyof typeof summary] !== count)) throw new Error('Counts do not match')
    return { findings, summary }
  } catch (error) {
    if (error instanceof AuditError) throw error
    throw new AuditError('NPM_INVALID_OUTPUT', 'npm auditのJSONや検出件数が不正です。', 503)
  }
}

export async function runNpmAudit(packageJson: string, packageLock: string, signal: AbortSignal) {
  const files = validateProject(packageJson, packageLock)
  const directory = await mkdtemp(join(tmpdir(), 'repo-sentinel-audit-'))
  try {
    await Promise.all([
      writeFile(join(directory, 'package.json'), files.packageJson, { mode: 0o600 }),
      writeFile(join(directory, 'package-lock.json'), files.packageLock, { mode: 0o600 }),
      writeFile(join(directory, 'user.npmrc'), '', { mode: 0o600 }),
      writeFile(join(directory, 'global.npmrc'), '', { mode: 0o600 }),
    ])
    signal.throwIfAborted()
    const stdout = await new Promise<string>((resolve, reject) => {
      const command = npmCommand()
      execFile(command.file, [...command.args,
        'audit', '--json', '--package-lock-only', '--ignore-scripts', '--registry=https://registry.npmjs.org',
        '--fetch-retries=0', '--fetch-timeout=20000', '--no-fund', '--workspaces=false',
      ], {
        cwd: directory, shell: false, timeout: LIMITS.npmMs, signal, killSignal: 'SIGKILL', maxBuffer: LIMITS.npmOutputBytes,
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: directory, NODE_ENV: 'development',
          npm_config_cache: join(directory, 'cache'), npm_config_userconfig: join(directory, 'user.npmrc'),
          npm_config_globalconfig: join(directory, 'global.npmrc'), npm_config_update_notifier: 'false',
        },
      }, (error, output) => {
        if (error?.killed || error?.name === 'AbortError' || signal.aborted) return reject(new AuditError('NPM_TIMEOUT', 'npm auditがタイムアウトしました。', 503))
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new AuditError('NPM_OUTPUT_TOO_LARGE', 'npm auditの出力が上限を超えました。', 413))
        if (error && typeof error.code !== 'number') return reject(new AuditError('NPM_FAILED', 'npm auditを実行できませんでした。', 503))
        resolve(output)
      })
    })
    let json: unknown
    try { json = JSON.parse(stdout) } catch { throw new AuditError('NPM_INVALID_OUTPUT', 'npm auditが有効なJSONを返しませんでした。', 503) }
    return normalizeAudit(json)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

export function npmCommand(env = process.env) {
  if (env.NPM_CLI_PATH) {
    if (env.NPM_CLI_PATH !== '/opt/nodejs/node_modules/npm/bin/npm-cli.js' || env.NODE_ENV !== 'production' || env.APP_ENV !== 'dev') {
      throw new AuditError('NPM_FAILED', 'AWS用npm実行パスが不正です。', 503)
    }
    return { file: process.execPath, args: [env.NPM_CLI_PATH] }
  }
  if (env.AWS_LAMBDA_FUNCTION_NAME) throw new AuditError('NPM_FAILED', 'AWS用npm Layerが設定されていません。', 503)
  return { file: join(dirname(process.execPath), 'npm'), args: [] }
}
