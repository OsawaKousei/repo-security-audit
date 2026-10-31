import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { monotonicFactory } from 'ulid'
import { AuditError, auditSchema, type Audit } from '@repo-sentinel/core'
import { DynamoAuditStore, dynamoClient, ensureTable, localConfig } from '@repo-sentinel/aws'
import { createMockRunner, failAudit, startMockDispatcher } from '../workers/security-audit/app/src/audit.js'
import { mockResult } from '../workers/security-audit/app/src/mock.js'
import { createApp } from '../api/app/src/app.js'

const config = localConfig()
const table = `security-audit-test-${randomUUID()}-local`
const client = dynamoClient(config.endpoint)
const store = new DynamoAuditStore(client, table)
const id = monotonicFactory()
const pending = (): Audit => ({ jobId: id(), repository: 'example/project', status: 'PENDING', createdAt: new Date().toISOString(), attemptCount: 0, mode: 'mock' })
const app = (owner = 'test-user', enqueue?: (jobId: string, ownerSub: string) => Promise<void>) => createApp({ store, authorize: () => owner, enqueue })
const post = () => new Request('http://localhost/api/audits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryUrl: 'https://github.com/example/project' }) })
const instant = { wait: async () => {} }
before(async () => { await ensureTable(client, table) })
after(async () => { try { await client.send(new DeleteTableCommand({ TableName: table })) } finally { client.destroy() } })

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
