import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { SQSClient } from '@aws-sdk/client-sqs'
import { monotonicFactory } from 'ulid'
import { AuditError, auditSchema, type Audit } from '@repo-sentinel/core'
import { DynamoAuditStore, createAuditEnqueuer, createDynamoAiBudget, dynamoClient, ensureTable, localConfig } from '@repo-sentinel/aws'
import { createAuditRunner, createMockRunner, failAudit, startMockDispatcher } from '../workers/security-audit/app/src/audit.js'
import { mockResult } from '../workers/security-audit/app/src/mock.js'
import { createApp } from '../api/app/src/app.js'
import { machine, manifest, lockfile, aiOutput } from './fixtures/worker.js'
import { validateAiReport } from '../workers/security-audit/app/src/ai-report.js'
import { signedTestToken, testCognitoAuthorizer, testSub } from './fixtures/cognito.js'
import { AWS_LEASE } from '@repo-sentinel/core'
import { createSqsHandler } from '../workers/security-audit/app/src/sqs-handler.js'

const config = localConfig()
const table = `security-audit-test-${randomUUID()}-local`
const client = dynamoClient(config.endpoint)
const store = new DynamoAuditStore(client, table)
const id = monotonicFactory()
const pending = (): Audit => ({ jobId: id(), repository: 'example/project', status: 'PENDING', createdAt: new Date().toISOString(), attemptCount: 0, mode: 'mock' })
const app = (owner = 'test-user', enqueue?: (jobId: string, ownerSub: string) => Promise<void>) => createApp({ store, authorize: () => owner, enqueue })
const post = () => new Request('http://localhost/api/audits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryUrl: 'https://github.com/example/project' }) })
const instant = { wait: async () => {} }
let budgetDirectory: string
before(async () => { await ensureTable(client, table); budgetDirectory = await mkdtemp(join(tmpdir(), 'repo-sentinel-integration-budget-')) })
after(async () => { try { await client.send(new DeleteTableCommand({ TableName: table })); await rm(budgetDirectory, { recursive: true, force: true }) } finally { client.destroy() } })

test('signed Cognito access token → owner-bound local job → Worker → history', async () => {
  const api = createApp({ store, authorize: testCognitoAuthorizer() })
  const create = (jwt?: string) => api.request('/api/audits', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jwt ? { 'X-Access-Token': jwt } : {}) },
    body: JSON.stringify({ repositoryUrl: 'https://github.com/example/authenticated-flow' }) })
  assert.equal((await create()).status, 401)
  assert.equal((await create(signedTestToken({ token_use: 'id' }))).status, 401)
  assert.equal((await create(signedTestToken({ sub: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }))).status, 403)
  const response = await create(signedTestToken())
  assert.equal(response.status, 202)
  const { jobId } = await response.json()
  assert.ok(await store.get(testSub, jobId))
  assert.equal(await store.get('local-user', jobId), undefined)
  await createMockRunner(store, instant)(jobId, testSub)
  const detail = await api.request(`/api/audits/${jobId}`, { headers: { 'X-Access-Token': signedTestToken() } })
  assert.equal((await detail.json()).status, 'COMPLETED')
})

test('API create → mock Worker → persisted report and owner isolation', async () => {
  const api = app('flow')
  const response = await api.fetch(post())
  assert.equal(response.status, 202)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const { jobId } = await response.json()
  assert.equal((await store.get('flow', jobId))?.status, 'PENDING')
  await createMockRunner(store, instant)(jobId, 'flow')
  const detail = auditSchema.parse(await (await api.request(`/api/audits/${jobId}`)).json())
  assert.equal(detail.status, 'COMPLETED')
  if (detail.status === 'COMPLETED') { assert.equal(detail.summary.high, 1); assert.equal(detail.findings.length, 2); assert.equal(detail.attemptCount, 1) }
  assert.equal((await app('other').request(`/api/audits/${jobId}`)).status, 404)
  assert.deepEqual(await (await app('other').request('/api/audits')).json(), { items: [] })
})
test('input, body limit, JSON, unknown endpoints and default-deny authentication', async () => {
  assert.equal((await createApp({ store }).fetch(post())).status, 401)
  assert.equal((await app().request('/api/audits?limit=51')).status, 400)
  assert.equal((await app().request('/api/audits?cursor=invalid')).status, 400)
  assert.equal((await app().request('/api/audits/bad')).status, 400)
  assert.equal((await app().request('/api/unknown')).status, 404)
  for (const body of ['{', JSON.stringify({ repositoryUrl: 'https://evil.example/a/b' }), JSON.stringify({ repositoryUrl: 'https://github.com/a/b', extra: true })]) {
    assert.equal((await app().request('/api/audits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 400)
  }
  assert.equal((await app().request('/api/audits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(4097) })).status, 413)
})
test('concurrent creates permit one active job and do not consume rejected quota', async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, () => app('concurrent').fetch(post())))
  assert.equal(responses.filter((r) => r.status === 202).length, 1)
  assert.equal(responses.filter((r) => r.status === 409).length, 7)
  const created = await responses.find((r) => r.status === 202)!.json()
  await createMockRunner(store, instant)(created.jobId, 'concurrent')
  for (let i = 0; i < 4; i++) {
    const response = await app('concurrent').fetch(post()); assert.equal(response.status, 202)
    await createMockRunner(store, instant)((await response.json()).jobId, 'concurrent')
  }
  assert.equal((await app('concurrent').fetch(post())).status, 429)
})
test('history is newest first, paginated and excludes management metadata', async () => {
  for (let i = 0; i < 3; i++) {
    const audit = pending(); await store.create('history', audit)
    await createMockRunner(store, instant)(audit.jobId, 'history')
  }
  const first = await store.list('history', 2)
  assert.equal(first.items.length, 2)
  assert.ok(first.items[0].jobId > first.items[1].jobId)
  assert.ok(first.nextCursor)
  const second = await store.list('history', 2, first.nextCursor)
  assert.equal(second.items.length, 1)
  assert.ok(first.items[1].jobId > second.items[0].jobId)
  assert.equal(second.nextCursor, undefined)
})
test('mock failure persists FAILED and releases the active slot', async () => {
  const audit = pending(); await store.create('failure', audit)
  await createMockRunner(store, { ...instant, outcome: 'failure' })(audit.jobId, 'failure')
  const failed = await store.get('failure', audit.jobId)
  assert.equal(failed?.status, 'FAILED')
  if (failed?.status === 'FAILED') assert.equal(failed.errorCode, 'MOCK_FAILURE')
  assert.equal(await store.active(), undefined)
})
test('dispatch failure records a terminal error and consumes one accepted attempt', async () => {
  const response = await app('dispatch', async () => { throw new Error('dispatch failed') }).fetch(post())
  assert.equal(response.status, 503)
  const audit = (await store.list('dispatch', 20)).items[0]
  assert.equal(audit.status, 'FAILED')
  if (audit.status === 'FAILED') assert.equal(audit.errorCode, 'DISPATCH_FAILED')
  assert.equal(await store.active(), undefined)
})
test('duplicate Workers execute once; completed jobs are immutable', async () => {
  const audit = pending(); await store.create('duplicate', audit)
  let runs = 0
  const runner = createMockRunner(store, { wait: async () => { runs += 1 } })
  await Promise.all(Array.from({ length: 6 }, () => runner(audit.jobId, 'duplicate')))
  await runner(audit.jobId, 'duplicate')
  assert.equal(runs, 1)
  assert.equal((await store.get('duplicate', audit.jobId))?.attemptCount, 1)
})
test('lease timeout recovers a stranded RUNNING job without rerunning it', async () => {
  const audit = pending(); await store.create('timeout', audit); await store.claim('timeout', audit.jobId)
  await DynamoDBDocumentClient.from(client).send(new UpdateCommand({ TableName: table, Key: { PK: 'SYSTEM', SK: 'ACTIVE_AUDIT' }, UpdateExpression: 'SET leaseUntil = :past', ExpressionAttributeValues: { ':past': 0 } }))
  await createMockRunner(store, instant)(audit.jobId, 'timeout')
  const failed = await store.get('timeout', audit.jobId)
  assert.equal(failed?.status, 'FAILED')
  if (failed?.status === 'FAILED') assert.equal(failed.errorCode, 'JOB_TIMEOUT')
  assert.equal(await store.active(), undefined)
})
test('oversized results leave room for a controlled failure record', async () => {
  const audit = pending(); await store.create('size', audit)
  const running = await store.claim('size', audit.jobId)
  assert.equal(running?.status, 'RUNNING')
  if (running?.status !== 'RUNNING') throw new Error('Missing running job')
  const result = mockResult(running); result.report.summary = 'x'.repeat(360 * 1024)
  await assert.rejects(store.finish('size', result), (error) => error instanceof AuditError && error.code === 'RESULT_TOO_LARGE')
  await failAudit(store, 'size', audit.jobId, 'RESULT_TOO_LARGE')
  assert.equal((await store.get('size', audit.jobId))?.status, 'FAILED')
  assert.equal(await store.active(), undefined)
})
test('dispatcher picks up a durable PENDING job created before startup', async () => {
  const audit = pending(); await store.create('restart', audit)
  const stop = startMockDispatcher(store, createMockRunner(store, instant))
  try {
    const deadline = Date.now() + 3000
    while ((await store.get('restart', audit.jobId))?.status !== 'COMPLETED' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal((await store.get('restart', audit.jobId))?.status, 'COMPLETED')
  } finally { stop() }
})
test('cannot complete a PENDING job or run a job with a different owner', async () => {
  const audit = pending(); await store.create('transition', audit)
  assert.equal(await store.finish('transition', mockResult({ ...audit, status: 'RUNNING', startedAt: new Date().toISOString() })), false)
  await createMockRunner(store, instant)(audit.jobId, 'different-owner')
  assert.equal((await store.get('transition', audit.jobId))?.status, 'PENDING')
  await createMockRunner(store, instant)(audit.jobId, 'transition')
  assert.equal((await store.get('transition', audit.jobId))?.status, 'COMPLETED')
})

const machineOptions = () => ({
  budgetDirectory,
  fetchFiles: async () => ({ commitSha: machine.commitSha, packageJson: JSON.stringify(manifest), packageLock: JSON.stringify(lockfile) }),
  npmAudit: async () => ({ summary: machine.summary, findings: machine.findings }),
})
test('real-mode machine result with mock AI persists genuine evidence and never calls AI', async () => {
  const audit: Audit = { ...pending(), mode: 'audit', aiMode: 'mock' }
  await store.create('local-audit', audit)
  const failOnAi = async () => { throw new Error('AI must not run in mock mode') }
  await createAuditRunner(store, { ...machineOptions(), aiReport: failOnAi })(audit.jobId, 'local-audit')
  const saved = await store.get('local-audit', audit.jobId)
  assert.equal(saved?.status, 'COMPLETED')
  if (saved?.status === 'COMPLETED') {
    assert.equal(saved.commitSha, machine.commitSha)
    assert.equal(saved.summary.high, 1)
    assert.equal(saved.aiAttemptedAt, undefined)
  }
})
test('mock dispatcher cannot claim a manual real-audit job', async () => {
  const audit: Audit = { ...pending(), mode: 'audit', aiMode: 'mock' }
  await store.create('manual-audit', audit)
  const stop = startMockDispatcher(store, createMockRunner(store, instant))
  try {
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal((await store.get('manual-audit', audit.jobId))?.status, 'PENDING')
    await createAuditRunner(store, machineOptions())(audit.jobId, 'manual-audit')
    assert.equal((await store.get('manual-audit', audit.jobId))?.status, 'COMPLETED')
  } finally { stop() }
})
test('AI call marker and budget precede the call; duplicate real Workers call once', async () => {
  const audit: Audit = { ...pending(), mode: 'audit', aiMode: 'openai' }
  await store.create('real-duplicate', audit)
  let calls = 0
  const runner = createAuditRunner(store, {
    ...machineOptions(), openaiKey: 'test-key', hardLimitConfirmed: true,
    aiReport: async () => {
      calls += 1
      const running = await store.get('real-duplicate', audit.jobId)
      assert.ok(running?.aiAttemptedAt)
      assert.equal(running?.status, 'RUNNING')
      const ledger = JSON.parse(await readFile(join(budgetDirectory, 'budget.json'), 'utf8')) as { reservations: { jobId: string }[] }
      assert.ok(ledger.reservations.some((item) => item.jobId === audit.jobId))
      return validateAiReport(aiOutput, machine)
    },
  })
  await Promise.all(Array.from({ length: 4 }, () => runner(audit.jobId, 'real-duplicate')))
  await runner(audit.jobId, 'real-duplicate')
  assert.equal(calls, 1)
  assert.equal((await store.get('real-duplicate', audit.jobId))?.status, 'COMPLETED')
})
test('AI outcome uncertainty preserves machine evidence and is never automatically retried', async () => {
  const audit: Audit = { ...pending(), mode: 'audit', aiMode: 'openai' }
  await store.create('uncertain', audit)
  let calls = 0
  const runner = createAuditRunner(store, {
    ...machineOptions(), openaiKey: 'test-key', hardLimitConfirmed: true,
    aiReport: async () => { calls += 1; throw new AuditError('AI_OUTCOME_UNKNOWN', 'uncertain', 503) },
  })
  await runner(audit.jobId, 'uncertain'); await runner(audit.jobId, 'uncertain')
  const failed = await store.get('uncertain', audit.jobId)
  assert.equal(failed?.status, 'FAILED')
  if (failed?.status === 'FAILED') {
    assert.equal(failed.errorCode, 'AI_OUTCOME_UNKNOWN')
    assert.equal(failed.machine?.commitSha, machine.commitSha)
    assert.ok(failed.aiAttemptedAt)
  }
  assert.equal(calls, 1)
  assert.equal(await store.active(), undefined)
})
test('budget exhaustion stops before external AI and retains evidence', async () => {
  const audit: Audit = { ...pending(), mode: 'audit', aiMode: 'openai' }
  await store.create('budget', audit)
  let calls = 0
  await createAuditRunner(store, {
    ...machineOptions(), openaiKey: 'test-key', hardLimitConfirmed: true,
    reserveBudget: async () => { throw new AuditError('AI_BUDGET_LIMIT', 'budget', 429) },
    aiReport: async () => { calls += 1; return validateAiReport(aiOutput, machine) },
  })(audit.jobId, 'budget')
  const failed = await store.get('budget', audit.jobId)
  assert.equal(failed?.status, 'FAILED')
  if (failed?.status === 'FAILED') { assert.equal(failed.errorCode, 'AI_BUDGET_LIMIT'); assert.ok(failed.machine) }
  assert.equal(calls, 0)
})
test('machine failure never invokes AI or generates a report', async () => {
  const audit: Audit = { ...pending(), mode: 'audit', aiMode: 'openai' }
  await store.create('npm-failure', audit)
  let calls = 0
  await createAuditRunner(store, {
    ...machineOptions(), openaiKey: 'test-key', hardLimitConfirmed: true,
    npmAudit: async () => { throw new AuditError('NPM_TIMEOUT', 'timeout', 503) },
    aiReport: async () => { calls += 1; return validateAiReport(aiOutput, machine) },
  })(audit.jobId, 'npm-failure')
  const failed = await store.get('npm-failure', audit.jobId)
  assert.equal(failed?.status, 'FAILED')
  if (failed?.status === 'FAILED') { assert.equal(failed.errorCode, 'NPM_TIMEOUT'); assert.equal(failed.machine, undefined) }
  assert.equal(calls, 0)
})
test('CLI recovery of expired real execution preserves the AI marker without calling again', async () => {
  const audit: Audit = { ...pending(), mode: 'audit', aiMode: 'openai' }
  await store.create('real-expiry', audit)
  await store.claim('real-expiry', audit.jobId)
  await store.saveMachine('real-expiry', audit.jobId, machine)
  await store.beginAi('real-expiry', audit.jobId, 'test-model', new Date().toISOString())
  await DynamoDBDocumentClient.from(client).send(new UpdateCommand({ TableName: table, Key: { PK: 'SYSTEM', SK: 'ACTIVE_AUDIT' }, UpdateExpression: 'SET leaseUntil = :past', ExpressionAttributeValues: { ':past': 0 } }))
  let calls = 0
  await createAuditRunner(store, { ...machineOptions(), aiReport: async () => { calls += 1; return validateAiReport(aiOutput, machine) } })(audit.jobId, 'real-expiry')
  const failed = await store.get('real-expiry', audit.jobId)
  assert.equal(failed?.status, 'FAILED')
  if (failed?.status === 'FAILED') { assert.equal(failed.errorCode, 'JOB_TIMEOUT'); assert.ok(failed.aiAttemptedAt); assert.ok(failed.machine) }
  assert.equal(calls, 0)
  assert.equal(await store.active(), undefined)
})

const queueArn = 'arn:aws:sqs:ap-northeast-1:103492189525:repo-sentinel-dev-audits'
const cloudStore = new DynamoAuditStore(client, table, AWS_LEASE)
const db = DynamoDBDocumentClient.from(client)
const sqsRecord = (body: string, messageId = randomUUID()) => ({ body, messageId, eventSource: 'aws:sqs', eventSourceARN: queueArn })
test('authenticated API → versioned SQS message → shared Worker → persisted history; replay executes once', async () => {
  let message = ''
  const enqueue = createAuditEnqueuer({ send: async (command: { input: { MessageBody: string } }) => { message = command.input.MessageBody } } as unknown as SQSClient, 'test-queue-url')
  const api = createApp({ store: cloudStore, authorize: testCognitoAuthorizer(), enqueue, mode: 'audit', aiMode: 'mock', execution: 'sqs' })
  const response = await api.request('/api/audits', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Access-Token': signedTestToken() },
    body: JSON.stringify({ repositoryUrl: 'https://github.com/example/project' }) })
  assert.equal(response.status, 202)
  const { jobId } = await response.json()
  assert.deepEqual(JSON.parse(message), { version: 1, jobId, ownerSub: testSub })
  const runner = createAuditRunner(cloudStore, machineOptions())
  let runs = 0
  const handler = createSqsHandler({ store: cloudStore, queueArn, ownerSub: testSub, aiMode: 'mock', log: () => {},
    runAudit: async (id, owner) => { runs++; await runner(id, owner) } })
  assert.deepEqual(await handler({ Records: [sqsRecord(message), sqsRecord(message)] }), { batchItemFailures: [] })
  assert.equal(runs, 1)
  assert.equal((await cloudStore.get(testSub, jobId))?.status, 'COMPLETED')
  assert.equal((await cloudStore.list(testSub, 20)).items.some((item) => item.jobId === jobId), true)
})
test('dispatch compensation cannot overwrite a concurrently claimed RUNNING job', async () => {
  const audit: Audit = { ...pending(), mode: 'audit', aiMode: 'mock' }
  await cloudStore.create(testSub, audit)
  await cloudStore.claim(testSub, audit.jobId)
  assert.equal(await cloudStore.finish(testSub, { ...audit, status: 'FAILED', finishedAt: new Date().toISOString(), errorCode: 'DISPATCH_FAILED' }, 'PENDING'), false)
  assert.equal((await cloudStore.get(testSub, audit.jobId))?.status, 'RUNNING')
  await failAudit(cloudStore, testSub, audit.jobId, 'WORKER_FAILED')
})
test('AWS claim replaces the pending lease with a bounded execution lease; expired workers cannot write AI markers', async () => {
  const audit: Audit = { ...pending(), mode: 'audit', aiMode: 'mock' }
  await cloudStore.create(testSub, audit)
  assert.ok((await cloudStore.active())!.leaseUntil > Date.now() + 800_000)
  assert.ok(await cloudStore.claim(testSub, audit.jobId))
  assert.ok((await cloudStore.active())!.leaseUntil < Date.now() + 211_000)
  await db.send(new UpdateCommand({ TableName: table, Key: { PK: 'SYSTEM', SK: 'ACTIVE_AUDIT' }, UpdateExpression: 'SET leaseUntil = :zero', ExpressionAttributeValues: { ':zero': 0 } }))
  assert.equal(await cloudStore.beginAi(testSub, audit.jobId, 'test-model', new Date().toISOString()), false)
  assert.equal(await cloudStore.saveMachine(testSub, audit.jobId, machine), false)
  await cloudStore.expireStaleAudit(testSub)
  const failed = await cloudStore.get(testSub, audit.jobId)
  assert.equal(failed?.status === 'FAILED' && failed.errorCode, 'JOB_TIMEOUT')
  assert.equal(await cloudStore.claim(testSub, audit.jobId), undefined)
})
test('DynamoDB AI reservations are atomic and permanent across concurrent attempts', async () => {
  const audit: Audit = { ...pending(), mode: 'audit', aiMode: 'openai' }
  await cloudStore.create(testSub, audit); await cloudStore.claim(testSub, audit.jobId)
  await cloudStore.beginAi(testSub, audit.jobId, 'test-model', new Date().toISOString())
  const reserve = createDynamoAiBudget(client, table)
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserve(testSub, audit.jobId)))
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  const daily = await db.send(new GetCommand({ TableName: table, Key: { PK: 'AI_BUDGET', SK: `DAY#${new Date().toISOString().slice(0, 10)}` } }))
  const monthly = await db.send(new GetCommand({ TableName: table, Key: { PK: 'AI_BUDGET', SK: `MONTH#${new Date().toISOString().slice(0, 7)}` } }))
  assert.equal(daily.Item?.calls, 1); assert.equal(monthly.Item?.microUsd, 50_000)
  await assert.rejects(reserve(testSub, audit.jobId), (error) => error instanceof AuditError && error.code === 'AI_ALREADY_ATTEMPTED')
  await failAudit(cloudStore, testSub, audit.jobId, 'AI_OUTCOME_UNKNOWN')
  const receipt = await db.send(new GetCommand({ TableName: table, Key: { PK: `USER#${testSub}`, SK: `AI_RESERVATION#${audit.jobId}` } }))
  assert.equal(receipt.Item?.microUsd, 50_000)
})
test('SQS replay after an uncertain AI call never repeats the paid request', async () => {
  const ownerSub = randomUUID()
  const audit: Audit = { ...pending(), mode: 'audit', aiMode: 'openai' }
  await cloudStore.create(ownerSub, audit)
  let calls = 0
  const runAudit = createAuditRunner(cloudStore, { ...machineOptions(), openaiKey: 'test-key', hardLimitConfirmed: true,
    reserveBudget: createDynamoAiBudget(client, table), aiReport: async () => { calls++; throw new AuditError('AI_OUTCOME_UNKNOWN', 'unknown', 503) } })
  const handler = createSqsHandler({ store: cloudStore, queueArn, ownerSub: ownerSub, aiMode: 'openai', runAudit, log: () => {} })
  const event = { Records: [sqsRecord(JSON.stringify({ version: 1, jobId: audit.jobId, ownerSub: ownerSub }))] }
  assert.deepEqual(await handler(event), { batchItemFailures: [] })
  assert.deepEqual(await handler(event), { batchItemFailures: [] })
  assert.equal(calls, 1)
  assert.equal((await cloudStore.get(ownerSub, audit.jobId))?.status, 'FAILED')
})
test('API recovery marks an expired AI attempt unknown, releasing the slot without replay', async () => {
  const ownerSub = randomUUID()
  const audit: Audit = { ...pending(), mode: 'audit', aiMode: 'openai' }
  await cloudStore.create(ownerSub, audit); await cloudStore.claim(ownerSub, audit.jobId)
  await cloudStore.saveMachine(ownerSub, audit.jobId, machine)
  await cloudStore.beginAi(ownerSub, audit.jobId, 'test-model', new Date().toISOString())
  await db.send(new UpdateCommand({ TableName: table, Key: { PK: 'SYSTEM', SK: 'ACTIVE_AUDIT' }, UpdateExpression: 'SET leaseUntil = :zero', ExpressionAttributeValues: { ':zero': 0 } }))
  await cloudStore.expireStaleAudit(ownerSub)
  const failed = await cloudStore.get(ownerSub, audit.jobId)
  assert.equal(failed?.status === 'FAILED' && failed.errorCode, 'AI_OUTCOME_UNKNOWN')
  assert.ok(failed && 'machine' in failed && failed.machine)
  assert.equal(await cloudStore.active(), undefined)
})
test('AWS daily and monthly budget exhaustion prevents the AI request with no partial reservation', async () => {
  const ownerSub = randomUUID()
  const at = new Date().toISOString()
  const reserve = createDynamoAiBudget(client, table)
  for (const [daily, monthly] of [[5, 100_000], [0, 10_000_000]]) {
    await db.send(new UpdateCommand({ TableName: table, Key: { PK: 'AI_BUDGET', SK: `DAY#${at.slice(0, 10)}` }, UpdateExpression: 'SET calls = :v', ExpressionAttributeValues: { ':v': daily } }))
    await db.send(new UpdateCommand({ TableName: table, Key: { PK: 'AI_BUDGET', SK: `MONTH#${at.slice(0, 7)}` }, UpdateExpression: 'SET microUsd = :v', ExpressionAttributeValues: { ':v': monthly } }))
    const audit: Audit = { ...pending(), mode: 'audit', aiMode: 'openai' }
    await cloudStore.create(ownerSub, audit)
    let calls = 0
    await createAuditRunner(cloudStore, { ...machineOptions(), openaiKey: 'test-key', hardLimitConfirmed: true, reserveBudget: reserve,
      aiReport: async () => { calls++; return validateAiReport(aiOutput, machine) } })(audit.jobId, ownerSub)
    const failed = await cloudStore.get(ownerSub, audit.jobId)
    assert.equal(failed?.status === 'FAILED' && failed.errorCode, 'AI_BUDGET_LIMIT')
    assert.equal(calls, 0)
    const receipt = await db.send(new GetCommand({ TableName: table, Key: { PK: `USER#${ownerSub}`, SK: `AI_RESERVATION#${audit.jobId}` } }))
    assert.equal(receipt.Item, undefined)
  }
})
