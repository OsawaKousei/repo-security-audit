import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AuditError, jobIdSchema } from '@repo-sentinel/core'
import { LIMITS } from './limits.js'

const ledgerSchema = z.object({ version: z.literal(1), reservations: z.array(z.object({
  ownerSub: z.string(), jobId: jobIdSchema, at: z.iso.datetime(), microUsd: z.literal(LIMITS.reservationMicroUsd),
}).strict()) }).strict()

// Durable conservative reservations are never refunded, even after a timeout or refusal.
// The ledger is outside in-memory DynamoDB, so restarting Compose cannot reset spend.
export async function reserveAiBudget(directory: string, ownerSub: string, jobId: string, now = new Date()) {
  let lock: Awaited<ReturnType<typeof open>> | undefined
  let temporary: string | undefined
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    lock = await open(join(directory, 'budget.lock'), 'wx', 0o600)
    const path = join(directory, 'budget.json')
    let ledger: z.infer<typeof ledgerSchema> = { version: 1, reservations: [] }
    try {
      if ((await stat(path)).size > 1024 * 1024) throw new Error('Oversized ledger')
      ledger = ledgerSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const at = now.toISOString()
    if (ledger.reservations.some((item) => item.ownerSub === ownerSub && item.jobId === jobId)) throw new AuditError('AI_ALREADY_ATTEMPTED', 'このジョブのAI呼び出しは既に予約されています。', 409)
    const month = ledger.reservations.filter((item) => item.at.slice(0, 7) === at.slice(0, 7))
    const today = ledger.reservations.filter((item) => item.at.slice(0, 10) === at.slice(0, 10))
    if (today.length >= LIMITS.dailyAiCalls || month.reduce((sum, item) => sum + item.microUsd, 0) + LIMITS.reservationMicroUsd > LIMITS.monthlyMicroUsd) throw new AuditError('AI_BUDGET_LIMIT', 'AIの永続日次・月次上限に達しました。', 429)
    ledger.reservations.push({ ownerSub, jobId, at, microUsd: LIMITS.reservationMicroUsd })
    temporary = join(directory, `budget-${randomUUID()}.tmp`)
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(ledger)); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
    const folder = await open(directory, 'r')
    try { await folder.sync() } finally { await folder.close() }
  } catch (error) {
    if (error instanceof AuditError) throw error
    throw new AuditError('AI_BUDGET_UNAVAILABLE', 'AI予算台帳を安全に更新できません。呼び出しを停止しました。', 503)
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {})
    if (lock) { await lock.close(); await rm(join(directory, 'budget.lock'), { force: true }) }
  }
}
