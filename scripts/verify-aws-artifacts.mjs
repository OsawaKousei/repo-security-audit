import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { dir: { type: 'string', default: '.local/artifacts/dev' },
  image: { type: 'string', default: 'public.ecr.aws/lambda/nodejs:24' }, audit: { type: 'boolean', default: false } } })
const directory = resolve(values.dir)
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
for (const name of ['api.zip', 'worker.zip', 'npm-layer.zip']) {
  const hash = createHash('sha256').update(await readFile(join(directory, name))).digest('hex')
  if (manifest.artifacts[name] !== hash) throw new Error(`Artifact hash mismatch: ${name}`)
}
function run(file, args, capture = false) {
  const result = spawnSync(file, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (result.error || result.status !== 0) throw new Error(`Artifact verification failed: ${file}`)
  return result.stdout
}
const workspace = await mkdtemp(join(tmpdir(), 'repo-sentinel-artifact-check-'))
try {
  for (const [file, target] of [['api.zip', 'api'], ['worker.zip', 'worker'], ['npm-layer.zip', 'layer']]) {
    const entries = run('unzip', ['-Z1', join(directory, file)], true).trim().split('\n')
    if (entries.some((path) => path.startsWith('/') || path.split('/').includes('..') || path.split('/').some((name) => name === '.env' || name.startsWith('.env.')))) throw new Error('Unsafe ZIP entry.')
    run('unzip', ['-q', join(directory, file), '-d', join(workspace, target)])
  }
  const smoke = `
const assert = require('node:assert/strict');
const api = require('/artifacts/api/lambda.js');
const worker = require('/artifacts/worker/lambda.js');
assert.equal(typeof api.handler, 'function'); assert.equal(typeof worker.handler, 'function');
(async () => {
 const response = await api.handler({version:'2.0',rawPath:'/api/health',rawQueryString:'',headers:{host:'example.lambda-url.ap-northeast-1.on.aws'},requestContext:{http:{method:'GET',path:'/api/health',sourceIp:'127.0.0.1'}},isBase64Encoded:false},{});
 assert.equal(response.statusCode,401);
 const result=await worker.handler({Records:[{messageId:'smoke',eventSource:'aws:sns',eventSourceARN:'invalid',body:'{}'}]},{getRemainingTimeInMillis:()=>180000});
 assert.deepEqual(result,{batchItemFailures:[{itemIdentifier:'smoke'}]});
 const {execFileSync}=require('node:child_process');
 assert.equal(execFileSync(process.execPath,['/opt/nodejs/node_modules/npm/bin/npm-cli.js','--version'],{encoding:'utf8'}).trim(),${JSON.stringify(manifest.npmLayer)});
 assert.equal(require('/opt/nodejs/node_modules/npm/node_modules/undici/package.json').version,${JSON.stringify(manifest.npmLayerPatches.undici)});
 ${values.audit ? `
 const fs=require('node:fs'),dir=fs.mkdtempSync('/tmp/npm-smoke-');
 const pkg={name:'lambda-audit-smoke',version:'1.0.0',dependencies:{axios:'1.0.0'},scripts:{preinstall:'touch /tmp/install-executed'}};
 fs.writeFileSync(dir+'/package.json',JSON.stringify(pkg));
 fs.writeFileSync(dir+'/package-lock.json',JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{'':pkg,'node_modules/axios':{version:'1.0.0',resolved:'https://registry.npmjs.org/axios/-/axios-1.0.0.tgz'}}}));
 const args=['/opt/nodejs/node_modules/npm/bin/npm-cli.js','audit','--json','--package-lock-only','--ignore-scripts','--registry=https://registry.npmjs.org','--fetch-retries=0','--fetch-timeout=20000','--no-fund','--workspaces=false'];
 let output; try{output=execFileSync(process.execPath,args,{cwd:dir,encoding:'utf8',timeout:60000,maxBuffer:2097152,env:{PATH:'/var/lang/bin:/usr/bin:/bin',HOME:dir,npm_config_cache:dir+'/cache',npm_config_update_notifier:'false'}})}catch(error){if(error.status!==1)throw error;output=error.stdout}
 const report=JSON.parse(output);assert.equal(report.auditReportVersion,2);assert.ok(report.vulnerabilities.axios);assert.equal(fs.existsSync(dir+'/node_modules'),false);assert.equal(fs.existsSync('/tmp/install-executed'),false);
 console.log('Registry-backed npm audit passed: findings returned, no install or script execution.');
 ` : ''}
 console.log('Lambda runtime:',process.version);
 console.log('Lambda Node.js 24: API 401, SQS partial failure, npm Layer and patch checks passed.');
})().catch(()=>{console.error('Artifact smoke test failed.');process.exit(1)});
`
  await writeFile(join(workspace, 'smoke.cjs'), smoke)
  run('docker', ['run', '--rm', '--network', values.audit ? 'bridge' : 'none', '--read-only', '--tmpfs', '/tmp', '--entrypoint', '/var/lang/bin/node',
    '--mount', `type=bind,source=${workspace},target=/artifacts,readonly`,
    '--mount', `type=bind,source=${join(workspace, 'layer/nodejs')},target=/opt/nodejs,readonly`,
    '-e', 'NODE_ENV=production', '-e', 'APP_ENV=dev', '-e', 'AWS_REGION=ap-northeast-1', '-e', 'AWS_ACCOUNT_ID=103492189525',
    '-e', 'DYNAMODB_TABLE=repo-sentinel-dev-jobs', '-e', 'AUDIT_MODE=audit', '-e', 'AI_MODE=mock',
    '-e', 'AUDIT_QUEUE_URL=https://sqs.ap-northeast-1.amazonaws.com/103492189525/repo-sentinel-dev-audits',
    '-e', 'ALLOWED_USER_SUB=11111111-2222-4333-8444-555555555555',
    '-e', 'COGNITO_ISSUER=https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_TestPool', '-e', 'COGNITO_CLIENT_ID=testclient',
    values.image, '/artifacts/smoke.cjs'])
} finally { await rm(workspace, { recursive: true, force: true }) }
