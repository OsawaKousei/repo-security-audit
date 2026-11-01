import { describe, expect, it, vi } from 'vitest'
import type { AuditStore } from '@repo-sentinel/core'
import { createSqsHandler, type SqsRecord } from '../../workers/security-audit/app/src/sqs-handler.js'

const ownerSub = '11111111-2222-4333-8444-555555555555'
const jobId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const queueArn = 'arn:aws:sqs:ap-northeast-1:103492189525:repo-sentinel-dev-audits'
const record = (overrides: Partial<SqsRecord> = {}): SqsRecord => ({ messageId: 'message-1', eventSource: 'aws:sqs',
  eventSourceARN: queueArn, body: JSON.stringify({ version: 1, jobId, ownerSub }), ...overrides })
function fixture(initial = 'PENDING') {
  let status = initial
  const get = vi.fn(async () => ({ status, mode: 'audit', aiMode: 'mock', errorCode: 'AI_TIMEOUT' }))
  const expireStaleAudit = vi.fn(async () => {})
  const store = { get, expireStaleAudit } as unknown as AuditStore & { expireStaleAudit(owner: string): Promise<void> }
  const runAudit = vi.fn(async () => { status = 'COMPLETED' })
  const log = vi.fn()
  return { runAudit, get, expireStaleAudit, log, handler: createSqsHandler({ store, ownerSub, queueArn, aiMode: 'mock', runAudit, log }) }
}
describe('SQS delivery and replay', () => {
  it('executes a durable pending job once and acknowledges terminal duplicates', async () => {
    const f = fixture()
    expect(await f.handler({ Records: [record(), record({ messageId: 'duplicate' })] })).toEqual({ batchItemFailures: [] })
    expect(f.runAudit).toHaveBeenCalledTimes(1)
    expect(f.runAudit).toHaveBeenCalledWith(jobId, ownerSub, undefined)
  })
  it.each(['COMPLETED', 'FAILED'])('does not run terminal %s jobs', async (status) => {
    const f = fixture(status)
    expect(await f.handler({ Records: [record()] })).toEqual({ batchItemFailures: [] })
    expect(f.runAudit).not.toHaveBeenCalled()
  })
  it('keeps a running duplicate queued without executing it again', async () => {
    const f = fixture('RUNNING')
    expect(await f.handler({ Records: [record()] })).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] })
    expect(f.runAudit).not.toHaveBeenCalled()
  })
  it.each([{ body: '{' }, { body: 'x'.repeat(513) }, { eventSourceARN: 'other-queue' }, { eventSource: 'aws:sns' },
    { body: JSON.stringify({ version: 1, jobId, ownerSub: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }) },
    { body: JSON.stringify({ version: 1, jobId, ownerSub, extra: 'ignore-me' }) }])('rejects poison messages without looking up or mutating jobs %j', async (overrides) => {
    const f = fixture()
    expect(await f.handler({ Records: [record(overrides)] })).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] })
    expect(f.get).not.toHaveBeenCalled()
    expect(f.runAudit).not.toHaveBeenCalled()
    expect(f.log).toHaveBeenCalledWith({ event: 'WorkerRecordFailed' })
  })
  it('reports only failed records and still handles other messages', async () => {
    const f = fixture()
    expect(await f.handler({ Records: [record({ body: '{' }), record({ messageId: 'good' })] }))
      .toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] })
    expect(f.runAudit).toHaveBeenCalledTimes(1)
  })
  it('does not acknowledge a missing job or storage failure', async () => {
    const f = fixture()
    f.get.mockResolvedValueOnce(undefined as never)
    expect((await f.handler({ Records: [record()] })).batchItemFailures).toHaveLength(1)
    f.expireStaleAudit.mockRejectedValueOnce(new Error('storage unavailable'))
    expect((await f.handler({ Records: [record()] })).batchItemFailures).toHaveLength(1)
    expect(f.runAudit).not.toHaveBeenCalled()
  })
})
