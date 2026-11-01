import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { createHash } from 'node:crypto'

const execute = promisify(execFile)
const { values } = parseArgs({ options: { dir: { type: 'string', default: '.local/artifacts/dev' },
  profile: { type: 'string', default: 'kupacllc' }, publish: { type: 'boolean', default: false } } })
async function run(command, args) {
  try { return (await execute(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60_000,
    env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_MAX_ATTEMPTS: '1' } })).stdout }
  catch { throw new Error(`${command} failed; check the session and permissions. No automatic retry.`) }
}
const aws = (args) => run('aws', [...args, '--profile', values.profile, '--region', 'ap-northeast-1', '--no-cli-pager'])
try {
  const outputs = JSON.parse(await run('terraform', ['-chdir=infra/terraform/environments/dev', 'output', '-json']))
  const identity = JSON.parse(await aws(['sts', 'get-caller-identity', '--output', 'json']))
  const directory = resolve(values.dir)
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const bucket = outputs.frontend_bucket?.value
  const origin = outputs.frontend_url?.value
  if (identity.Account !== '103492189525' || bucket !== 'repo-sentinel-dev-frontend-103492189525' ||
    origin !== 'https://repo-sentinel-dev.prj.kupac.co.jp' || manifest.frontendOrigin !== origin || !manifest.frontendFiles?.['index.html']) throw new Error('Unexpected dev deployment target or artifact manifest.')
  for (const [name, hash] of Object.entries(manifest.frontendFiles)) {
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('Unsafe frontend path.')
    const data = await readFile(join(directory, 'frontend', name))
    if (createHash('sha256').update(data).digest('hex') !== hash) throw new Error('Frontend artifact hash mismatch.')
  }
  const runtimeReady = outputs.runtime_enabled?.value === true
  if (values.publish) {
    if (!runtimeReady) throw new Error('Apply and verify the dev runtime before publishing the UI.')
    // Upload only manifest-verified objects; keep old hashed assets for open tabs.
    for (const name of Object.keys(manifest.frontendFiles).filter((name) => name !== 'index.html')) {
      await aws(['s3', 'cp', join(directory, 'frontend', name), `s3://${bucket}/${name}`, '--only-show-errors',
        '--cache-control', name.startsWith('assets/') ? 'public,max-age=31536000,immutable' : 'no-cache'])
    }
    await aws(['s3', 'cp', join(directory, 'frontend/index.html'), `s3://${bucket}/index.html`, '--only-show-errors',
      '--cache-control', 'no-cache', '--content-type', 'text/html; charset=utf-8'])
  }
  console.log(JSON.stringify({ action: values.publish ? 'published' : 'would_publish', origin, bucket,
    objects: Object.keys(manifest.frontendFiles).length, runtimeReady }, null, 2))
} catch (error) { console.error(error instanceof Error ? error.message : 'Frontend deployment failed.'); process.exitCode = 1 }
