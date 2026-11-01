import { setTimeout as delay } from 'node:timers/promises'
import { AuditError, failureCodeSchema, type AuditStore, type FailureCode, type MachineResult } from '@repo-sentinel/core'
import { mockResult } from './mock.js'
import { fetchRepository } from './github.js'
import { runNpmAudit } from './npm-audit.js'
import { machineMockReport, prepareAiRequest, requestAiReport } from './ai-report.js'
import { reserveAiBudget } from './ai-budget.js'
import { AI_MODEL } from './limits.js'

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
    if ((await store.get(ownerSub, jobId))?.mode !== 'mock') return
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
      else if ((await store.get(active.ownerSub, active.jobId))?.mode === 'mock') await runAudit(active.jobId, active.ownerSub)
    } catch {
      console.error('Local mock dispatcher failed; it will check durable state again.')
    } finally { busy = false }
  }
  const timer = setInterval(() => { void tick() }, 1000)
  void tick()
  return () => { stopped = true; clearInterval(timer) }
}

type AuditRunnerOptions = {
  githubToken?: string; openaiKey?: string; getOpenaiKey?: () => Promise<string>; hardLimitConfirmed?: boolean; budgetDirectory?: string
  remainingTimeMs?: () => number
  fetchFiles?: typeof fetchRepository
  npmAudit?: typeof runNpmAudit
  aiReport?: typeof requestAiReport
  reserveBudget?: (ownerSub: string, jobId: string) => Promise<void>
}
export function createAuditRunner(store: AuditStore, options: AuditRunnerOptions) {
  return async function runAudit(jobId: string, ownerSub: string): Promise<void> {
    const current = await store.get(ownerSub, jobId)
    if (!current || current.mode !== 'audit' || current.status === 'COMPLETED' || current.status === 'FAILED') return
    const active = await store.active()
    if (!active || active.ownerSub !== ownerSub || active.jobId !== jobId) return
    const remaining = active.leaseUntil - Date.now() - 5000
    if (remaining <= 0) { await failAudit(store, ownerSub, jobId, 'JOB_TIMEOUT'); return }
    if (current.status !== 'PENDING') return
    const audit = await store.claim(ownerSub, jobId)
    if (!audit || audit.status !== 'RUNNING') return
    const signal = AbortSignal.timeout(Math.max(1, Math.min(170_000, remaining, (options.remainingTimeMs?.() ?? 180_000) - 10_000)))
    try {
      const files = await (options.fetchFiles ?? fetchRepository)(audit.repository, signal, { token: options.githubToken })
      const result = await (options.npmAudit ?? runNpmAudit)(files.packageJson, files.packageLock, signal)
      const machine: MachineResult = { commitSha: files.commitSha, ...result }
      signal.throwIfAborted()
      if (!await store.saveMachine(ownerSub, jobId, machine)) return
      let report
      let aiAttemptedAt: string | undefined
      if (audit.aiMode === 'openai') {
        if ((!options.openaiKey && !options.getOpenaiKey) || !options.hardLimitConfirmed) throw new AuditError('AI_NOT_CONFIGURED', 'API鍵と専用Projectの費用制限確認が必要です。', 503)
        const openaiKey = options.getOpenaiKey ? await options.getOpenaiKey() : options.openaiKey!
        const body = prepareAiRequest(audit.repository, new Date().toISOString(), machine)
        signal.throwIfAborted()
        aiAttemptedAt = new Date().toISOString()
        if (!await store.beginAi(ownerSub, jobId, AI_MODEL, aiAttemptedAt)) return
        if (options.reserveBudget) await options.reserveBudget(ownerSub, jobId)
        else if (options.budgetDirectory) await reserveAiBudget(options.budgetDirectory, ownerSub, jobId)
        else throw new AuditError('AI_BUDGET_UNAVAILABLE', 'AI予算台帳が設定されていません。', 503)
        signal.throwIfAborted()
        report = await (options.aiReport ?? requestAiReport)(body, machine, openaiKey, signal)
      } else report = machineMockReport(machine)
      signal.throwIfAborted()
      await store.finish(ownerSub, {
        ...audit, ...machine, status: 'COMPLETED', finishedAt: new Date().toISOString(), report,
        ...(aiAttemptedAt ? { aiAttemptedAt, aiModel: AI_MODEL } : {}),
      })
    } catch (error) {
      const knownCode = failureCodeSchema.safeParse(error instanceof AuditError ? error.code : '')
      const errorCode = signal.aborted ? 'JOB_TIMEOUT' : knownCode.success ? knownCode.data : 'WORKER_FAILED'
      await failAudit(store, ownerSub, jobId, errorCode)
    }
  }
}
