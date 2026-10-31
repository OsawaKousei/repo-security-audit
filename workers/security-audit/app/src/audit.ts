import { setTimeout as delay } from 'node:timers/promises'
import { AuditError, type AuditStore, type FailureCode } from '@repo-sentinel/core'
import { mockResult } from './mock.js'

export async function failAudit(store: AuditStore, ownerSub: string, jobId: string, errorCode: FailureCode) {
  const audit = await store.get(ownerSub, jobId)
  if (!audit || (audit.status !== 'PENDING' && audit.status !== 'RUNNING')) return
  await store.finish(ownerSub, { ...audit, status: 'FAILED', finishedAt: new Date().toISOString(), errorCode })
}

// Business logic takes no HTTP, SQS or Lambda event objects.
export function createMockRunner(store: AuditStore, options: { outcome?: 'success' | 'failure'; wait?: () => Promise<void> } = {}) {
  return async function runAudit(jobId: string, ownerSub: string): Promise<void> {
    const active = await store.active()
    if (!active || active.jobId !== jobId || active.ownerSub !== ownerSub) return
    if (active.leaseUntil <= Date.now()) {
      await failAudit(store, ownerSub, jobId, 'JOB_TIMEOUT')
      return
    }
    const audit = await store.claim(ownerSub, jobId)
    if (!audit || audit.status !== 'RUNNING') return
    try {
      await (options.wait ?? (() => delay(3500)))()
      if (options.outcome === 'failure') throw new AuditError('MOCK_FAILURE', 'Mock failure', 500)
      await store.finish(ownerSub, mockResult(audit))
    } catch (error) {
      const code = error instanceof AuditError && error.code === 'RESULT_TOO_LARGE' ? 'RESULT_TOO_LARGE'
        : error instanceof AuditError && error.code === 'MOCK_FAILURE' ? 'MOCK_FAILURE' : 'WORKER_FAILED'
      await failAudit(store, ownerSub, jobId, code)
    }
  }
}

// Durable local queue: recover PENDING jobs after API restart; never rerun RUNNING jobs.
export function startMockDispatcher(store: AuditStore, runAudit: (jobId: string, ownerSub: string) => Promise<void>) {
  let stopped = false
  let busy = false
  const tick = async () => {
    if (busy || stopped) return
    busy = true
    try {
      const active = await store.active()
      if (!active) return
      if (active.leaseUntil <= Date.now()) await failAudit(store, active.ownerSub, active.jobId, 'JOB_TIMEOUT')
      else await runAudit(active.jobId, active.ownerSub)
    } catch {
      console.error('Local mock dispatcher failed; it will check durable state again.')
    } finally { busy = false }
  }
  const timer = setInterval(() => { void tick() }, 1000)
  void tick()
  return () => { stopped = true; clearInterval(timer) }
}
