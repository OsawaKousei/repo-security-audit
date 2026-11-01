import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'

const execute = promisify(execFile)
const { values } = parseArgs({ options: { profile: { type: 'string', default: 'kupacllc' }, write: { type: 'boolean', default: false } } })
let directory
async function run(command, args) {
  try { return (await execute(command, args, { encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_MAX_ATTEMPTS: '1' } })).stdout }
  catch { throw new Error(`${command} failed; no raw error or secret was logged. Check the session and permissions.`) }
}
const aws = (args) => run('aws', [...args, '--profile', values.profile, '--region', 'ap-northeast-1', '--output', 'json', '--no-cli-pager'])
try {
  const identity = JSON.parse(await aws(['sts', 'get-caller-identity']))
  const arn = (await run('terraform', ['-chdir=infra/terraform/environments/dev', 'output', '-raw', 'openai_secret_arn'])).trim()
  if (identity.Account !== '103492189525' || !/^arn:aws:secretsmanager:ap-northeast-1:103492189525:secret:repo-sentinel-dev\/openai-api-key-[A-Za-z0-9]{6}$/.test(arn)) throw new Error('Unexpected dev account or secret.')
  const metadata = JSON.parse(await aws(['secretsmanager', 'describe-secret', '--secret-id', arn]))
  if (metadata.ARN !== arn || metadata.Name !== 'repo-sentinel-dev/openai-api-key') throw new Error('Unexpected secret metadata.')
  if (values.write) {
    const key = process.env.OPENAI_API_KEY?.trim()
    if (!key || key.length > 512 || !/^sk-[A-Za-z0-9_-]{20,}$/.test(key) || process.env.OPENAI_HARD_LIMIT_CONFIRMED !== 'true') throw new Error('Provide a dedicated dev key and hard-limit confirmation through the environment.')
    directory = await mkdtemp(join(tmpdir(), 'repo-sentinel-dev-secret-'))
    const path = join(directory, 'key')
    await writeFile(path, key, { mode: 0o600 })
    // The key is never a process argument or an output. Terraform never reads it.
    await aws(['secretsmanager', 'put-secret-value', '--secret-id', arn, '--secret-string', `file://${path}`])
  }
  console.log(JSON.stringify({ action: values.write ? 'updated' : 'would_update', secretArn: arn,
    hadCurrentVersion: Object.values(metadata.VersionIdsToStages ?? {}).some((stages) => stages.includes('AWSCURRENT')) }, null, 2))
} catch (error) { console.error(error instanceof Error ? error.message : 'Secret preparation failed.'); process.exitCode = 1 }
finally { if (directory) await rm(directory, { recursive: true, force: true }) }
