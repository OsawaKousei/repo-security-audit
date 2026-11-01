import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let directory: string
const secretArn = 'arn:aws:secretsmanager:ap-northeast-1:103492189525:secret:repo-sentinel-dev/openai-api-key-Ab1234'
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'repo-sentinel-cli-test-'))
  mkdirSync(join(directory, 'bin')); mkdirSync(join(directory, 'frontend')); mkdirSync(join(directory, 'frontend/assets'))
  const frontendFiles: Record<string, string> = {}
  for (const name of ['index.html', 'assets/app.js']) {
    writeFileSync(join(directory, 'frontend', name), 'fixture')
    frontendFiles[name] = createHash('sha256').update('fixture').digest('hex')
  }
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ frontendOrigin: 'https://repo-sentinel-dev.prj.kupac.co.jp', frontendFiles }))
  const script = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),name=path.basename(process.argv[1]);
const arn=${JSON.stringify(secretArn)};
const log=(data)=>fs.appendFileSync(process.env.TEST_LOG,JSON.stringify(data)+'\\n');
if(name==='terraform') {
 if(args.includes('-raw'))console.log(arn);
 else console.log(JSON.stringify({frontend_bucket:{value:'repo-sentinel-dev-frontend-103492189525'},frontend_url:{value:'https://repo-sentinel-dev.prj.kupac.co.jp'},runtime_enabled:{value:process.env.TEST_RUNTIME!=='false'}}));
} else if(args[0]==='sts')console.log(JSON.stringify({Account:process.env.TEST_ACCOUNT||'103492189525'}));
else if(args[1]==='describe-secret')console.log(JSON.stringify({ARN:arn,Name:'repo-sentinel-dev/openai-api-key',VersionIdsToStages:{}}));
else if(args[1]==='put-secret-value') {
 const file=args[args.indexOf('--secret-string')+1].slice(7);
 log({args,file,mode:fs.statSync(file).mode&511,keyMatches:fs.readFileSync(file,'utf8')===process.env.OPENAI_API_KEY});console.log('{}');
} else if(args[0]==='s3')log({args});
else process.exit(1);
`
  for (const name of ['aws', 'terraform']) { writeFileSync(join(directory, 'bin', name), script); chmodSync(join(directory, 'bin', name), 0o700) }
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
function run(name: string, args: string[] = [], overrides: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [resolve('scripts', name), ...args], { encoding: 'utf8',
    env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, TEST_LOG: join(directory, 'calls'),
      OPENAI_API_KEY: `sk-${'test'.repeat(10)}`, OPENAI_HARD_LIMIT_CONFIRMED: 'true', ...overrides } })
}
function calls(): { args: string[]; file?: string; mode?: number; keyMatches?: boolean }[] {
  return existsSync(join(directory, 'calls')) ? readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
}
describe('guarded dev deployment scripts', () => {
  it('previews secrets by default, without invoking a write or printing a key', () => {
    const result = run('put-dev-openai-secret.mjs')
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('would_update'); expect(calls()).toEqual([])
    expect(result.stdout + result.stderr).not.toContain(`sk-${'test'.repeat(10)}`)
  })
  it('writes a secret only explicitly, using a private temporary file and removing it', () => {
    const result = run('put-dev-openai-secret.mjs', ['--write'])
    expect(result.status, result.stderr).toBe(0)
    const [call] = calls()
    expect(call.mode).toBe(0o600); expect(call.keyMatches).toBe(true)
    expect(existsSync(call.file!)).toBe(false)
    expect(JSON.stringify(call.args) + result.stdout + result.stderr).not.toContain(`sk-${'test'.repeat(10)}`)
  })
  it('refuses secret writes without the hard-limit flag or on an unexpected account', () => {
    for (const env of [{ OPENAI_HARD_LIMIT_CONFIRMED: 'false' }, { TEST_ACCOUNT: '999999999999' }]) {
      expect(run('put-dev-openai-secret.mjs', ['--write'], env).status).toBe(1)
    }
    expect(calls()).toEqual([])
  })
  it('previews frontend by default, then publishes verified assets before index without deleting old assets', () => {
    const preview = run('deploy-dev-frontend.mjs', ['--dir', directory])
    expect(preview.status, preview.stderr).toBe(0)
    expect(preview.stdout).toContain('would_publish')
    expect(calls()).toEqual([])
    expect(run('deploy-dev-frontend.mjs', ['--dir', directory, '--publish']).status).toBe(0)
    const uploads = calls()
    expect(uploads).toHaveLength(2)
    expect(uploads[0].args.join(' ')).toContain('assets/app.js')
    expect(uploads[1].args.join(' ')).toContain('index.html')
    expect(JSON.stringify(uploads)).not.toContain('--delete')
  })
  it('refuses frontend publication if artifacts changed or runtime is disabled', () => {
    expect(run('deploy-dev-frontend.mjs', ['--dir', directory, '--publish'], { TEST_RUNTIME: 'false' }).status).toBe(1)
    writeFileSync(join(directory, 'frontend/index.html'), 'changed')
    expect(run('deploy-dev-frontend.mjs', ['--dir', directory, '--publish']).status).toBe(1)
    expect(calls()).toEqual([])
  })
})
