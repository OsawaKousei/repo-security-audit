import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { config: { type: 'string' }, out: { type: 'string', default: '.local/artifacts/dev' } } })
if (!values.config) throw new Error('Use --config <terraform output -json file> [--out <directory>].')
if (process.version !== `v${(await readFile('.node-version', 'utf8')).trim()}`) throw new Error('Use the pinned Node.js version.')
const outputs = JSON.parse(await readFile(resolve(values.config), 'utf8'))
const value = (name) => outputs[name]?.value
const origin = new URL(value('frontend_url')).origin
const issuer = value('cognito_issuer')
const clientId = value('cognito_client_id')
const login = value('cognito_login_url')
if (!/^https:\/\/[a-z][a-z0-9-]*-dev\.prj\.kupac\.co\.jp$/.test(origin) ||
  !/^https:\/\/cognito-idp\.ap-northeast-1\.amazonaws\.com\/ap-northeast-1_[A-Za-z0-9]+$/.test(issuer) ||
  !/^[A-Za-z0-9]{1,128}$/.test(clientId) || !/^https:\/\/[a-z0-9-]+\.auth\.ap-northeast-1\.amazoncognito\.com$/.test(login) ||
  !value('cognito_callback_urls')?.includes(`${origin}/auth/callback`)) throw new Error('Invalid dev public build configuration.')
const out = resolve(values.out)
await mkdir(out, { recursive: true })
const workspace = await mkdtemp(join(tmpdir(), 'repo-sentinel-aws-build-'))
const env = { PATH: process.env.PATH, HOME: join(workspace, 'home'), CI: 'true',
  npm_config_cache: join(tmpdir(), 'repo-sentinel-npm-cache') }
function run(file, args, cwd, extra = {}) {
  const result = spawnSync(file, args, { cwd, env: { ...env, ...extra }, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error(`Build command failed: ${file}`)
}
const hash = (data) => createHash('sha256').update(data).digest('hex')
try {
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.base.json', 'frontend', 'api', 'workers', 'packages']) {
    await cp(path, join(workspace, path), { recursive: true,
      filter: (source) => !source.split('/').some((part) => ['node_modules', 'dist', '.env'].includes(part) || part.startsWith('.env.')) && !source.endsWith('.tsbuildinfo') })
  }
  // npm comes from the pinned host Node distribution for installation only.
  run(join(dirname(process.execPath), 'npm'), ['ci', '--no-audit', '--no-fund'], workspace)
  const require = createRequire(join(workspace, 'package.json'))
  const { build } = require('esbuild')
  for (const [name, entry] of [['api', 'api/app/src/lambda.ts'], ['worker', 'workers/security-audit/app/src/lambda.ts']]) {
    const stage = join(workspace, `stage-${name}`)
    await mkdir(stage)
    await build({ entryPoints: [join(workspace, entry)], bundle: true, platform: 'node', target: 'node24',
      format: 'cjs', outfile: join(stage, 'lambda.js'), sourcemap: false, metafile: true }).then(async (result) => {
        await writeFile(join(out, `${name}-bundle.json`), JSON.stringify(result.metafile))
      })
    await writeFile(join(stage, 'package.json'), JSON.stringify({ type: 'commonjs' }))
    await rm(join(out, `${name}.zip`), { force: true })
    run('zip', ['-q', '-r', join(out, `${name}.zip`), '.'], stage)
  }
  const layer = join(workspace, 'npm-layer')
  await mkdir(join(layer, 'nodejs/node_modules'), { recursive: true })
  await cp(join(workspace, 'node_modules/npm'), join(layer, 'nodejs/node_modules/npm'), { recursive: true })
  // npm bundles this dependency; npm overrides do not replace its bundled copy.
  const undiciTarget = join(layer, 'nodejs/node_modules/npm/node_modules/undici')
  await rm(undiciTarget, { recursive: true, force: true })
  await cp(join(workspace, 'node_modules/undici'), undiciTarget, { recursive: true })
  await rm(join(out, 'npm-layer.zip'), { force: true })
  run('zip', ['-q', '-r', join(out, 'npm-layer.zip'), '.'], layer)
  run(process.execPath, [join(workspace, 'node_modules/vite/bin/vite.js'), 'build'], join(workspace, 'frontend/app'), {
    VITE_AUTH_MODE: 'cognito', VITE_LOCAL_AUTH_BYPASS: 'false', VITE_COGNITO_ISSUER: issuer,
    VITE_COGNITO_CLIENT_ID: clientId, VITE_COGNITO_LOGIN_URL: login, NODE_ENV: 'production',
  })
  await rm(join(out, 'frontend'), { recursive: true, force: true })
  await cp(join(workspace, 'frontend/app/dist'), join(out, 'frontend'), { recursive: true })
  const artifacts = {}
  for (const name of ['api.zip', 'worker.zip', 'npm-layer.zip']) artifacts[name] = hash(await readFile(join(out, name)))
  const frontendFiles = {}
  for (const file of await readdir(join(out, 'frontend'), { recursive: true, withFileTypes: true })) {
    if (file.isFile()) {
      const path = join(file.parentPath, file.name)
      frontendFiles[path.slice(join(out, 'frontend').length + 1)] = hash(await readFile(path))
    }
  }
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ version: 1, node: process.version,
    npmLayer: require('npm/package.json').version, npmLayerPatches: { undici: require('undici/package.json').version },
    lockSha256: hash(await readFile(join(workspace, 'package-lock.json'))),
    frontendOrigin: origin, frontendFiles, artifacts }, null, 2) + '\n')
  console.log(`AWS artifacts created in ${out}; no AWS resources or secrets were changed.`)
} finally { await rm(workspace, { recursive: true, force: true }) }
