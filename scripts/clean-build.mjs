import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const workspace = await mkdtemp(join(tmpdir(), 'repo-sentinel-build-'))
try {
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.base.json', 'frontend', 'api', 'workers', 'packages']) {
    await cp(path, join(workspace, path), {
      recursive: true,
      filter: (source) => !source.split('/').some((part) => ['node_modules', 'dist', '.env'].includes(part) || part.startsWith('.env.')) && !source.endsWith('.tsbuildinfo'),
    })
  }
  for (const args of [['ci', '--no-audit', '--no-fund'], ['run', 'build']]) {
    const result = spawnSync('npm', args, { cwd: workspace, stdio: 'inherit', env: { ...process.env, npm_config_cache: join(tmpdir(), 'repo-sentinel-npm-cache') } })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Clean build failed: npm ${args.join(' ')}`)
  }
  console.log('Clean build passed using fresh dependencies; temporary outputs will be removed.')
} finally { await rm(workspace, { recursive: true, force: true }) }
